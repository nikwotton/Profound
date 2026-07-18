import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, createServer as createNetServer, type Server, type Socket } from "node:net";
import { expectBufferChunk, expectRecord, expectString, isUnknownRecord, parseJson } from "./decoding.js";
import { startLocalRuntime, type RunningLocalApplication } from "./local-runtime.js";
import { silentLogger, type Logger } from "./logger.js";
import { basicAuth, closeServer, listen } from "./net-utils.js";

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
  authPasswordBytes: number;
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
  writeLine(`      → GET ${targetUrl}`);
  writeJson(writeLine, "proxy", {
    endpoint: grant.endpoints.http,
    username: grant.credential.username,
    password: grant.credential.password,
  });
  writeJson(writeLine, "request headers", {
    "proxy-authorization": "Basic [REDACTED]",
    "x-demo-request": "proxy-router-review",
  });
  writeLine(`      ← HTTP ${response.status}`);
  writeJson(writeLine, "response headers", visibleResponseHeaders(response.headers));
  writeLine(`        response body: ${response.body}`);
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
  const grantInput = { sessionMode };
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
      authPasswordBytes: password.length,
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
    response.writeHead(200, { "content-type": "application/json", "x-demo-target": "local-recipient" });
    response.end(
      JSON.stringify({
        method: request.method,
        path: request.url,
        demoHeader: request.headers["x-demo-request"],
      }),
    );
  });
  const address = await listen(server, "127.0.0.1", 0);
  return { server, url: `http://127.0.0.1:${address.port}/audit?flow=demo`, port: address.port };
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
  const step = async (number: number, title: string): Promise<void> => {
    await options.pauseBeforeStep?.({ number, total: 5, title });
    writeLine(`[${number}/5] ${title}`);
  };

  const stop = async (): Promise<void> => {
    await Promise.allSettled([
      ...(application === undefined ? [] : [application.stop()]),
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

    writeLine("Profound local demo");
    writeLine("===================");
    writeLine(`Control API:      http://${application.controlAddress.host}:${application.controlAddress.port}`);
    writeLine(`Swagger UI:       http://${application.controlAddress.host}:${application.controlAddress.port}/docs`);
    writeLine(`HTTP/HTTPS proxy: http://${application.forwardAddress.host}:${application.forwardAddress.port}`);
    writeLine(`SOCKS5 proxy:     socks5h://${application.socks5Address.host}:${application.socks5Address.port}`);
    writeLine(`Local recipient:  ${httpTarget.url}`);
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
        allowConnectionRetry: false,
      },
      "managed",
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

    await step(4, "Native HTTPS CONNECT and SOCKS5 tunnelling");
    const connectPayload = "connect-demo";
    const socksPayload = "socks5-demo";
    const authority = `127.0.0.1:${echoTarget.port}`;
    writeLine(`      → CONNECT ${authority} HTTP/1.1 via ${mobile.endpoints.http}`);
    writeJson(writeLine, "request headers", {
      host: authority,
      "proxy-authorization": "Basic [REDACTED]",
    });
    writeLine(`        tunnel payload sent: ${JSON.stringify(connectPayload)}`);
    const connectExchange = await exchangeViaConnect(mobile, authority, connectPayload);
    writeLine(`      ← ${connectExchange.responseHead.replaceAll("\r\n", "\n        ")}`);
    writeLine(`        tunnel payload received: ${JSON.stringify(connectExchange.receivedPayload)}`);
    assert(connectExchange.receivedPayload === connectPayload, "CONNECT tunnel changed payload bytes");

    writeLine(`      → SOCKS5 CONNECT 127.0.0.1:${echoTarget.port} via ${mobile.endpoints.socks5}`);
    const socksExchange = await exchangeViaSocks5(mobile, "127.0.0.1", echoTarget.port, socksPayload);
    writeJson(writeLine, "method negotiation", {
      requestHex: socksExchange.methodRequestHex,
      responseHex: socksExchange.methodResponseHex,
    });
    writeJson(writeLine, "username/password authentication", {
      username: socksExchange.authUsername,
      password: "[REDACTED]",
      passwordBytes: socksExchange.authPasswordBytes,
      responseHex: socksExchange.authResponseHex,
    });
    writeJson(writeLine, "CONNECT command", {
      requestHex: socksExchange.connectRequestHex,
      responseHex: socksExchange.connectResponseHex,
    });
    writeLine(`        tunnel payload sent: ${JSON.stringify(socksExchange.sentPayload)}`);
    writeLine(`        tunnel payload received: ${JSON.stringify(socksExchange.receivedPayload)}`);
    assert(socksExchange.receivedPayload === socksPayload, "SOCKS5 tunnel changed payload bytes");
    writeLine("      ✓ both tunnel protocols echoed application bytes unchanged");

    await step(5, "One-time credential rotation and revocation");
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
    writeLine("Use Swagger UI with bearer token 'change-me', or press Ctrl-C to stop and discard all data.");

    return { application, targetUrl: httpTarget.url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
