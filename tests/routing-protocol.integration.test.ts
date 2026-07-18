import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { basicAuth } from "../src/net-utils.js";
import { expectBufferChunk } from "../src/decoding.js";
import { CAPACITY_POLICY } from "../src/capacity-policy.js";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";
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

test("HTTPS CONNECT tunnels bytes through the selected provider", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => {
    await Promise.all([echo.stop(), testApp.stop()]);
  });
  const route = await createRoute(
    testApp.application,
    { name: "connect-route", targeting: { country: "US", region: "NY", city: "New York", carrier: "Verizon" } },
    "managed",
  );
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

test("logical-session APIs require an explicit mode and support rotation, close, and force-close lifecycle", async (t) => {
  const [target, echo] = await Promise.all([startHttpTarget(), startEchoTarget()]);
  const testApp = await startTestApp([target.port, echo.port]);
  t.after(async () => {
    await Promise.all([target.stop(), echo.stop(), testApp.stop()]);
  });
  const profileResponse = await controlRequest(testApp.application, "/v1/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "managed-lifecycle",
      geography: { countryCode: "US" },
      allowConnectionRetry: true,
    }),
  });
  assert.equal(profileResponse.status, 201);
  const { profileId } = (await profileResponse.json()) as { profileId: string };
  assert.equal(
    (await controlRequest(testApp.application, `/v1/profiles/${profileId}/grants`, { method: "POST" })).status,
    400,
    "omitting sessionMode is invalid",
  );

  const managedResponse = await controlRequest(testApp.application, `/v1/profiles/${profileId}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionMode: "managed", jobId: "job-managed-lifecycle" }),
  });
  assert.equal(managedResponse.status, 201);
  const managedIssued = (await managedResponse.json()) as IssuedAccessGrantApiResponse;
  assert.equal(managedIssued.credential.sessionMode, "managed");
  assert.equal(managedIssued.grant.jobId, "job-managed-lifecycle");
  assert.equal(managedIssued.credential.sessionId, managedIssued.session?.sessionId);
  assert.ok(managedIssued.session?.sessionId);
  const managed = materializeIssuedAccessGrant(managedIssued);
  const [first, second] = await Promise.all([
    requestViaProxy(managed.proxyUrls.http, target.url),
    requestViaProxy(managed.proxyUrls.http, target.url),
  ]);
  assert.equal(first.headers["x-mock-exit-ip"], second.headers["x-mock-exit-ip"]);
  const inspectedGrant = await controlRequest(testApp.application, `/v1/grants/${managed.accessGrant.id}`);
  assert.equal(inspectedGrant.status, 200);
  assert.equal(((await inspectedGrant.json()) as { grant: { jobId: string | null } }).grant.jobId, "job-managed-lifecycle");
  const storedUsage = new InMemoryRouteStore(testApp.storeState);
  try {
    const usage = await storedUsage.listUsageRecords("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    assert.ok(usage.length >= 2);
    assert.ok(usage.every((record) => record.jobId === "job-managed-lifecycle"));
    assert.ok(usage.every((record) => record.logicalOperationId.length > 0));
    assert.ok(usage.every((record) => record.destinationHost === "127.0.0.1"));
    assert.ok(usage.every((record) => record.destinationPort === target.port));
  } finally {
    await storedUsage.close();
  }

  const rotationResponse = await controlRequest(
    testApp.application,
    `/v1/grants/${managed.accessGrant.id}/credentials/${managed.credential.id}/rotate`,
    { method: "POST" },
  );
  assert.equal(rotationResponse.status, 200);
  const rotatedIssued = (await rotationResponse.json()) as IssuedAccessGrantApiResponse;
  assert.equal(rotatedIssued.credential.sessionId, managedIssued.session?.sessionId);
  const rotated = materializeIssuedAccessGrant(rotatedIssued);

  const statelessResponse = await controlRequest(testApp.application, `/v1/grants/${managed.accessGrant.id}/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionMode: "none" }),
  });
  assert.equal(statelessResponse.status, 201);
  const statelessIssued = (await statelessResponse.json()) as IssuedAccessGrantApiResponse;
  assert.equal(statelessIssued.credential.sessionMode, "none");
  assert.equal(statelessIssued.credential.sessionId, undefined);
  assert.equal(statelessIssued.session, undefined);
  const stateless = materializeIssuedAccessGrant(statelessIssued);

  const sessionsResponse = await controlRequest(testApp.application, `/v1/grants/${managed.accessGrant.id}/sessions`);
  assert.equal(sessionsResponse.status, 200);
  const sessionsText = await sessionsResponse.text();
  assert.match(sessionsText, new RegExp(managedIssued.session?.sessionId ?? "missing-session"));
  assert.doesNotMatch(sessionsText, /bright_data|proxidize|device|slot|exitIp|provider/i);
  const sessionResponse = await controlRequest(
    testApp.application,
    `/v1/grants/${managed.accessGrant.id}/sessions/${managedIssued.session?.sessionId ?? "missing"}`,
  );
  assert.equal(sessionResponse.status, 200);
  assert.match(await sessionResponse.text(), new RegExp(managedIssued.session?.sessionId ?? "missing-session"));

  const openTunnel = async (proxyUrl: string): Promise<Socket> => {
    const proxy = new URL(proxyUrl);
    const socket = connect(Number(proxy.port), proxy.hostname);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    socket.write(
      `CONNECT ${echo.url} HTTP/1.1\r\nHost: ${echo.url}\r\n` +
        `Proxy-Authorization: ${basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password))}\r\n\r\n`,
    );
    assert.match(await readHttpHead(socket), /^HTTP\/1\.1 200/m);
    return socket;
  };
  const drainingTunnel = await openTunnel(rotated.proxyUrls.http);
  const closeResponse = await controlRequest(
    testApp.application,
    `/v1/grants/${managed.accessGrant.id}/sessions/${managedIssued.session?.sessionId ?? "missing"}`,
    { method: "DELETE" },
  );
  assert.equal(closeResponse.status, 204);
  drainingTunnel.write("drains-after-close");
  const [echoed] = (await once(drainingTunnel, "data")) as [Buffer];
  assert.equal(echoed.toString("utf8"), "drains-after-close");
  assert.equal((await requestViaProxy(rotated.proxyUrls.http, target.url)).status, 407);
  assert.equal((await requestViaProxy(stateless.proxyUrls.http, target.url)).status, 200);
  drainingTunnel.destroy();

  const secondSessionResponse = await controlRequest(testApp.application, `/v1/grants/${managed.accessGrant.id}/sessions`, {
    method: "POST",
  });
  assert.equal(secondSessionResponse.status, 201);
  const secondSessionIssued = (await secondSessionResponse.json()) as IssuedAccessGrantApiResponse;
  const secondSession = materializeIssuedAccessGrant(secondSessionIssued);
  const forceClosedTunnel = await openTunnel(secondSession.proxyUrls.http);
  const closed = once(forceClosedTunnel, "close");
  const forceCloseResponse = await controlRequest(
    testApp.application,
    `/v1/grants/${managed.accessGrant.id}/sessions/${secondSessionIssued.session?.sessionId ?? "missing"}/force-close`,
    { method: "POST" },
  );
  assert.equal(forceCloseResponse.status, 204);
  await closed;
  assert.equal((await requestViaProxy(secondSession.proxyUrls.http, target.url)).status, 407);
});

test("managed-session concurrency converges on one binding and ignores soft saturation after placement", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(
    testApp.application,
    {
      name: "managed-affinity",
      shouldRetry: true,
      targeting: { country: "US", region: "NY", city: "New York" },
    },
    "managed",
  );
  const initial = await requestViaProxy(route.proxyUrls.http, target.url);
  const initialSlot = String(initial.headers["x-mock-endpoint-id"]);
  testApp.application.simulators?.proxidize.setDeviceHealth(initialSlot, false);
  const rebound = await Promise.all([requestViaProxy(route.proxyUrls.http, target.url), requestViaProxy(route.proxyUrls.http, target.url)]);
  const reboundSlots = new Set(rebound.map((response) => String(response.headers["x-mock-endpoint-id"])));
  assert.equal(reboundSlots.size, 1, "concurrent callers observe the winning atomic rebind");
  const reboundSlot = [...reboundSlots][0];
  assert.ok(reboundSlot);
  assert.notEqual(reboundSlot, initialSlot);
  testApp.application.simulators?.proxidize.setDeviceHealth(initialSlot, true);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const store = new InMemoryRouteStore(testApp.storeState);
  try {
    assert.ok(route.credential.sessionId);
    const idleSession = await store.getLogicalSession(route.credential.sessionId);
    assert.equal(idleSession.affinity?.candidateId, reboundSlot, "idle sessions retain their last-known affinity");
    assert.ok(idleSession.lastDisconnectedAt);
    assert.equal(
      (await store.listAllActiveTunnels()).filter((connection) => connection.sessionId === route.credential.sessionId).length,
      0,
      "idle affinity does not reserve active capacity",
    );
    const now = Date.now();
    for (let index = 0; index < CAPACITY_POLICY.softConnectionsPerSlot; index += 1) {
      await store.registerActiveTunnel({
        id: `soft-pressure-${index}`,
        deploymentId: "test-pressure",
        routeId: route.profile.id,
        accessGrantId: `other-grant-${index}`,
        protocol: "https",
        provider: "proxidize",
        endpointId: reboundSlot,
        startedAt: new Date(now).toISOString(),
        lastHeartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 120_000).toISOString(),
      });
    }
  } finally {
    await store.close();
  }
  const saturated = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(saturated.headers["x-mock-endpoint-id"], reboundSlot, "soft pressure does not move an existing managed session");
});

test("managed cross-class fallback fails back only after health stabilization and session quiescence", async (t) => {
  let clock = Date.parse("2026-07-18T00:00:00.000Z");
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port], undefined, undefined, {}, { now: () => clock });
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(
    testApp.application,
    {
      name: "controlled-failback",
      shouldRetry: true,
      targeting: { country: "US", region: "NY", city: "New York" },
    },
    "managed",
  );
  for (const device of testApp.application.simulators?.proxidize.devices() ?? []) {
    if (device.city === "New York") testApp.application.simulators?.proxidize.setDeviceHealth(device.id, false);
  }
  const fallback = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(fallback.headers["x-mock-endpoint-id"], "bright-data-superproxy");

  for (const device of testApp.application.simulators?.proxidize.devices() ?? []) {
    if (device.city === "New York") testApp.application.simulators?.proxidize.setDeviceHealth(device.id, true);
  }
  const stabilizing = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(stabilizing.headers["x-mock-endpoint-id"], "bright-data-superproxy");
  await new Promise<void>((resolve) => setImmediate(resolve));
  clock += 5 * 60_000 + 31_000;
  const failedBack = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.match(String(failedBack.headers["x-mock-endpoint-id"]), /^px-us-ny-/);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const store = new InMemoryRouteStore(testApp.storeState);
  try {
    const usage = await store.listUsageRecords("2026-07-17T00:00:00.000Z", "2026-07-19T00:00:00.000Z");
    assert.ok(usage.some((record) => record.degradedFallback === true));
    assert.ok(usage.some((record) => record.failbackOutcome === "success"));
  } finally {
    await store.close();
  }
});

test("control API rejects unauthorized and malformed route requests", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const unauthorized = await controlRequest(testApp.application, "/v1/profiles", {}, false);
  assert.equal(unauthorized.status, 401);
  const unauthorizedBody = (await unauthorized.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(unauthorizedBody).sort(), ["code", "message", "requestId", "retryable"]);
  assert.equal(unauthorizedBody["code"], "unauthorized");
  const invalid = await controlRequest(testApp.application, "/v1/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "bad",
      geography: { countryCode: "MX" },
      allowConnectionRetry: false,
      rotation: { mode: "manual" },
    }),
  });
  assert.equal(invalid.status, 400);
  const invalidBody = (await invalid.json()) as Record<string, unknown>;
  assert.equal(typeof invalidBody["code"], "string");
  assert.equal(typeof invalidBody["message"], "string");
  assert.equal(typeof invalidBody["retryable"], "boolean");
  assert.equal(typeof invalidBody["requestId"], "string");
  assert.equal(invalidBody["_tag"], undefined);
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
  const issuedResponse = await requestWithAdvertisedHost(`/v1/profiles/${profileId}/grants`, JSON.stringify({ sessionMode: "none" }));
  assert.equal(issuedResponse.status, 201);
  const issued = JSON.parse(issuedResponse.body) as { endpoints: { http: string; socks5: string }; credential: { password: string } };
  assert.equal(new URL(issued.endpoints.http).hostname, "router.example");
  assert.equal(new URL(issued.endpoints.http).protocol, "https:");
  assert.equal(new URL(issued.endpoints.socks5).hostname, "router.example");
  assert.equal(new URL(issued.endpoints.http).username, "");
  assert.equal(new URL(issued.endpoints.http).password, "");
  assert.ok(issued.credential.password.length >= 32);
});
