import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  type CreatedRouteResponse,
  controlRequest,
  createRoute,
  deployedEnvironment,
  deployedTest,
  httpConnectStatus,
  requestViaHttpConnect,
  requestViaHttpProxy,
  requestViaSocks5,
  revokeRoute,
  socks5CommandReply,
  waitForRouteStatus,
} from "./helpers.js";

function parsedBody(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

deployedTest("deployed HTTP forwarding preserves native method, path, query, headers, cookies, authorization, and body", async (t) => {
  const { metadata } = await deployedEnvironment();
  assert.ok(metadata.integrationTarget);
  const route = await createRoute({
    name: `http-transparency-${Date.now()}`,
    targeting: { country: "US", postalCode: "10001", asn: 12_345 },
    isAuthenticated: false,
    shouldRetry: false,
  });
  t.after(() => revokeRoute(route.route.id).catch(() => undefined));
  const testId = randomUUID();
  const target = new URL(
    "/echo/path?first=one&second=two",
    metadata.integrationTransportTarget?.url ?? metadata.integrationTarget.url,
  ).toString();
  const response = await requestViaHttpProxy(route.proxyUrls.http, target, {
    method: "POST",
    headers: {
      authorization: "Bearer target-authorization-value",
      cookie: "target-session=private-cookie-value",
      "content-type": "text/plain",
      "x-profound-test-id": testId,
      "x-profound-test-header": "preserved-header-value",
    },
    body: "streamed-request-body",
  });
  assert.equal(response.status, 200);
  const observed = parsedBody(response);
  assert.equal(observed.method, "POST");
  assert.equal(observed.path, "/echo/path?first=one&second=two");
  assert.equal(observed.authorization, "Bearer target-authorization-value");
  assert.equal(observed.cookie, "target-session=private-cookie-value");
  assert.equal(observed.testHeader, "preserved-header-value");
  assert.equal(observed.requestBody, "streamed-request-body");
  assert.equal(observed.requestCount, 1);
  assert.equal(response.headers["x-mock-postal-code"], "10001");
  assert.equal(response.headers["x-mock-asn"], "12345");
});

deployedTest("deployed target statuses and redirects remain caller-owned and are never replayed", async (t) => {
  const { metadata } = await deployedEnvironment();
  assert.ok(metadata.integrationTarget);
  const route = await createRoute({
    name: `target-outcomes-${Date.now()}`,
    targeting: { country: "US" },
    isAuthenticated: false,
    shouldRetry: true,
    retryPolicy: { maxAttempts: 4 },
  });
  t.after(() => revokeRoute(route.route.id).catch(() => undefined));

  const statusId = randomUUID();
  const unavailable = await requestViaHttpProxy(route.proxyUrls.http, new URL("/status/503", metadata.integrationTarget.url).toString(), {
    headers: { "x-profound-test-id": statusId },
  });
  assert.equal(unavailable.status, 503);
  assert.equal(parsedBody(unavailable).requestCount, 1);

  const redirectId = randomUUID();
  const redirect = await requestViaHttpProxy(
    route.proxyUrls.http,
    new URL("/redirect?to=%2Fcaller-owned-destination", metadata.integrationTarget.url).toString(),
    { headers: { "x-profound-test-id": redirectId } },
  );
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, "/caller-owned-destination");
  assert.equal(parsedBody(redirect).requestCount, 1);
});

deployedTest("deployed Bright Data routes support fresh, interval, manual, and authenticated exact-city policies", async (t) => {
  const { metadata } = await deployedEnvironment();
  assert.ok(metadata.integrationTarget);
  const target = new URL("/bright-data", metadata.integrationTarget.url).toString();
  const routeIds: string[] = [];
  t.after(async () => Promise.all(routeIds.map((id) => revokeRoute(id).catch(() => undefined))));

  const fresh = await createRoute({
    name: `fresh-${Date.now()}`,
    targeting: { country: "US", city: "New York" },
    rotation: { mode: "per_request" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  routeIds.push(fresh.route.id);
  const freshFirst = await requestViaHttpProxy(fresh.proxyUrls.http, target);
  const freshSecond = await requestViaHttpProxy(fresh.proxyUrls.http, target);
  assert.notEqual(freshFirst.headers["x-mock-exit-ip"], freshSecond.headers["x-mock-exit-ip"]);
  assert.equal(freshFirst.headers["x-mock-city"], "newyork");

  const interval = await createRoute({
    name: `interval-${Date.now()}`,
    targeting: { country: "US", region: "NY" },
    rotation: { mode: "interval", intervalSeconds: 60 },
    isAuthenticated: false,
    shouldRetry: false,
  });
  routeIds.push(interval.route.id);
  const intervalFirst = await requestViaHttpProxy(interval.proxyUrls.http, target);
  const intervalSecond = await requestViaHttpProxy(interval.proxyUrls.http, target);
  assert.equal(intervalFirst.headers["x-mock-exit-ip"], intervalSecond.headers["x-mock-exit-ip"]);

  const manual = await createRoute({
    name: `manual-${Date.now()}`,
    targeting: { country: "US" },
    rotation: { mode: "manual" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  routeIds.push(manual.route.id);
  const before = await requestViaHttpProxy(manual.proxyUrls.http, target);
  const rotate = await controlRequest(`/v1/routes/${manual.route.id}/rotate`, { method: "POST" });
  assert.equal(rotate.status, 202);
  await waitForRouteStatus(manual.route.id, "ready");
  const after = await requestViaHttpProxy(manual.proxyUrls.http, target);
  assert.notEqual(before.headers["x-mock-exit-ip"], after.headers["x-mock-exit-ip"]);

  const authenticated = await createRoute({
    name: `authenticated-bright-${Date.now()}`,
    targeting: { country: "US", city: "New York" },
    rotation: { mode: "per_request" },
    isAuthenticated: true,
    shouldRetry: false,
    forceProvider: "bright_data",
  });
  routeIds.push(authenticated.route.id);
  assert.equal(authenticated.route.provider, "bright_data");
  assert.equal((await requestViaHttpProxy(authenticated.proxyUrls.http, target)).headers["x-mock-city"], "newyork");
});

deployedTest("deployed Proxidize routes retain device affinity, distribute capacity, and rotate within the city", async (t) => {
  const { metadata } = await deployedEnvironment();
  assert.ok(metadata.integrationTarget);
  const target = new URL("/mobile", metadata.integrationTarget.url).toString();
  const routes: CreatedRouteResponse[] = [];
  for (const number of [1, 2]) {
    routes.push(
      await createRoute({
        name: `mobile-distribution-${number}-${Date.now()}`,
        targeting: { country: "US", region: "NY", city: "New York" },
        rotation: { mode: "manual" },
        session: { mode: "sticky", id: `deployed-session-${number}`, requireGeographicContinuity: true },
        isAuthenticated: true,
        shouldRetry: false,
      }),
    );
  }
  t.after(async () => Promise.all(routes.map(({ route }) => revokeRoute(route.id).catch(() => undefined))));

  assert.ok(routes.every(({ route }) => route.provider === "proxidize"));
  const first = await requestViaHttpProxy(routes[0]!.proxyUrls.http, target);
  const firstStable = await requestViaHttpProxy(routes[0]!.proxyUrls.http, target);
  const second = await requestViaHttpProxy(routes[1]!.proxyUrls.http, target);
  assert.equal(first.headers["x-mock-endpoint-id"], firstStable.headers["x-mock-endpoint-id"]);
  assert.equal(first.headers["x-mock-exit-ip"], firstStable.headers["x-mock-exit-ip"]);
  assert.notEqual(first.headers["x-mock-endpoint-id"], second.headers["x-mock-endpoint-id"]);
  assert.equal(first.headers["x-mock-city"], "New York");

  const rotate = await controlRequest(`/v1/routes/${routes[0]!.route.id}/rotate`, { method: "POST" });
  assert.equal(rotate.status, 202);
  await waitForRouteStatus(routes[0]!.route.id, "ready");
  const rotated = await requestViaHttpProxy(routes[0]!.proxyUrls.http, target);
  assert.equal(rotated.headers["x-mock-endpoint-id"], first.headers["x-mock-endpoint-id"]);
  assert.equal(rotated.headers["x-mock-city"], first.headers["x-mock-city"]);
  assert.notEqual(rotated.headers["x-mock-exit-ip"], first.headers["x-mock-exit-ip"]);
});

deployedTest("deployed HTTP CONNECT and SOCKS5 CONNECT preserve opaque TCP and TLS traffic", async (t) => {
  const { metadata } = await deployedEnvironment();
  assert.ok(metadata.integrationTarget);
  const route = await createRoute({
    name: `tunnel-protocols-${Date.now()}`,
    allowedProtocols: ["http", "https", "socks5"],
    targeting: { country: "US" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  t.after(() => revokeRoute(route.route.id).catch(() => undefined));

  const connectTarget = new URL("/connect?native=query", metadata.integrationTarget.url).toString();
  const connected = await requestViaHttpConnect(route.proxyUrls.http, connectTarget, {
    method: "POST",
    headers: { "x-profound-test-header": "connect-header", "content-type": "text/plain" },
    body: "connect-body",
  });
  assert.equal(connected.status, 200);
  assert.equal(parsedBody(connected).path, "/connect?native=query");
  assert.equal(parsedBody(connected).requestBody, "connect-body");

  const socksTarget = new URL("/socks?native=query", metadata.integrationTarget.url).toString();
  const socks = await requestViaSocks5(route.proxyUrls.socks5, socksTarget, {
    method: "POST",
    headers: { "x-profound-test-header": "socks-header", "content-type": "text/plain" },
    body: "socks-body",
  });
  assert.equal(socks.status, 200);
  assert.equal(parsedBody(socks).path, "/socks?native=query");
  assert.equal(parsedBody(socks).requestBody, "socks-body");

  if (metadata.integrationTransportTarget !== null) {
    const plainHttpTarget = new URL("/plain-http", metadata.integrationTransportTarget.url).toString();
    assert.equal((await requestViaHttpConnect(route.proxyUrls.http, plainHttpTarget)).status, 200);
    assert.equal((await requestViaSocks5(route.proxyUrls.socks5, plainHttpTarget)).status, 200);
  }

  assert.equal(await socks5CommandReply(route.proxyUrls.socks5, connectTarget, 0x02), 0x07);
  assert.equal(await socks5CommandReply(route.proxyUrls.socks5, connectTarget, 0x03), 0x07);
});

deployedTest("deployed gateways enforce route protocols, public destinations, ports, and credential-free targets", async (t) => {
  const { metadata } = await deployedEnvironment();
  assert.ok(metadata.integrationTarget);
  const route = await createRoute({
    name: `http-only-security-${Date.now()}`,
    allowedProtocols: ["http"],
    targeting: { country: "US" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  t.after(() => revokeRoute(route.route.id).catch(() => undefined));
  const publicTarget = new URL("/security", metadata.integrationTarget.url).toString();

  assert.equal(await httpConnectStatus(route.proxyUrls.http, publicTarget), 403);
  assert.equal(await socks5CommandReply(route.proxyUrls.socks5, publicTarget, 0x01), 0x02);

  const privateTarget = await requestViaHttpProxy(route.proxyUrls.http, "http://127.0.0.1:80/internal");
  assert.equal(privateTarget.status, 403);
  const metadataTarget = await requestViaHttpProxy(route.proxyUrls.http, "http://169.254.169.254/latest/meta-data/");
  assert.equal(metadataTarget.status, 403);

  const target = new URL(publicTarget);
  target.username = "embedded-user";
  target.password = "embedded-password";
  assert.equal((await requestViaHttpProxy(route.proxyUrls.http, target.toString())).status, 403);

  target.username = "";
  target.password = "";
  target.port = "81";
  assert.equal((await requestViaHttpProxy(route.proxyUrls.http, target.toString())).status, 403);
});
