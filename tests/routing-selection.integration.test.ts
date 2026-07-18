import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { basicAuth } from "../src/net-utils.js";
import { CAPACITY_POLICY } from "../src/capacity-policy.js";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";
import {
  controlRequest,
  createRoute,
  exchangeViaHttpConnect,
  materializeIssuedAccessGrant,
  requestViaProxy,
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

test("managed sessions prefer Proxidize while Bright Data remains eligible when it is the compatible provider", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });

  const preferred = await createRoute(
    testApp.application,
    {
      name: "managed-preference",
      targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
      shouldRetry: true,
    },
    "managed",
  );
  const first = await requestViaProxy(preferred.proxyUrls.http, target.url);
  assert.equal(first.headers["x-mock-endpoint-id"], "px-us-ny-1");

  testApp.application.simulators?.proxidize.setFailure("unavailable");
  const failedOver = await requestViaProxy(preferred.proxyUrls.http, target.url);
  assert.equal(failedOver.status, 502);
  testApp.application.simulators?.proxidize.setFailure(null);

  const eligible = await createRoute(
    testApp.application,
    {
      name: "managed-bright-data",
      targeting: { country: "GB", city: "London" },
      shouldRetry: false,
      rotation: { mode: "per_request" },
    },
    "managed",
  );
  const eligibleFirst = await requestViaProxy(eligible.proxyUrls.http, target.url);
  const eligibleSecond = await requestViaProxy(eligible.proxyUrls.http, target.url);
  assert.equal(eligibleFirst.status, 200);
  assert.equal(eligibleFirst.headers["x-mock-endpoint-id"], "bright-data-superproxy");
  assert.equal(
    eligibleFirst.headers["x-mock-exit-ip"],
    eligibleSecond.headers["x-mock-exit-ip"],
    "managed Bright Data traffic uses a stable internal session",
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
  const store = new InMemoryRouteStore(testApp.storeState);
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

  const route = await createRoute(
    testApp.application,
    { targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" } },
    "managed",
  );
  const response = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(response.headers["x-mock-endpoint-id"], "px-us-ny-1");
});

test("stateless residential soft saturation promotes an eligible device-backed fallback", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const completedAt = new Date(Date.now() - 1_000).toISOString();
  const store = new InMemoryRouteStore(testApp.storeState);
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
  });
  const response = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-mock-endpoint-id"], "px-us-ny-1");

  const usageStore = new InMemoryRouteStore(testApp.storeState);
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

  const store = new InMemoryRouteStore(testApp.storeState);
  try {
    const circuit = await store.getCapacityCircuit("bright_data", "bright_data");
    assert.equal(circuit?.status, "open");
    assert.equal(circuit?.reason, "provider_hard_limit");
  } finally {
    await store.close();
  }
});

test("stateless CONNECT exhausts residential peers without an incompatible device fallback", async (t) => {
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
    shouldRetry: true,
    retryPolicy: { maxAttempts: 4 },
  });
  testApp.application.simulators?.brightData.setFailure("unavailable");
  const exchange = await exchangeViaHttpConnect(route.proxyUrls.http, echo.url, "hierarchical-payload");
  assert.deepEqual(exchange, { status: 502, body: "" });
  assert.equal(testApp.application.simulators?.proxidize.lastIdentity(), undefined);
  const attemptEntries = lines
    .map((line) => JSON.parse(line) as { message: string; context?: { provider?: string; commitmentState?: string } })
    .filter((entry) => entry.message === "Proxy tunnel establishment failed" || entry.message === "Proxy tunnel opened")
    .filter((entry) => entry.context?.provider !== undefined);
  const attempts = attemptEntries.map((entry) => entry.context?.provider).filter((provider): provider is string => provider !== undefined);
  assert.deepEqual(attempts, ["bright_data", "bright_data"]);
  assert.deepEqual(
    attemptEntries.map((entry) => entry.context?.commitmentState),
    ["pre_commit", "pre_commit"],
  );
});

test("managed CONNECT failover preserves the route's exact city", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(
    testApp.application,
    {
      name: "managed-city-failover",
      targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
      rotation: { mode: "manual" },
      shouldRetry: true,
      retryPolicy: { maxAttempts: 4 },
    },
    "managed",
  );
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

test("concurrent mobile connections claim the least-loaded compatible slots with a stable tie-breaker", async (t) => {
  const target = await startEchoTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });

  const firstRoute = await createRoute(
    testApp.application,
    { name: "mobile-one", targeting: { country: "US", region: "NY", city: "New York" }, rotation: { mode: "manual" } },
    "managed",
  );
  const secondRoute = await createRoute(
    testApp.application,
    { name: "mobile-two", targeting: { country: "US", region: "NY", city: "New York" }, rotation: { mode: "manual" } },
    "managed",
  );
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
  const store = new InMemoryRouteStore(testApp.storeState);
  try {
    const active = await store.listAllActiveTunnels();
    assert.equal(active.length, 2);
    assert.equal(new Set(active.map((connection) => connection.id)).size, 2);
    assert.equal(new Set(active.map((connection) => connection.endpointId)).size, 2);
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
    shouldRetry: true,
  });
  assert.equal((await requestViaProxy(created.proxyUrls.http, target.url)).headers["x-mock-country"], "US");

  const update = await controlRequest(testApp.application, `/v1/profiles/${created.profile.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "test-customer",
      geography: { countryCode: "GB" },
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

test("managed sessions rebind opaque provider affinity after an incompatible profile update", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const created = await createRoute(
    testApp.application,
    {
      name: "managed-updatable-profile",
      targeting: { country: "US" },
      rotation: { mode: "per_request" },
      shouldRetry: true,
    },
    "managed",
  );
  const first = await requestViaProxy(created.proxyUrls.http, target.url);
  const repeated = await requestViaProxy(created.proxyUrls.http, target.url);
  assert.equal(repeated.headers["x-mock-session"], first.headers["x-mock-session"]);
  assert.equal(repeated.headers["x-mock-exit-ip"], first.headers["x-mock-exit-ip"]);

  const update = await controlRequest(testApp.application, `/v1/profiles/${created.profile.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "test-customer",
      geography: { countryCode: "GB" },
      allowConnectionRetry: true,
    }),
  });
  assert.equal(update.status, 200);

  const rebound = await requestViaProxy(created.proxyUrls.http, target.url);
  assert.equal(rebound.headers["x-mock-country"], "GB");
  assert.notEqual(rebound.headers["x-mock-session"], first.headers["x-mock-session"]);
  assert.notEqual(rebound.headers["x-mock-exit-ip"], first.headers["x-mock-exit-ip"]);
});

test("emergency profile revocation closes managed sessions and invalidates their grants", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const created = await createRoute(
    testApp.application,
    {
      name: "emergency-managed-profile",
      targeting: { country: "US" },
      rotation: { mode: "manual" },
    },
    "managed",
  );
  assert.ok(created.credential.sessionId);
  assert.equal((await requestViaProxy(created.proxyUrls.http, target.url)).status, 200);

  await testApp.application.routes.emergencyRevoke(created.profile.id);

  assert.equal((await requestViaProxy(created.proxyUrls.http, target.url)).status, 407);
  const session = await testApp.application.routes.getLogicalSession(created.accessGrant.id, created.credential.sessionId, "local-dev");
  assert.equal(session.status, "closed");
});

test("stateless mobile credentials share least-loaded proxy-slot capacity without affinity", async (t) => {
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
    targeting: { country: "US", region: "NY", city: "New York" },
    providerOverride: "proxidize",
    rotation: { mode: "manual" },
  });
  const issueGrant = async () => {
    const response = await controlRequest(
      testApp.application,
      `/v1/profiles/${first.profile.id}/grants`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionMode: "none" }),
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

  const rotateCredential = await controlRequest(
    testApp.application,
    `/v1/grants/${first.accessGrant.id}/credentials/${first.credential.id}/rotate`,
    { method: "POST" },
  );
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

  const compromiseRotation = await controlRequest(
    testApp.application,
    `/v1/grants/${first.accessGrant.id}/credentials/${rotated.credential.id}/emergency-rotate`,
    { method: "POST" },
  );
  assert.equal(compromiseRotation.status, 200);
  const emergency = materializeIssuedAccessGrant((await compromiseRotation.json()) as IssuedAccessGrantApiResponse);
  issuedSecrets.push(decodeURIComponent(new URL(emergency.proxyUrls.http).password));
  assert.equal((await requestViaProxy(first.proxyUrls.http, target.url)).status, 200);
  assert.equal((await requestViaProxy(rotated.proxyUrls.http, target.url)).status, 407);
  assert.equal((await requestViaProxy(emergency.proxyUrls.http, target.url)).headers["x-mock-city"], "New York");

  const list = await controlRequest(testApp.application, `/v1/profiles/${first.profile.id}/grants`);
  assert.equal(list.status, 200);
  const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
  assert.equal(listed.data.length, 3);
  assert.equal(listed.data.filter((grant) => grant["status"] === "revoked").length, 0);
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
    `/v1/grants/${first.accessGrant.id}/credentials/${first.credential.id}/rotate`,
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
  const route = await createRoute(
    testApp.application,
    { name: "t-mobile-session", targeting: { country: "US", region: "NY", city: "New York" }, rotation: { mode: "manual" } },
    "managed",
  );
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
