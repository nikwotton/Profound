import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, createServer as createNetServer, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expectArray, expectBufferChunk, expectRecord, expectString, isUnknownRecord, parseJson } from "./decoding.js";
import { startLocalRuntime, type RunningLocalApplication } from "./local-runtime.js";
import { silentLogger, type Logger } from "./logger.js";
import { basicAuth, closeServer, listen } from "./net-utils.js";
import { StatusApplicationServer } from "./status-app.js";
import { decodeUsageRollup } from "./storage-decoding.js";
import type { RouteStore } from "./store.js";
import type { UsageRecord, UsageRollup } from "./domain/usage.js";
import { provisionedProxySlotCapacityRecord, UsageAccountingWorker } from "./usage-accounting.js";

const DEMO_QUERY_SECRET = "demo-query-secret";
const DEMO_AUTHORIZATION_SECRET = "Bearer demo-target-secret";
const DEMO_COOKIE_SECRET = "session=demo-cookie-secret";

interface IssuedGrant {
  grant: { grantId: string; profileId: string };
  credential: { credentialId: string; username: string; password: string };
  endpoints: { http: string; socks5: string };
}

interface ProxyResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface ConnectExchange {
  status: number;
  responseHead: string;
  sentPayload: string;
  receivedPayload: string;
}

interface Socks5Exchange {
  methodRequestHex: string;
  methodResponseHex: string;
  authUsername: string;
  authResponseHex: string;
  connectRequestHex: string;
  connectResponseHex: string;
  sentPayload: string;
  receivedPayload: string;
}

export interface DemoOptions {
  forwardPort?: number;
  socks5Port?: number;
  controlPort?: number;
  statusPort?: number;
  logger?: Logger;
  write?: (line: string) => void;
  pauseBeforeStep?: (step: DemoStep) => Promise<void>;
}

export interface DemoStep {
  number: number;
  total: number;
  title: string;
}

export interface RunningDemo {
  application: RunningLocalApplication;
  targetUrl: string;
  analyticsUrl: string;
  stop(): Promise<void>;
}

function lineWriter(write: (line: string) => void): (line?: string) => void {
  return (line = "") => write(`${line}\n`);
}

type WriteLine = ReturnType<typeof lineWriter>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Demo assertion failed: ${message}`);
}

function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? "missing";
  return value ?? "missing";
}

function redact(value: unknown, key = ""): unknown {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    normalizedKey.endsWith("password") ||
    normalizedKey.endsWith("username") ||
    normalizedKey.endsWith("token") ||
    normalizedKey.endsWith("authorization") ||
    normalizedKey.endsWith("cookie")
  ) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (isUnknownRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

function sanitizedUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  if (url.search !== "") url.search = "?[REDACTED]";
  url.hash = "";
  return url.toString();
}

function writeJson(writeLine: WriteLine, label: string, value: unknown): void {
  writeLine(`        ${label}: ${JSON.stringify(redact(value))}`);
}

function writeControlRequest(writeLine: WriteLine, method: string, path: string, body?: unknown): void {
  writeLine(`      → ${method} ${path}`);
  writeJson(writeLine, "request headers", {
    authorization: "Bearer [REDACTED]",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  });
  if (body !== undefined) writeJson(writeLine, "request body", body);
}

function writeControlResponse(writeLine: WriteLine, status: number, body?: unknown): void {
  writeLine(`      ← HTTP ${status}`);
  if (body !== undefined) writeJson(writeLine, "response body", body);
}

function visibleResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const visible: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      (name === "content-type" || name === "content-length" || name.startsWith("x-mock-") || name.startsWith("x-demo-"))
    ) {
      visible[name] = value;
    }
  }
  return visible;
}

function writeProxyExchange(writeLine: WriteLine, grant: IssuedGrant, targetUrl: string, response: ProxyResponse): void {
  writeLine(`      → GET ${sanitizedUrl(targetUrl)}`);
  writeJson(writeLine, "proxy", {
    endpoint: grant.endpoints.http,
    username: "[REDACTED]",
    password: "[REDACTED]",
  });
  writeJson(writeLine, "request headers", {
    "proxy-authorization": "Basic [REDACTED]",
    authorization: "Bearer [REDACTED]",
    cookie: "[REDACTED]",
    "x-demo-request": "proxy-router-review",
  });
  writeLine(`      ← HTTP ${response.status}`);
  writeJson(writeLine, "response headers", visibleResponseHeaders(response.headers));
  writeLine(`        response body: ${response.body}`);
}

function writeTunnelPayload(writeLine: WriteLine, label: string, payload: string): void {
  writeJson(writeLine, label, {
    content: "[REDACTED]",
    bytes: Buffer.byteLength(payload),
  });
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Control API returned ${response.status}: ${await response.text()}`);
  return parseJson(await response.text(), "control API response");
}

function decodeIssuedGrant(value: unknown): IssuedGrant {
  const root = expectRecord(value, "issued grant");
  const grant = expectRecord(root["grant"], "issued grant.grant");
  const credential = expectRecord(root["credential"], "issued grant.credential");
  const endpoints = expectRecord(root["endpoints"], "issued grant.endpoints");
  return {
    grant: {
      grantId: expectString(grant["grantId"], "issued grant.grant.grantId"),
      profileId: expectString(grant["profileId"], "issued grant.grant.profileId"),
    },
    credential: {
      credentialId: expectString(credential["credentialId"], "issued grant.credential.credentialId"),
      username: expectString(credential["username"], "issued grant.credential.username"),
      password: expectString(credential["password"], "issued grant.credential.password"),
    },
    endpoints: {
      http: expectString(endpoints["http"], "issued grant.endpoints.http"),
      socks5: expectString(endpoints["socks5"], "issued grant.endpoints.socks5"),
    },
  };
}

async function controlRequest(application: RunningLocalApplication, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${application.controlToken}`);
  return fetch(`http://${application.controlAddress.host}:${application.controlAddress.port}${path}`, { ...init, headers });
}

async function issueGrant(
  application: RunningLocalApplication,
  profile: Record<string, unknown>,
  sessionMode: "managed" | "none",
  jobId: string,
  writeLine: WriteLine,
): Promise<IssuedGrant> {
  writeControlRequest(writeLine, "POST", "/v1/profiles", profile);
  const created = await controlRequest(application, "/v1/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profile),
  });
  assert(created.status === 201, `profile creation returned ${created.status}`);
  const createdBody = expectRecord(await responseJson(created), "created profile");
  writeControlResponse(writeLine, created.status, createdBody);
  const profileId = expectString(createdBody["profileId"], "created profile.profileId");
  const grantPath = `/v1/profiles/${profileId}/grants`;
  const grantInput = { sessionMode, jobId };
  writeControlRequest(writeLine, "POST", grantPath, grantInput);
  const issued = await controlRequest(application, grantPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(grantInput),
  });
  assert(issued.status === 201, `grant issuance returned ${issued.status}`);
  const issuedBody = await responseJson(issued);
  writeControlResponse(writeLine, issued.status, issuedBody);
  return decodeIssuedGrant(issuedBody);
}

async function waitForUsage(
  store: RouteStore,
  from: string,
  to: string,
  predicate: (records: readonly UsageRecord[]) => boolean,
): Promise<UsageRecord[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const records = await store.listUsageRecords(from, to);
    if (predicate(records)) return records;
    await delay(10);
  }
  throw new Error("Demo usage records did not become visible before the deadline");
}

function safeUsageEvent(record: UsageRecord): Record<string, unknown> {
  return {
    kind: record.kind,
    upstreamAttemptId: record.id,
    logicalOperationId: record.logicalOperationId,
    customerId: record.customerId,
    jobId: record.jobId ?? "Unallocated",
    userId: record.userId,
    routeId: record.routeId,
    provider: record.provider,
    endpointId: record.endpointId,
    proxySlotId: record.proxySlotId,
    protocol: record.protocol,
    outcome: record.outcome,
    retryIndex: record.retryIndex,
    failover: record.failover,
    bytesSent: record.bytesSent,
    bytesReceived: record.bytesReceived,
    latencyMs: record.latencyMs,
    destinationDomain: record.destinationDomain,
    destinationHost: record.destinationHost,
    destinationPort: record.destinationPort,
    destinationPathTemplate: record.destinationPathTemplate,
    pricingModel: record.pricingModel,
    pricingVersion: record.pricingVersion,
    priceUsd: record.priceUsd,
  };
}

async function analyticsRequest(analyticsUrl: string, path: string, writeLine: WriteLine): Promise<UsageRollup[]> {
  writeLine(`      → GET ${path}`);
  const response = await fetch(`${analyticsUrl}${path}`);
  assert(response.status === 200, `analytics query returned ${response.status}`);
  const body = expectRecord(parseJson(await response.text(), "analytics response"), "analytics response");
  writeLine(`      ← HTTP ${response.status}`);
  writeJson(writeLine, "response body", body);
  return expectArray(body["data"], "analytics response.data").map((item) => decodeUsageRollup(item));
}

async function requestViaHttpProxy(grant: IssuedGrant, targetUrl: string): Promise<ProxyResponse> {
  const proxy = new URL(grant.endpoints.http);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "GET",
        path: targetUrl,
        headers: {
          "proxy-authorization": basicAuth(grant.credential.username, grant.credential.password),
          authorization: DEMO_AUTHORIZATION_SECRET,
          cookie: DEMO_COOKIE_SECRET,
          "x-demo-request": "proxy-router-review",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(expectBufferChunk(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function readExactly(socket: Socket, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = length;
  while (remaining > 0) {
    const value: unknown = socket.read(remaining);
    if (value !== null) {
      const chunk = expectBufferChunk(value, "demo tunnel chunk");
      chunks.push(chunk);
      remaining -= chunk.length;
      continue;
    }
    if (socket.readableEnded || socket.destroyed) throw new Error("Demo tunnel closed before its response arrived");
    await once(socket, "readable");
  }
  return Buffer.concat(chunks, length);
}

async function exchangeViaConnect(grant: IssuedGrant, authority: string, payload: string): Promise<ConnectExchange> {
  const proxy = new URL(grant.endpoints.http);
  const socket = connect(Number(proxy.port), proxy.hostname);
  try {
    await once(socket, "connect");
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${basicAuth(
        grant.credential.username,
        grant.credential.password,
      )}\r\n\r\n`,
    );
    let headers = Buffer.alloc(0);
    while (headers.indexOf("\r\n\r\n") < 0) headers = Buffer.concat([headers, await readExactly(socket, 1)]);
    const responseHead = headers.toString("latin1").trimEnd();
    const status = Number(responseHead.split(" ")[1] ?? 0);
    assert(status === 200, `HTTPS CONNECT returned ${status}`);
    socket.write(payload);
    return {
      status,
      responseHead,
      sentPayload: payload,
      receivedPayload: (await readExactly(socket, Buffer.byteLength(payload))).toString("utf8"),
    };
  } finally {
    socket.destroy();
  }
}

async function exchangeViaSocks5(grant: IssuedGrant, host: string, port: number, payload: string): Promise<Socks5Exchange> {
  const proxy = new URL(grant.endpoints.socks5);
  const socket = connect(Number(proxy.port), proxy.hostname);
  try {
    await once(socket, "connect");
    const methodRequest = Buffer.from([0x05, 0x01, 0x02]);
    socket.write(methodRequest);
    const methodResponse = await readExactly(socket, 2);
    assert(methodResponse.equals(Buffer.from([0x05, 0x02])), "SOCKS5 did not request username/password auth");
    const username = Buffer.from(grant.credential.username);
    const password = Buffer.from(grant.credential.password);
    socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
    const authResponse = await readExactly(socket, 2);
    assert(authResponse.equals(Buffer.from([0x01, 0x00])), "SOCKS5 authentication failed");
    const address = Buffer.from(host);
    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(port);
    const connectRequest = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, address.length]), address, portBytes]);
    socket.write(connectRequest);
    const reply = await readExactly(socket, 10);
    assert(reply[1] === 0x00, `SOCKS5 CONNECT returned reply ${reply[1] ?? "missing"}`);
    socket.write(payload);
    return {
      methodRequestHex: methodRequest.toString("hex"),
      methodResponseHex: methodResponse.toString("hex"),
      authUsername: grant.credential.username,
      authResponseHex: authResponse.toString("hex"),
      connectRequestHex: connectRequest.toString("hex"),
      connectResponseHex: reply.toString("hex"),
      sentPayload: payload,
      receivedPayload: (await readExactly(socket, Buffer.byteLength(payload))).toString("utf8"),
    };
  } finally {
    socket.destroy();
  }
}

async function startHttpTarget(): Promise<{ server: Server; url: string; port: number }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://recipient.invalid");
    response.writeHead(200, { "content-type": "application/json", "x-demo-target": "local-recipient" });
    response.end(
      JSON.stringify({
        method: request.method,
        path: url.pathname,
        demoHeader: request.headers["x-demo-request"],
        authorizationReceived: request.headers.authorization !== undefined,
        cookieReceived: request.headers.cookie !== undefined,
      }),
    );
  });
  const address = await listen(server, "127.0.0.1", 0);
  return { server, url: `http://127.0.0.1:${address.port}/audit?access_token=${DEMO_QUERY_SECRET}`, port: address.port };
}

async function startEchoTarget(): Promise<{ server: Server; port: number }> {
  const server = createNetServer((socket) => socket.pipe(socket));
  const address = await listen(server, "127.0.0.1", 0);
  return { server, port: address.port };
}

export async function startDemo(options: DemoOptions = {}): Promise<RunningDemo> {
  const writeLine = lineWriter(options.write ?? ((line) => process.stdout.write(line)));
  const httpTarget = await startHttpTarget();
  const echoTarget = await startEchoTarget();
  let application: RunningLocalApplication | undefined;
  let statusApplication: StatusApplicationServer | undefined;
  let analyticsUrl: string | undefined;
  const step = async (number: number, title: string): Promise<void> => {
    await options.pauseBeforeStep?.({ number, total: 6, title });
    writeLine(`[${number}/6] ${title}`);
  };

  const stop = async (): Promise<void> => {
    await Promise.allSettled([
      ...(application === undefined ? [] : [application.stop()]),
      ...(statusApplication === undefined ? [] : [statusApplication.stop()]),
      closeServer(httpTarget.server),
      closeServer(echoTarget.server),
    ]);
  };

  try {
    application = await startLocalRuntime({
      ...(options.forwardPort === undefined ? {} : { forwardPort: options.forwardPort }),
      ...(options.socks5Port === undefined ? {} : { socks5Port: options.socks5Port }),
      ...(options.controlPort === undefined ? {} : { controlPort: options.controlPort }),
      allowedTargetPorts: [80, 443, httpTarget.port, echoTarget.port],
      logger: options.logger ?? silentLogger,
    });
    statusApplication = new StatusApplicationServer(
      application.store,
      {
        host: "127.0.0.1",
        port: options.statusPort ?? 8083,
        staleAfterMs: 300_000,
        historyLimit: 10,
      },
      options.logger ?? silentLogger,
    );
    const statusAddress = await statusApplication.start();
    analyticsUrl = `http://${statusAddress.host}:${statusAddress.port}`;

    writeLine("Profound local demo");
    writeLine("===================");
    writeLine(`Control API:      http://${application.controlAddress.host}:${application.controlAddress.port}`);
    writeLine(`Swagger UI:       http://${application.controlAddress.host}:${application.controlAddress.port}/docs`);
    writeLine(`HTTP/HTTPS proxy: http://${application.forwardAddress.host}:${application.forwardAddress.port}`);
    writeLine(`SOCKS5 proxy:     socks5h://${application.socks5Address.host}:${application.socks5Address.port}`);
    writeLine(`Analytics:        ${analyticsUrl}`);
    writeLine(`Local recipient:  ${sanitizedUrl(httpTarget.url)}`);
    writeLine();

    await step(1, "Control-plane readiness");
    writeControlRequest(writeLine, "GET", "/health/ready");
    const ready = await controlRequest(application, "/health/ready");
    assert(ready.status === 200, `readiness returned ${ready.status}`);
    const readyBody = await responseJson(ready);
    writeControlResponse(writeLine, ready.status, readyBody);
    writeLine("      ✓ both simulated providers are healthy");

    await step(2, "Public-data profile → Bright Data residential routing");
    const residential = await issueGrant(
      application,
      {
        customerId: "demo-public-data",
        geography: { countryCode: "US" },
        allowConnectionRetry: true,
      },
      "none",
      "job-public-catalog",
      writeLine,
    );
    const residentialFirst = await requestViaHttpProxy(residential, httpTarget.url);
    writeProxyExchange(writeLine, residential, httpTarget.url, residentialFirst);
    const residentialSecond = await requestViaHttpProxy(residential, httpTarget.url);
    writeProxyExchange(writeLine, residential, httpTarget.url, residentialSecond);
    const firstIp = header(residentialFirst.headers, "x-mock-exit-ip");
    const secondIp = header(residentialSecond.headers, "x-mock-exit-ip");
    assert(residentialFirst.status === 200 && residentialSecond.status === 200, "residential requests did not reach the recipient");
    assert(firstIp !== secondIp, "per-request residential exits did not rotate");
    writeLine(`      ✓ recipient saw transparent HTTP requests via fresh exits ${firstIp} → ${secondIp}`);

    await step(3, "Managed-session profile → stable Proxidize mobile device");
    const mobile = await issueGrant(
      application,
      {
        customerId: "demo-authenticated-session",
        geography: { countryCode: "US", regionCode: "NY", city: "New York" },
        carrier: "T-Mobile",
        allowConnectionRetry: true,
      },
      "managed",
      "job-authenticated-collection",
      writeLine,
    );
    const mobileFirst = await requestViaHttpProxy(mobile, httpTarget.url);
    writeProxyExchange(writeLine, mobile, httpTarget.url, mobileFirst);
    const mobileSecond = await requestViaHttpProxy(mobile, httpTarget.url);
    writeProxyExchange(writeLine, mobile, httpTarget.url, mobileSecond);
    const device = header(mobileFirst.headers, "x-mock-endpoint-id");
    const mobileIp = header(mobileFirst.headers, "x-mock-exit-ip");
    assert(mobileFirst.status === 200 && mobileSecond.status === 200, "mobile requests did not reach the recipient");
    assert(device === header(mobileSecond.headers, "x-mock-endpoint-id"), "mobile device affinity changed");
    assert(mobileIp === header(mobileSecond.headers, "x-mock-exit-ip"), "mobile IP changed without rotation");
    writeLine(`      ✓ both requests used ${device} (${mobileIp}, New York, T-Mobile)`);

    await step(4, "HTTPS CONNECT retry/failover and SOCKS5 tunnelling");
    const connectPayload = "connect-demo";
    const socksPayload = "socks5-demo";
    const authority = `127.0.0.1:${echoTarget.port}`;
    writeLine(`      → CONNECT ${authority} HTTP/1.1 via ${residential.endpoints.http}`);
    writeJson(writeLine, "request headers", {
      host: authority,
      "proxy-authorization": "Basic [REDACTED]",
    });
    writeTunnelPayload(writeLine, "tunnel payload sent", connectPayload);
    application.simulators?.brightData.setFailure("unavailable");
    const connectExchange = await exchangeViaConnect(residential, authority, connectPayload).finally(() =>
      application?.simulators?.brightData.setFailure(null),
    );
    writeLine(`      ← ${connectExchange.responseHead.replaceAll("\r\n", "\n        ")}`);
    writeTunnelPayload(writeLine, "tunnel payload received", connectExchange.receivedPayload);
    assert(connectExchange.receivedPayload === connectPayload, "CONNECT tunnel changed payload bytes");

    writeLine(`      → SOCKS5 CONNECT 127.0.0.1:${echoTarget.port} via ${mobile.endpoints.socks5}`);
    const socksExchange = await exchangeViaSocks5(mobile, "127.0.0.1", echoTarget.port, socksPayload);
    writeJson(writeLine, "method negotiation", {
      requestHex: socksExchange.methodRequestHex,
      responseHex: socksExchange.methodResponseHex,
    });
    writeJson(writeLine, "username/password authentication", {
      username: "[REDACTED]",
      password: "[REDACTED]",
      responseHex: socksExchange.authResponseHex,
    });
    writeJson(writeLine, "CONNECT command", {
      requestHex: socksExchange.connectRequestHex,
      responseHex: socksExchange.connectResponseHex,
    });
    writeTunnelPayload(writeLine, "tunnel payload sent", socksExchange.sentPayload);
    writeTunnelPayload(writeLine, "tunnel payload received", socksExchange.receivedPayload);
    assert(socksExchange.receivedPayload === socksPayload, "SOCKS5 tunnel changed payload bytes");
    writeLine("      ✓ CONNECT failed over before commitment; both tunnel protocols preserved application bytes");

    await step(5, "Usage events → accounting aggregation → analytics queries");
    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setUTCHours(0, 0, 0, 0);
    const toDate = new Date(fromDate);
    toDate.setUTCDate(toDate.getUTCDate() + 1);
    const from = fromDate.toISOString();
    const to = toDate.toISOString();
    const attempts = await waitForUsage(
      application.store,
      from,
      to,
      (records) =>
        records.some((record) => record.kind === "attempt" && record.outcome === "retry") &&
        records.some((record) => record.kind === "attempt" && record.outcome === "success" && record.failover) &&
        records.some((record) => record.kind === "attempt" && record.protocol === "socks5" && record.outcome === "success"),
    );
    const attemptRecords = attempts.filter((record) => record.kind === "attempt");
    const operationCount = new Set(attemptRecords.map((record) => record.logicalOperationId)).size;
    writeJson(writeLine, "recorded usage events", attemptRecords.map(safeUsageEvent));
    writeLine(`      ✓ ${operationCount} proxy operations produced ${attemptRecords.length} immutable upstream-attempt events`);

    const proxidizePricing = application.routes.descriptors().find((descriptor) => descriptor.id === "proxidize")?.pricing;
    assert(proxidizePricing?.model === "per_device_month", "Proxidize pricing metadata was unavailable");
    const capacityStartedAt = new Date(now);
    capacityStartedAt.setUTCMinutes(0, 0, 0);
    const capacityEndsAt = new Date(capacityStartedAt);
    capacityEndsAt.setUTCHours(capacityEndsAt.getUTCHours() + 1);
    const proxySlotIds = [...new Set(attemptRecords.flatMap((record) => (record.proxySlotId === undefined ? [] : [record.proxySlotId])))];
    assert(proxySlotIds.length > 0, "No mobile proxy-slot usage was recorded");
    for (const proxySlotId of proxySlotIds) {
      await application.store.recordUsage(
        provisionedProxySlotCapacityRecord({
          id: `demo:${proxySlotId}:${capacityStartedAt.toISOString()}`,
          proxySlotId,
          periodStartedAt: capacityStartedAt.toISOString(),
          periodEndsAt: capacityEndsAt.toISOString(),
          priceUsd: proxidizePricing.amountUsd,
          pricingVersion: proxidizePricing.version,
          country: "US",
          city: "New York",
        }),
      );
    }
    writeJson(writeLine, "mobile capacity billing inputs", {
      pricingModel: proxidizePricing.model,
      priceUsdPerDeviceMonth: proxidizePricing.amountUsd,
      pricingVersion: proxidizePricing.version,
      proxySlotIds,
      periodStartedAt: capacityStartedAt.toISOString(),
      periodEndsAt: capacityEndsAt.toISOString(),
    });

    const records = await application.store.listUsageRecords(from, to);
    const serializedRecords = JSON.stringify(records);
    for (const secret of [
      DEMO_QUERY_SECRET,
      DEMO_AUTHORIZATION_SECRET,
      DEMO_COOKIE_SECRET,
      residential.credential.password,
      mobile.credential.password,
    ]) {
      assert(!serializedRecords.includes(secret), "sensitive request or credential data entered the usage ledger");
    }
    const persistedRollups = await new UsageAccountingWorker(application.store).run(from, to);
    writeLine(`      ✓ accounting worker persisted ${persistedRollups} hourly/daily and per-customer rollups`);

    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&interval=day`;
    const overallRollups = await analyticsRequest(analyticsUrl, `/v1/usage?${query}`, writeLine);
    const providerRollups = await analyticsRequest(analyticsUrl, `/v1/usage?${query}&groupBy=provider`, writeLine);
    const customerRollups = await analyticsRequest(analyticsUrl, `/v1/usage?${query}&groupBy=customer`, writeLine);
    const jobRollups = await analyticsRequest(analyticsUrl, `/v1/usage?${query}&groupBy=job`, writeLine);
    const outcomeRollups = await analyticsRequest(analyticsUrl, `/v1/usage?${query}&groupBy=outcome`, writeLine);
    const overall = overallRollups[0];
    const residentialCost = providerRollups.find((rollup) => rollup.group.provider === "bright_data");
    const mobileCost = providerRollups.find((rollup) => rollup.group.provider === "proxidize");
    assert(overall !== undefined && overall.bytesSent + overall.bytesReceived > 0, "analytics omitted transferred bytes");
    assert(overall.retryCount > 0 && overall.failoverCount > 0, "analytics omitted retry/failover outcomes");
    assert(residentialCost !== undefined && residentialCost.estimatedCostUsd > 0, "residential per-GiB cost was not calculated");
    assert(mobileCost !== undefined && mobileCost.estimatedCostUsd > 0, "mobile device cost was not calculated");
    assert(
      customerRollups.some((rollup) => rollup.group.customer === "demo-public-data") &&
        customerRollups.some((rollup) => rollup.group.customer === "demo-authenticated-session"),
      "customer attribution was not queryable",
    );
    assert(
      jobRollups.some((rollup) => rollup.group.job === "job-public-catalog") &&
        jobRollups.some((rollup) => rollup.group.job === "job-authenticated-collection"),
      "job attribution was not queryable",
    );
    assert(
      outcomeRollups.some((rollup) => rollup.group.outcome === "success") &&
        outcomeRollups.some((rollup) => rollup.group.outcome === "retry"),
      "attempt outcomes were not queryable",
    );
    writeJson(writeLine, "cost calculation proof", {
      brightData: {
        pricingModel: "per_gib",
        billableBytes: residentialCost.bytesSent + residentialCost.bytesReceived,
        estimatedCostUsd: residentialCost.estimatedCostUsd,
        pricingVersions: residentialCost.pricingVersions,
      },
      proxidize: {
        pricingModel: "per_device_month",
        provisionedSlotMs: mobileCost.provisionedSlotMs,
        activeConnectionMs: mobileCost.activeConnectionMs,
        estimatedCostUsd: mobileCost.estimatedCostUsd,
        pricingVersions: mobileCost.pricingVersions,
      },
    });
    writeLine(
      `      ✓ bytes, average/p95 latency (${overall.averageLatencyMs.toFixed(2)}/${overall.p95LatencyMs.toFixed(2)} ms), ` +
        `retry (${overall.retryCount}), failover (${overall.failoverCount}), outcomes, attribution, and both cost models are queryable`,
    );
    writeLine("      ✓ headers, bodies, URL queries, cookies, authorization, and proxy credentials are absent or visibly [REDACTED]");

    await step(6, "One-time credential rotation and revocation");
    const rotatePath = `/v1/grants/${mobile.grant.grantId}/credentials/${mobile.credential.credentialId}/rotate`;
    writeControlRequest(writeLine, "POST", rotatePath);
    const rotatedResponse = await controlRequest(application, rotatePath, { method: "POST" });
    const rotatedBody = await responseJson(rotatedResponse);
    writeControlResponse(writeLine, rotatedResponse.status, rotatedBody);
    const rotated = decodeIssuedGrant(rotatedBody);
    const rotatedProxyResponse = await requestViaHttpProxy(rotated, httpTarget.url);
    writeProxyExchange(writeLine, rotated, httpTarget.url, rotatedProxyResponse);
    assert(rotatedProxyResponse.status === 200, "rotated credential was not accepted");
    const revokePath = `/v1/grants/${mobile.grant.grantId}/credentials/${mobile.credential.credentialId}`;
    writeControlRequest(writeLine, "DELETE", revokePath);
    const revoked = await controlRequest(application, revokePath, { method: "DELETE" });
    assert(revoked.status === 204, `credential revocation returned ${revoked.status}`);
    writeControlResponse(writeLine, revoked.status);
    const rejectedProxyResponse = await requestViaHttpProxy(mobile, httpTarget.url);
    writeProxyExchange(writeLine, mobile, httpTarget.url, rejectedProxyResponse);
    assert(rejectedProxyResponse.status === 407, "revoked credential was still accepted");
    writeLine("      ✓ replacement works; revoked credential now receives HTTP 407");
    writeLine();
    writeLine("Demo complete. The servers and in-memory routes remain available for inspection.");
    writeLine(`Inspect analytics at ${analyticsUrl}, or use Swagger UI with the documented local demo bearer token.`);
    writeLine("Press Ctrl-C to stop and discard all ephemeral data.");

    return { application, targetUrl: httpTarget.url, analyticsUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
