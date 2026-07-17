import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { basicAuth } from "../src/net-utils.js";
import { SqliteRouteStore } from "../src/store.js";
import {
  controlRequest,
  createRoute,
  exchangeViaHttpConnect,
  exchangeViaSocks5,
  requestViaProxy,
  socks5AuthenticationStatus,
  startEchoTarget,
  startHttpTarget,
  startTestApp,
  waitForRouteStatus,
  type CreatedRouteResponse,
} from "./helpers.js";

async function readHttpHead(socket: Socket): Promise<string> {
  let buffer = Buffer.alloc(0);
  while (buffer.indexOf("\r\n\r\n") < 0) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer.toString("latin1");
}

test("residential routes rotate per request and preserve timed sessions", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });

  const rotating = await createRoute(testApp.application, {
    name: "rotating",
    targeting: { country: "US", postalCode: "10001", asn: 12_345 },
    rotation: { mode: "per_request" },
  });
  const first = await requestViaProxy(rotating.proxyUrls.http, target.url);
  const second = await requestViaProxy(rotating.proxyUrls.http, target.url);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).body, "target-response");
  assert.notEqual(first.headers["x-mock-exit-ip"], second.headers["x-mock-exit-ip"]);
  assert.equal(first.headers["x-mock-postal-code"], "10001");
  assert.equal(first.headers["x-mock-asn"], "12345");

  const timed = await createRoute(testApp.application, {
    name: "timed",
    targeting: { country: "US", region: "NY" },
    rotation: { mode: "interval", intervalSeconds: 60 },
  });
  const timedFirst = await requestViaProxy(timed.proxyUrls.http, target.url);
  const timedSecond = await requestViaProxy(timed.proxyUrls.http, target.url);
  assert.equal(timedFirst.headers["x-mock-exit-ip"], timedSecond.headers["x-mock-exit-ip"]);
});

test("plain HTTP preserves method, path, headers, and streamed body", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "http-transparency",
    targeting: { country: "US" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  const response = await requestViaProxy(route.proxyUrls.http, target.url, {
    method: "POST",
    headers: { authorization: "Bearer target-token", "content-type": "text/plain" },
    body: "streamed-request-body",
  });
  assert.equal(response.status, 200);
  const received = JSON.parse(response.body) as Record<string, string>;
  assert.equal(received.method, "POST");
  assert.equal(received.path, "/resource?secret=query-value");
  assert.equal(received.authorization, "Bearer target-token");
  assert.equal(received.requestBody, "streamed-request-body");
});

test("HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records", async (t) => {
  const httpTarget = await startHttpTarget();
  const echoTarget = await startEchoTarget();
  const testApp = await startTestApp([httpTarget.port, echoTarget.port]);
  t.after(async () => {
    await Promise.all([httpTarget.stop(), echoTarget.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "accounted-traffic",
    targeting: { country: "US" },
    allowedProtocols: ["http", "https", "socks5"],
  });
  assert.equal((await requestViaProxy(route.proxyUrls.http, httpTarget.url)).status, 200);
  assert.equal((await exchangeViaHttpConnect(route.proxyUrls.http, `127.0.0.1:${echoTarget.port}`, "connect-bytes")).body, "connect-bytes");
  assert.equal((await exchangeViaSocks5(route.proxyUrls.socks5, "127.0.0.1", echoTarget.port, "socks-bytes")).body, "socks-bytes");

  const store = new SqliteRouteStore(testApp.databasePath);
  try {
    let records = await store.listUsageRecords("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    const deadline = Date.now() + 2_000;
    while (records.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      records = await store.listUsageRecords("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    }
    assert.deepEqual(new Set(records.map((record) => record.protocol)), new Set(["http", "https", "socks5"]));
    assert.ok(records.every((record) => record.kind === "attempt" && record.pricingVersion !== undefined));
    assert.ok(records.every((record) => record.logicalOperationId && record.customerId && record.userId && record.routeId));
  } finally {
    await store.close();
  }
});

test("provider-side DNS remains authoritative while local and provider observations are diagnostic", async (t) => {
  const target = await startHttpTarget();
  const lines: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logger = {
    info: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
    warn: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
    error: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
  };
  const targetValidator = () => ({
    localResolution: Promise.resolve({
      status: "available" as const,
      addresses: ["93.184.216.34"],
    }),
  });
  const testApp = await startTestApp([target.port], undefined, logger, {}, { targetValidator });
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "provider-dns",
    targeting: { country: "US" },
    shouldRetry: false,
  });
  const domainUrl = target.url.replace("127.0.0.1", "localhost");

  assert.equal((await requestViaProxy(route.proxyUrls.http, domainUrl)).status, 200);
  assert.equal(
    (
      await exchangeViaHttpConnect(
        route.proxyUrls.http,
        `localhost:${target.port}`,
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await exchangeViaSocks5(
        route.proxyUrls.socks5,
        "localhost",
        target.port,
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      )
    ).replyCode,
    0x00,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const observations = lines.filter(
    ({ message }) => message === "Destination resolution observed" || message === "Destination resolution requires operator review",
  );
  assert.ok(observations.length >= 3);
  assert.deepEqual(new Set(observations.map(({ context }) => context?.dataPlaneProtocol)), new Set(["http", "https", "socks5"]));
  for (const { context } of observations) {
    assert.equal(context?.localResolutionStatus, "available");
    assert.deepEqual(context?.localResolvedAddresses, ["93.184.216.34"]);
    assert.equal(context?.providerResolutionStatus, "available");
    assert.equal(context?.resolutionDivergence, "different");
    assert.equal(context?.resolutionVerificationAvailability, "available");
    assert.equal(context?.resolutionGeographyVerification, "match");
    assert.equal(context?.providerResolverCountry, "US");
    assert.ok(Array.isArray(context?.providerResolvedAddresses));
  }
});

test("plain HTTP provider statuses are returned without failover", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "public-failover",
    targeting: { country: "US", region: "CA", carrier: "AT&T" },
    rotation: { mode: "manual" },
    isAuthenticated: false,
    shouldRetry: true,
  });
  testApp.application.simulators?.brightData.setFailure("unavailable");
  const response = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(response.status, 502);
  assert.equal(testApp.application.simulators?.proxidize.lastIdentity(), undefined);
});

test("authenticated routes prefer Proxidize and may explicitly use Bright Data", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });

  const preferred = await createRoute(testApp.application, {
    name: "authenticated-preference",
    targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
    isAuthenticated: true,
    shouldRetry: true,
  });
  const first = await requestViaProxy(preferred.proxyUrls.http, target.url);
  assert.equal(first.headers["x-mock-endpoint-id"], "px-us-ny-1");

  testApp.application.simulators?.proxidize.setFailure("unavailable");
  const failedOver = await requestViaProxy(preferred.proxyUrls.http, target.url);
  assert.equal(failedOver.status, 502);
  testApp.application.simulators?.proxidize.setFailure(null);

  const forced = await createRoute(testApp.application, {
    name: "authenticated-bright-data",
    targeting: { country: "US", region: "NY", city: "New York" },
    isAuthenticated: true,
    shouldRetry: false,
    forceProvider: "bright_data",
    rotation: { mode: "per_request" },
  });
  const explicitFirst = await requestViaProxy(forced.proxyUrls.http, target.url);
  const explicitSecond = await requestViaProxy(forced.proxyUrls.http, target.url);
  assert.equal(explicitFirst.status, 200);
  assert.equal(explicitFirst.headers["x-mock-endpoint-id"], "bright-data-superproxy");
  assert.notEqual(explicitFirst.headers["x-mock-exit-ip"], explicitSecond.headers["x-mock-exit-ip"]);
});

test("CONNECT exhausts two peers in the selected provider before cross-provider failover", async (t) => {
  const echo = await startEchoTarget();
  const lines: string[] = [];
  const logger = {
    info: (message: string, context?: Record<string, unknown>) => lines.push(JSON.stringify({ message, context })),
    warn: (message: string, context?: Record<string, unknown>) => lines.push(JSON.stringify({ message, context })),
    error: (message: string, context?: Record<string, unknown>) => lines.push(JSON.stringify({ message, context })),
  };
  const testApp = await startTestApp([echo.port], undefined, logger);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "hierarchical-failover",
    targeting: { country: "US", region: "CA", city: "Los Angeles", carrier: "AT&T" },
    rotation: { mode: "manual" },
    isAuthenticated: false,
    shouldRetry: true,
    retryPolicy: { maxAttempts: 4 },
  });
  testApp.application.simulators?.brightData.setFailure("unavailable");
  const exchange = await exchangeViaHttpConnect(route.proxyUrls.http, echo.url, "hierarchical-payload");
  assert.deepEqual(exchange, { status: 200, body: "hierarchical-payload" });
  assert.equal(testApp.application.simulators?.proxidize.lastIdentity()?.id, "px-us-ca-1");
  const attempts = lines
    .map((line) => JSON.parse(line) as { message: string; context?: { provider?: string } })
    .filter((entry) => entry.message === "Proxy tunnel establishment failed" || entry.message === "Proxy tunnel opened")
    .map((entry) => entry.context?.provider)
    .filter((provider): provider is string => provider !== undefined);
  assert.deepEqual(attempts, ["bright_data", "bright_data", "proxidize"]);
});

test("authenticated CONNECT failover preserves the route's exact city", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "authenticated-city-failover",
    targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
    rotation: { mode: "manual" },
    isAuthenticated: true,
    shouldRetry: true,
    retryPolicy: { maxAttempts: 4 },
  });
  testApp.application.simulators?.proxidize.setFailure("unavailable");
  const exchange = await exchangeViaHttpConnect(route.proxyUrls.http, echo.url, "authenticated-payload");
  assert.deepEqual(exchange, { status: 200, body: "authenticated-payload" });
  assert.equal(testApp.application.simulators?.brightData.lastIdentity()?.city, "newyork");
});

test("candidate establishment enforces per-attempt and overall deadlines without backoff", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port], undefined, undefined, {
    CONNECT_TIMEOUT_MS: "80",
    OPERATION_TIMEOUT_MS: "120",
  });
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "deadline-budget",
    targeting: { country: "US", region: "CA", city: "Los Angeles", carrier: "AT&T" },
    rotation: { mode: "manual" },
    isAuthenticated: false,
    shouldRetry: true,
    retryPolicy: { maxAttempts: 4 },
  });
  testApp.application.simulators?.brightData.setFailure("timeout");
  const startedAt = Date.now();
  const result = await exchangeViaHttpConnect(route.proxyUrls.http, echo.url, "");
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 502);
  assert.ok(elapsedMs < 400, `operation took ${elapsedMs}ms`);
  assert.equal(testApp.application.simulators?.proxidize.lastIdentity(), undefined);
});

test("mobile routes preserve affinity, rotate in-region, and distribute new routes", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });

  const firstRoute = await createRoute(testApp.application, {
    name: "mobile-one",
    isAuthenticated: true,
    targeting: { country: "US", region: "NY", city: "New York" },
    rotation: { mode: "manual" },
  });
  const secondRoute = await createRoute(testApp.application, {
    name: "mobile-two",
    isAuthenticated: true,
    targeting: { country: "US", region: "NY", city: "New York" },
    rotation: { mode: "manual" },
  });
  const before = await requestViaProxy(firstRoute.proxyUrls.http, target.url);
  const secondDevice = await requestViaProxy(secondRoute.proxyUrls.http, target.url);
  assert.notEqual(before.headers["x-mock-endpoint-id"], secondDevice.headers["x-mock-endpoint-id"]);
  const stable = await requestViaProxy(firstRoute.proxyUrls.http, target.url);
  assert.equal(before.headers["x-mock-exit-ip"], stable.headers["x-mock-exit-ip"]);
  assert.equal(before.headers["x-mock-region"], "NY");

  const rotateResponse = await controlRequest(testApp.application, `/v1/routes/${firstRoute.route.id}/rotate`, { method: "POST" });
  assert.equal(rotateResponse.status, 202);
  await waitForRouteStatus(testApp.application, firstRoute.route.id, "ready");
  const after = await requestViaProxy(firstRoute.proxyUrls.http, target.url);
  assert.notEqual(before.headers["x-mock-exit-ip"], after.headers["x-mock-exit-ip"]);
  assert.equal(after.headers["x-mock-region"], "NY");
  assert.equal(after.headers["x-mock-endpoint-id"], before.headers["x-mock-endpoint-id"]);
});

test("mobile device leases are isolated by access grant and survive credential rotation", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port], undefined, undefined, {
    CONTROL_API_IDENTITIES_JSON: JSON.stringify({
      "test-admin-token": "user-one",
      "second-token": "user-two",
    }),
  });
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const first = await createRoute(testApp.application, {
    name: "shared-profile",
    isAuthenticated: true,
    targeting: { country: "US", region: "NY", city: "New York" },
    rotation: { mode: "manual" },
    session: { mode: "sticky", id: "shared-session", requireGeographicContinuity: true },
  });
  const issueGrant = async (bearerToken = "test-admin-token") => {
    const response = await controlRequest(
      testApp.application,
      `/v1/routes/${first.route.id}/access-grants`,
      {
        method: "POST",
      },
      true,
      bearerToken,
    );
    assert.equal(response.status, 201);
    return (await response.json()) as CreatedRouteResponse;
  };
  const second = await issueGrant("second-token");
  const third = await issueGrant();
  const issuedSecrets = [decodeURIComponent(new URL(first.proxyUrls.http).password)];
  assert.equal(first.accessGrant.principalId, "user-one");
  assert.equal(second.accessGrant.principalId, "user-two");
  const firstResponse = await requestViaProxy(first.proxyUrls.http, target.url);
  const secondResponse = await requestViaProxy(second.proxyUrls.http, target.url);
  assert.notEqual(firstResponse.headers["x-mock-endpoint-id"], secondResponse.headers["x-mock-endpoint-id"]);
  assert.equal((await requestViaProxy(third.proxyUrls.http, target.url)).status, 503);

  const rotateCredential = await controlRequest(testApp.application, `/v1/access-grants/${first.accessGrant.id}/credentials/rotate`, {
    method: "POST",
  });
  assert.equal(rotateCredential.status, 200);
  const rotated = (await rotateCredential.json()) as CreatedRouteResponse;
  issuedSecrets.push(decodeURIComponent(new URL(rotated.proxyUrls.http).password));
  assert.equal(rotated.accessGrant.id, first.accessGrant.id);
  assert.equal((await requestViaProxy(first.proxyUrls.http, target.url)).status, 200);
  assert.equal(rotated.accessGrant.credentials[0]?.status, "overlap");
  assert.equal(rotated.credential.status, "active");
  assert.equal(Date.parse(rotated.credential.expiresAt) - Date.parse(rotated.credential.createdAt), 30 * 24 * 60 * 60_000);
  assert.equal(Date.parse(rotated.credential.expiresAt) - Date.parse(rotated.credential.renewalDueAt), 7 * 24 * 60 * 60_000);
  const rotatedResponse = await requestViaProxy(rotated.proxyUrls.http, target.url);
  assert.equal(rotatedResponse.headers["x-mock-endpoint-id"], firstResponse.headers["x-mock-endpoint-id"]);

  const compromiseRotation = await controlRequest(
    testApp.application,
    `/v1/access-grants/${first.accessGrant.id}/credentials/emergency-rotate`,
    { method: "POST" },
  );
  assert.equal(compromiseRotation.status, 200);
  const emergency = (await compromiseRotation.json()) as CreatedRouteResponse;
  issuedSecrets.push(decodeURIComponent(new URL(emergency.proxyUrls.http).password));
  assert.equal((await requestViaProxy(first.proxyUrls.http, target.url)).status, 407);
  assert.equal((await requestViaProxy(rotated.proxyUrls.http, target.url)).status, 407);
  assert.equal(
    (await requestViaProxy(emergency.proxyUrls.http, target.url)).headers["x-mock-endpoint-id"],
    firstResponse.headers["x-mock-endpoint-id"],
  );

  const list = await controlRequest(testApp.application, `/v1/routes/${first.route.id}/access-grants`);
  assert.equal(list.status, 200);
  const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
  assert.equal(listed.data.length, 2);
  const listedText = JSON.stringify(listed);
  assert.doesNotMatch(listedText, /proxyUrl|proxyPassword|tokenHash|tokenSalt/i);
  assert.match(listedText, /lastUsedAt|renewalDueAt|expiresAt/);
  for (const secret of issuedSecrets) assert.equal(listedText.includes(secret), false);
  const routeDetail = await controlRequest(testApp.application, `/v1/routes/${first.route.id}`);
  const routeList = await controlRequest(testApp.application, "/v1/routes");
  const redactedRouteResponses = `${await routeDetail.text()}${await routeList.text()}`;
  for (const secret of issuedSecrets) assert.equal(redactedRouteResponses.includes(secret), false);
  const secondList = await controlRequest(testApp.application, `/v1/routes/${first.route.id}/access-grants`, {}, true, "second-token");
  assert.equal(((await secondList.json()) as { data: unknown[] }).data.length, 1);
  const crossPrincipalRotation = await controlRequest(
    testApp.application,
    `/v1/access-grants/${first.accessGrant.id}/credentials/rotate`,
    { method: "POST" },
    true,
    "second-token",
  );
  assert.equal(crossPrincipalRotation.status, 404);

  const release = await controlRequest(
    testApp.application,
    `/v1/access-grants/${second.accessGrant.id}/release`,
    { method: "POST" },
    true,
    "second-token",
  );
  assert.equal(release.status, 204);
  const replacementResponse = await requestViaProxy(third.proxyUrls.http, target.url);
  assert.equal(replacementResponse.headers["x-mock-endpoint-id"], secondResponse.headers["x-mock-endpoint-id"]);
});

test("an unhealthy assigned mobile device fails over within the route's exact city", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "t-mobile-session",
    isAuthenticated: true,
    targeting: { country: "US", region: "NY", city: "New York" },
    rotation: { mode: "manual" },
  });
  const before = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(before.headers["x-mock-endpoint-id"], "px-us-ny-1");
  testApp.application.simulators?.proxidize.setDeviceHealth("px-us-ny-1", false);
  const response = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-mock-endpoint-id"], "px-us-ny-2");
  assert.equal(response.headers["x-mock-city"], "New York");
  const publicRoute = await controlRequest(testApp.application, `/v1/routes/${route.route.id}`);
  assert.doesNotMatch(await publicRoute.text(), /px-us-ny-1|endpointId/);
});

test("scheduled mobile rotation retains the assigned device and region", async (t) => {
  const target = await startHttpTarget();
  let now = Date.now();
  const testApp = await startTestApp([target.port], undefined, undefined, {}, { now: () => now });
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "scheduled-mobile",
    isAuthenticated: true,
    targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
    rotation: { mode: "interval", intervalSeconds: 60 },
  });
  const before = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(testApp.application.simulators?.proxidize.devices()[0]?.rotationIntervalSeconds, undefined);
  now += 61_000;
  const after = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.notEqual(before.headers["x-mock-exit-ip"], after.headers["x-mock-exit-ip"]);
  assert.equal(before.headers["x-mock-endpoint-id"], after.headers["x-mock-endpoint-id"]);
  assert.equal(after.headers["x-mock-region"], "NY");
});

test("HTTPS CONNECT tunnels bytes through the selected provider", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "connect-route",
    isAuthenticated: true,
    targeting: { country: "US", region: "NY", city: "New York", carrier: "Verizon" },
  });
  const proxy = new URL(route.proxyUrls.http);
  const echoed = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname);
    let buffer = Buffer.alloc(0);
    let established = false;
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${echo.url} HTTP/1.1\r\nHost: ${echo.url}\r\n` +
          `Proxy-Authorization: ${basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password))}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!established) {
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        assert.match(buffer.subarray(0, boundary).toString("latin1"), /200 Connection Established/);
        buffer = buffer.subarray(boundary + 4);
        established = true;
        socket.write("tunnel-payload");
      }
      if (established && buffer.toString("utf8").includes("tunnel-payload")) {
        socket.end();
        resolve(buffer.toString("utf8"));
      }
    });
  });
  assert.match(echoed, /tunnel-payload/);
  assert.equal(testApp.application.simulators?.proxidize.lastIdentity()?.id, "px-us-ny-2");
});

test("SOCKS5 TCP CONNECT uses the same access-grant credentials and preserves domain targets", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "socks5-route",
    targeting: { country: "US" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  assert.match(route.proxyUrls.socks5, /^socks5h:\/\//);
  const exchange = await exchangeViaSocks5(route.proxyUrls.socks5, "localhost", echo.port, "socks5-payload");
  assert.equal(exchange.replyCode, 0x00);
  assert.equal(exchange.body, "socks5-payload");
});

test("SOCKS5 rejects unsupported commands and route-level protocol exclusions", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "http-only",
    allowedProtocols: ["http", "https"],
    targeting: { country: "US" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  const disallowed = await exchangeViaSocks5(route.proxyUrls.socks5, "localhost", echo.port, "");
  assert.equal(disallowed.replyCode, 0x02);

  const fullRoute = await createRoute(testApp.application, {
    name: "socks-command",
    targeting: { country: "US" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  const bind = await exchangeViaSocks5(fullRoute.proxyUrls.socks5, "localhost", echo.port, "", 0x02);
  assert.equal(bind.replyCode, 0x07);
});

test("route revocation invalidates proxy credentials", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "temporary",
    targeting: { country: "US" },
  });
  const deletion = await controlRequest(testApp.application, `/v1/routes/${route.route.id}`, { method: "DELETE" });
  assert.equal(deletion.status, 204);
  const response = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(response.status, 407);
  assert.equal(response.headers["proxy-authenticate"], 'Basic realm="profound"');
  assert.equal(await socks5AuthenticationStatus(route.proxyUrls.socks5), 0x01);
});

test("routine access-grant revocation preserves an established tunnel while emergency revocation terminates it", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "revocation-lifecycle",
    targeting: { country: "US" },
  });
  const proxy = new URL(route.proxyUrls.http);
  const socket = connect(Number(proxy.port), proxy.hostname);
  socket.on("error", () => undefined);
  await once(socket, "connect");
  socket.write(
    `CONNECT ${echo.url} HTTP/1.1\r\nHost: ${echo.url}\r\n` +
      `Proxy-Authorization: ${basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password))}\r\n\r\n`,
  );
  assert.match(await readHttpHead(socket), /^HTTP\/1\.1 200/m);

  const routine = await controlRequest(testApp.application, `/v1/access-grants/${route.accessGrant.id}`, { method: "DELETE" });
  assert.equal(routine.status, 204);
  socket.write("still-active");
  const [echoed] = (await once(socket, "data")) as [Buffer];
  assert.equal(echoed.toString("utf8"), "still-active");
  assert.equal((await exchangeViaHttpConnect(route.proxyUrls.http, echo.url, "")).status, 407);

  const closed = once(socket, "close");
  const emergency = await controlRequest(testApp.application, `/v1/access-grants/${route.accessGrant.id}/emergency-revoke`, {
    method: "POST",
  });
  assert.equal(emergency.status, 204);
  await closed;
});

test("control API rejects unauthorized and malformed route requests", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const unauthorized = await controlRequest(testApp.application, "/v1/routes", {}, false);
  assert.equal(unauthorized.status, 401);
  const invalid = await controlRequest(testApp.application, "/v1/routes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bad", isAuthenticated: true, targeting: { country: "MX" } }),
  });
  assert.equal(invalid.status, 400);

  const openApi = await controlRequest(testApp.application, "/openapi.json", {}, false);
  assert.equal(openApi.status, 200);
  const specification = (await openApi.json()) as { info: { title: string }; paths: Record<string, unknown> };
  assert.equal(specification.info.title, "Profound Proxy Router Control API");
  assert.ok(specification.paths["/v1/routes"]);
  assert.ok(specification.paths["/v1/providers"]);

  const providers = await controlRequest(testApp.application, "/v1/providers");
  assert.equal(providers.status, 200);
  const providerBody = await providers.text();
  assert.match(
    providerBody,
    /providerClass|device_backed|residential|dnsResolution|exactCity|assignmentControl|versioned_config|bytes_sent|clientProtocols|upstreamProtocols|socks5/,
  );
  assert.doesNotMatch(providerBody, /mock-bright-password|mock-mobile-password/);

  const documentation = await controlRequest(testApp.application, "/docs", {}, false);
  assert.equal(documentation.status, 200);
  assert.match(await documentation.text(), /swagger-ui/);
});

test("control API can advertise the load balancer hostname from the request", async (t) => {
  const testApp = await startTestApp([443], undefined, undefined, {
    ADVERTISED_PROXY_HOST: "request-host",
    ADVERTISED_HTTP_PROXY_PROTOCOL: "https",
  });
  t.after(() => testApp.stop());
  const body = JSON.stringify({
    name: "load-balanced",
    targeting: { country: "US" },
    customerId: "customer-a",
    isAuthenticated: false,
    shouldRetry: false,
  });
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: testApp.application.controlAddress.port,
        path: "/v1/routes",
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-token",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          host: "router.example:8081",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
  assert.equal(result.status, 201);
  const route = JSON.parse(result.body) as { proxyUrls: { http: string; socks5: string } };
  assert.equal("proxyUrl" in route, false);
  assert.equal(new URL(route.proxyUrls.http).hostname, "router.example");
  assert.equal(new URL(route.proxyUrls.http).protocol, "https:");
  assert.equal(new URL(route.proxyUrls.http).hostname, "router.example");
  assert.equal(new URL(route.proxyUrls.socks5).hostname, "router.example");
});
