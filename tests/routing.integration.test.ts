import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { basicAuth } from "../src/net-utils.js";
import { expectBufferChunk, expectRecord, parseJson } from "../src/decoding.js";
import { CAPACITY_POLICY } from "../src/capacity-policy.js";
import { SqliteRouteStore } from "../src/store.js";
import {
  controlRequest,
  createRoute,
  exchangeViaHttpConnect,
  exchangeViaSocks5,
  materializeIssuedAccessGrant,
  requestViaProxy,
  socks5AuthenticationStatus,
  startEchoTarget,
  startHttpTarget,
  startTestApp,
  type IssuedAccessGrantApiResponse,
} from "./helpers.js";

async function readHttpHead(socket: Socket): Promise<string> {
  let buffer = Buffer.alloc(0);
  while (buffer.indexOf("\r\n\r\n") < 0) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer.toString("latin1");
}

test("unauthenticated profiles use fresh residential exits per request", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });

  const rotating = await createRoute(testApp.application, {
    name: "rotating",
    targeting: { country: "US" },
  });
  const first = await requestViaProxy(rotating.proxyUrls.http, target.url);
  const second = await requestViaProxy(rotating.proxyUrls.http, target.url);
  assert.equal(first.status, 200);
  assert.equal(expectRecord(parseJson(first.body, "target response"), "target response").body, "target-response");
  assert.notEqual(first.headers["x-mock-exit-ip"], second.headers["x-mock-exit-ip"]);
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

test("authenticated routes prefer Proxidize while Bright Data remains eligible when it is the compatible provider", async (t) => {
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

  const eligible = await createRoute(testApp.application, {
    name: "authenticated-bright-data",
    targeting: { country: "GB", city: "London" },
    isAuthenticated: true,
    shouldRetry: false,
    rotation: { mode: "per_request" },
  });
  const eligibleFirst = await requestViaProxy(eligible.proxyUrls.http, target.url);
  const eligibleSecond = await requestViaProxy(eligible.proxyUrls.http, target.url);
  assert.equal(eligibleFirst.status, 200);
  assert.equal(eligibleFirst.headers["x-mock-endpoint-id"], "bright-data-superproxy");
  assert.equal(
    eligibleFirst.headers["x-mock-exit-ip"],
    eligibleSecond.headers["x-mock-exit-ip"],
    "authenticated Bright Data traffic uses a stable internal session",
  );
});

test("provider override is explicit, persisted, compatibility-gated, and never falls back", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });

  const overridden = await createRoute(testApp.application, {
    targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
    providerOverride: "bright_data",
    isAuthenticated: true,
    shouldRetry: true,
  });
  assert.equal(overridden.profile.providerOverride, "bright_data");
  assert.equal((await requestViaProxy(overridden.proxyUrls.http, target.url)).headers["x-mock-endpoint-id"], "bright-data-superproxy");

  testApp.application.simulators?.brightData.setFailure("unavailable");
  assert.equal((await requestViaProxy(overridden.proxyUrls.http, target.url)).status, 502);
  assert.equal(testApp.application.simulators?.proxidize.lastIdentity(), undefined, "an override never silently falls back");
  testApp.application.simulators?.brightData.setFailure(null);

  const incompatible = await controlRequest(testApp.application, "/v1/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "override-incompatible",
      geography: { countryCode: "GB", city: "London" },
      providerOverride: "proxidize",
      isTargetAuthenticated: true,
      allowConnectionRetry: false,
    }),
  });
  assert.equal(incompatible.status, 503);
  assert.equal(((await incompatible.json()) as { code: string }).code, "provider_override_unsatisfied");
});

test("soft-saturated preferred slots remain ahead of the fallback provider class", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const store = new SqliteRouteStore(testApp.databasePath);
  try {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    for (let index = 0; index < CAPACITY_POLICY.softConnectionsPerSlot; index += 1) {
      await store.registerActiveTunnel({
        id: `soft-load-${index}`,
        deploymentId: "other-deployment",
        routeId: `other-route-${index}`,
        accessGrantId: `other-grant-${index}`,
        protocol: "https",
        provider: "proxidize",
        endpointId: "px-us-ny-1",
        startedAt: now,
        lastHeartbeatAt: now,
        expiresAt,
      });
    }
  } finally {
    await store.close();
  }

  const route = await createRoute(testApp.application, {
    targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
    isAuthenticated: true,
  });
  const response = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(response.headers["x-mock-endpoint-id"], "px-us-ny-1");
});

test("unauthenticated residential soft saturation promotes an eligible device-backed fallback", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const completedAt = new Date(Date.now() - 1_000).toISOString();
  const store = new SqliteRouteStore(testApp.databasePath);
  try {
    await store.recordUsage({
      kind: "attempt",
      id: "bright-data-soft-pressure",
      logicalOperationId: "bright-data-soft-pressure-operation",
      accessGrantId: "pressure-grant",
      routeId: "pressure-route",
      userId: "pressure-user",
      customerId: "pressure-customer",
      provider: "bright_data",
      protocol: "http",
      outcome: "success",
      retryIndex: 0,
      failover: false,
      bytesSent: 0,
      bytesReceived: 0,
      country: "US",
      city: "New York",
      capacityPressure: true,
      capacityPressureProvider: "bright_data",
      startedAt: completedAt,
      completedAt,
    });
  } finally {
    await store.close();
  }

  const route = await createRoute(testApp.application, {
    targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
    isAuthenticated: false,
  });
  const response = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-mock-endpoint-id"], "px-us-ny-1");

  const usageStore = new SqliteRouteStore(testApp.databasePath);
  try {
    let records = await usageStore.listUsageRecords("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    const deadline = Date.now() + 2_000;
    while (
      !records.some((record) => record.id !== "bright-data-soft-pressure" && record.provider === "proxidize") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      records = await usageStore.listUsageRecords("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    }
    const fallback = records.find((record) => record.id !== "bright-data-soft-pressure" && record.provider === "proxidize");
    assert.equal(fallback?.failover, true);
    assert.equal(fallback?.capacityPressure, true);
    assert.equal(fallback?.capacityPressureProvider, "bright_data");
  } finally {
    await usageStore.close();
  }
});

test("a provider-reported hard capacity limit opens the shared circuit immediately", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    targeting: { country: "US" },
    providerOverride: "bright_data",
    shouldRetry: false,
  });
  testApp.application.simulators?.brightData.setFailure("capacity");
  assert.equal((await exchangeViaHttpConnect(route.proxyUrls.http, echo.url, "")).status, 502);

  const store = new SqliteRouteStore(testApp.databasePath);
  try {
    const circuit = await store.getCapacityCircuit("bright_data", "bright_data");
    assert.equal(circuit?.status, "open");
    assert.equal(circuit?.reason, "provider_hard_limit");
  } finally {
    await store.close();
  }
});

test("unauthenticated CONNECT exhausts residential peers without an incompatible device fallback", async (t) => {
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
    targeting: { country: "GB", city: "London" },
    rotation: { mode: "manual" },
    isAuthenticated: false,
    shouldRetry: true,
    retryPolicy: { maxAttempts: 4 },
  });
  testApp.application.simulators?.brightData.setFailure("unavailable");
  const exchange = await exchangeViaHttpConnect(route.proxyUrls.http, echo.url, "hierarchical-payload");
  assert.deepEqual(exchange, { status: 502, body: "" });
  assert.equal(testApp.application.simulators?.proxidize.lastIdentity(), undefined);
  const attempts = lines
    .map((line) => JSON.parse(line) as { message: string; context?: { provider?: string } })
    .filter((entry) => entry.message === "Proxy tunnel establishment failed" || entry.message === "Proxy tunnel opened")
    .map((entry) => entry.context?.provider)
    .filter((provider): provider is string => provider !== undefined);
  assert.deepEqual(attempts, ["bright_data", "bright_data"]);
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

test("concurrent mobile connections persist distinct atomic load claims for scored compatible slots", async (t) => {
  const target = await startEchoTarget();
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
  const openTunnel = async (proxyUrl: string): Promise<Socket> => {
    const proxy = new URL(proxyUrl);
    const socket = connect(Number(proxy.port), proxy.hostname);
    await once(socket, "connect");
    socket.write(
      `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n` +
        `Proxy-Authorization: ${basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password))}\r\n\r\n`,
    );
    assert.match(await readHttpHead(socket), /200 Connection Established/);
    return socket;
  };
  const firstTunnel = await openTunnel(firstRoute.proxyUrls.http);
  const secondTunnel = await openTunnel(secondRoute.proxyUrls.http);
  assert.equal(testApp.application.simulators?.proxidize.lastIdentity()?.city, "New York");
  const store = new SqliteRouteStore(testApp.databasePath);
  try {
    const active = await store.listAllActiveTunnels();
    assert.equal(active.length, 2);
    assert.equal(new Set(active.map((connection) => connection.id)).size, 2);
    assert.ok(active.every((connection) => connection.routingPolicyVersion !== undefined && connection.routingScore !== undefined));
  } finally {
    await store.close();
  }
  firstTunnel.destroy();
  secondTunnel.destroy();
});

test("profile updates apply to new connections without replacing access-grant credentials or exposing providers", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const created = await createRoute(testApp.application, {
    name: "updatable-profile",
    targeting: { country: "US" },
    rotation: { mode: "per_request" },
    isAuthenticated: false,
    shouldRetry: true,
  });
  assert.equal((await requestViaProxy(created.proxyUrls.http, target.url)).headers["x-mock-country"], "US");

  const update = await controlRequest(testApp.application, `/v1/profiles/${created.profile.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "test-customer",
      geography: { countryCode: "GB" },
      isTargetAuthenticated: false,
      allowConnectionRetry: true,
    }),
  });
  assert.equal(update.status, 200);
  const updateText = await update.text();
  assert.doesNotMatch(updateText, /bright_data|proxidize|forceProvider|"provider"/i);
  const updated = JSON.parse(updateText) as { profile: { profileId: string; geography: { countryCode: string } } };
  assert.equal(updated.profile.profileId, created.profile.id);
  assert.equal(updated.profile.geography.countryCode, "GB");
  assert.equal((await requestViaProxy(created.proxyUrls.http, target.url)).headers["x-mock-country"], "GB");
});

test("mobile grants share scored proxy-slot capacity and credential rotation creates no affinity", async (t) => {
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
  const issueGrant = async () => {
    const response = await controlRequest(
      testApp.application,
      `/v1/profiles/${first.profile.id}/grants`,
      {
        method: "POST",
      },
      true,
    );
    assert.equal(response.status, 201);
    return materializeIssuedAccessGrant((await response.json()) as IssuedAccessGrantApiResponse);
  };
  const second = await issueGrant();
  const issuedSecrets = [decodeURIComponent(new URL(first.proxyUrls.http).password)];
  assert.notEqual(first.proxyUsername, first.accessGrant.id, "proxy usernames remain opaque credential identifiers");
  const firstResponse = await requestViaProxy(first.proxyUrls.http, target.url);
  const secondResponse = await requestViaProxy(second.proxyUrls.http, target.url);
  assert.equal(firstResponse.headers["x-mock-city"], "New York");
  assert.equal(secondResponse.headers["x-mock-city"], "New York");
  const third = await issueGrant();
  assert.equal((await requestViaProxy(third.proxyUrls.http, target.url)).status, 200, "slot capacity is shared rather than reserved");

  const rotateCredential = await controlRequest(testApp.application, `/v1/grants/${first.accessGrant.id}/credentials/rotate`, {
    method: "POST",
  });
  assert.equal(rotateCredential.status, 200);
  const rotated = materializeIssuedAccessGrant((await rotateCredential.json()) as IssuedAccessGrantApiResponse);
  issuedSecrets.push(decodeURIComponent(new URL(rotated.proxyUrls.http).password));
  assert.equal(rotated.accessGrant.id, first.accessGrant.id);
  assert.equal((await requestViaProxy(first.proxyUrls.http, target.url)).status, 200);
  assert.equal(rotated.accessGrant.credentials[0]?.status, "overlap");
  assert.equal(rotated.credential.status, "active");
  assert.equal(Date.parse(rotated.credential.expiresAt) - Date.parse(rotated.credential.createdAt), 30 * 24 * 60 * 60_000);
  assert.equal(Date.parse(rotated.credential.expiresAt) - Date.parse(rotated.credential.renewalDueAt), 7 * 24 * 60 * 60_000);
  const rotatedResponse = await requestViaProxy(rotated.proxyUrls.http, target.url);
  assert.equal(rotatedResponse.headers["x-mock-city"], "New York");

  const compromiseRotation = await controlRequest(testApp.application, `/v1/grants/${first.accessGrant.id}/credentials/emergency-rotate`, {
    method: "POST",
  });
  assert.equal(compromiseRotation.status, 200);
  const emergency = materializeIssuedAccessGrant((await compromiseRotation.json()) as IssuedAccessGrantApiResponse);
  issuedSecrets.push(decodeURIComponent(new URL(emergency.proxyUrls.http).password));
  assert.equal((await requestViaProxy(first.proxyUrls.http, target.url)).status, 407);
  assert.equal((await requestViaProxy(rotated.proxyUrls.http, target.url)).status, 407);
  assert.equal((await requestViaProxy(emergency.proxyUrls.http, target.url)).headers["x-mock-city"], "New York");

  const list = await controlRequest(testApp.application, `/v1/profiles/${first.profile.id}/grants`);
  assert.equal(list.status, 200);
  const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
  assert.equal(listed.data.length, 3);
  assert.equal(listed.data.filter((grant) => grant.status === "revoked").length, 0);
  const listedText = JSON.stringify(listed);
  assert.doesNotMatch(listedText, /proxyUrl|proxyPassword|tokenHash|tokenSalt/i);
  assert.match(listedText, /lastUsedAt|renewalDueAt|expiresAt/);
  for (const secret of issuedSecrets) assert.equal(listedText.includes(secret), false);
  const routeDetail = await controlRequest(testApp.application, `/v1/profiles/${first.profile.id}`);
  const routeList = await controlRequest(testApp.application, "/v1/profiles");
  const redactedRouteResponses = `${await routeDetail.text()}${await routeList.text()}`;
  for (const secret of issuedSecrets) assert.equal(redactedRouteResponses.includes(secret), false);
  const secondList = await controlRequest(testApp.application, `/v1/profiles/${first.profile.id}/grants`, {}, true, "second-token");
  assert.equal(secondList.status, 404);
  const crossPrincipalRotation = await controlRequest(
    testApp.application,
    `/v1/grants/${first.accessGrant.id}/credentials/rotate`,
    { method: "POST" },
    true,
    "second-token",
  );
  assert.equal(crossPrincipalRotation.status, 404);

  const release = await controlRequest(testApp.application, `/v1/grants/${second.accessGrant.id}`, { method: "DELETE" });
  assert.equal(release.status, 204);
  const replacement = await issueGrant();
  const replacementResponse = await requestViaProxy(replacement.proxyUrls.http, target.url);
  assert.equal(replacementResponse.headers["x-mock-city"], "New York");
});

test("an unhealthy mobile slot is excluded while exact-city routing remains mandatory", async (t) => {
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
  const selected = String(before.headers["x-mock-endpoint-id"]);
  const alternate = selected === "px-us-ny-1" ? "px-us-ny-2" : "px-us-ny-1";
  assert.ok(selected === "px-us-ny-1" || selected === "px-us-ny-2");
  testApp.application.simulators?.proxidize.setDeviceHealth(selected, false);
  const response = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-mock-endpoint-id"], alternate);
  assert.equal(response.headers["x-mock-city"], "New York");
  const publicRoute = await controlRequest(testApp.application, `/v1/profiles/${route.profile.id}`);
  assert.doesNotMatch(await publicRoute.text(), /px-us-ny-[12]|endpointId/);
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

test("SOCKS5 rejects unsupported commands", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
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
  const deletion = await controlRequest(testApp.application, `/v1/profiles/${route.profile.id}`, { method: "DELETE" });
  assert.equal(deletion.status, 204);
  const response = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(response.status, 407);
  assert.equal(response.headers["proxy-authenticate"], 'Basic realm="profound"');
  assert.equal(await socks5AuthenticationStatus(route.proxyUrls.socks5), 0x01);
});

test("access-grant revocation preserves an established tunnel and rejects new connections", async (t) => {
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

  const routine = await controlRequest(testApp.application, `/v1/grants/${route.accessGrant.id}`, { method: "DELETE" });
  assert.equal(routine.status, 204);
  socket.write("still-active");
  const [echoed] = (await once(socket, "data")) as [Buffer];
  assert.equal(echoed.toString("utf8"), "still-active");
  assert.equal((await exchangeViaHttpConnect(route.proxyUrls.http, echo.url, "")).status, 407);

  socket.destroy();
});

test("control API rejects unauthorized and malformed route requests", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const unauthorized = await controlRequest(testApp.application, "/v1/profiles", {}, false);
  assert.equal(unauthorized.status, 401);
  const invalid = await controlRequest(testApp.application, "/v1/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "bad",
      geography: { countryCode: "MX" },
      isTargetAuthenticated: false,
      allowConnectionRetry: false,
      rotation: { mode: "manual" },
    }),
  });
  assert.equal(invalid.status, 400);
  const invalidBody = (await invalid.json()) as Record<string, unknown>;
  assert.equal(typeof invalidBody.code, "string");
  assert.equal(typeof invalidBody.message, "string");
  assert.equal(typeof invalidBody.retryable, "boolean");
  assert.equal(typeof invalidBody.requestId, "string");
  assert.doesNotMatch(JSON.stringify(invalidBody), /bright|proxidize|provider|candidate/i);

  const openApi = await controlRequest(testApp.application, "/openapi.json", {}, false);
  assert.equal(openApi.status, 200);
  const specification = (await openApi.json()) as { info: { title: string }; paths: Record<string, unknown> };
  assert.equal(specification.info.title, "Profound Proxy Router Control API");
  assert.ok(specification.paths["/v1/profiles"]);
  assert.ok(specification.paths["/v1/profiles/{id}/grants"]);
  assert.ok(specification.paths["/v1/grants/{grantId}/credentials/{credentialId}"]);
  assert.equal(specification.paths["/v1/providers"], undefined);
  assert.equal(specification.paths["/v1/providers/health"], undefined);

  const providers = await controlRequest(testApp.application, "/v1/providers");
  assert.equal(providers.status, 404);

  const documentation = await controlRequest(testApp.application, "/docs", {}, false);
  assert.equal(documentation.status, 200);
  assert.match(await documentation.text(), /swagger-ui/);
});

test("credential metadata is inspectable and each credential can be revoked independently", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    customerId: "credential-inspection",
    geography: { countryCode: "US" },
    isTargetAuthenticated: false,
    allowConnectionRetry: false,
  });
  const credentialId = route.credential.id;
  const metadata = await controlRequest(testApp.application, `/v1/grants/${route.accessGrant.id}/credentials/${credentialId}`);
  assert.equal(metadata.status, 200);
  const metadataText = await metadata.text();
  assert.match(metadataText, new RegExp(credentialId));
  assert.doesNotMatch(metadataText, /password|tokenHash|tokenSalt/i);

  const revoke = await controlRequest(testApp.application, `/v1/grants/${route.accessGrant.id}/credentials/${credentialId}`, {
    method: "DELETE",
  });
  assert.equal(revoke.status, 204);
  assert.equal((await requestViaProxy(route.proxyUrls.http, target.url)).status, 407);
  const grant = await controlRequest(testApp.application, `/v1/grants/${route.accessGrant.id}`);
  assert.equal(grant.status, 200);
  assert.match(await grant.text(), /"status":"revoked"/);
});

test("control API can advertise the load balancer hostname from the request", async (t) => {
  const testApp = await startTestApp([443], undefined, undefined, {
    ADVERTISED_PROXY_HOST: "request-host",
    ADVERTISED_HTTP_PROXY_PROTOCOL: "https",
  });
  t.after(() => testApp.stop());
  const profileBody = JSON.stringify({
    customerId: "customer-a",
    geography: { countryCode: "US" },
    isTargetAuthenticated: false,
    allowConnectionRetry: false,
  });
  const requestWithAdvertisedHost = (path: string, body = "") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: testApp.application.controlAddress.port,
          path,
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
          response.on("data", (chunk) => chunks.push(expectBufferChunk(chunk)));
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
  const created = await requestWithAdvertisedHost("/v1/profiles", profileBody);
  assert.equal(created.status, 201);
  const { profileId } = JSON.parse(created.body) as { profileId: string };
  const issuedResponse = await requestWithAdvertisedHost(`/v1/profiles/${profileId}/grants`);
  assert.equal(issuedResponse.status, 201);
  const issued = JSON.parse(issuedResponse.body) as { endpoints: { http: string; socks5: string }; credential: { password: string } };
  assert.equal(new URL(issued.endpoints.http).hostname, "router.example");
  assert.equal(new URL(issued.endpoints.http).protocol, "https:");
  assert.equal(new URL(issued.endpoints.socks5).hostname, "router.example");
  assert.equal(new URL(issued.endpoints.http).username, "");
  assert.equal(new URL(issued.endpoints.http).password, "");
  assert.ok(issued.credential.password.length >= 32);
});
