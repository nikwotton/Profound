import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  bestEffortDestroyRoute,
  controlRequest,
  createRoute,
  destroyRoute,
  e2eEnvironment,
  e2eTest,
  proxyWithCredentials,
  requestViaHttpProxy,
  requestViaSocks5,
  waitForRouteStatus,
} from "./helpers.js";
import { authenticatedProxyEndpoint, type CreatedProxyApiResponse } from "../helpers.js";

function optionalHeader(response: { headers: import("node:http").IncomingHttpHeaders }, name: string): string | undefined {
  const value = response.headers[name];
  return typeof value === "string" ? value : undefined;
}

e2eTest("a caller can discover service health and must authenticate management requests", async () => {
  const live = await controlRequest("/health/live", {}, null);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "live" });

  const ready = await controlRequest("/health/ready", {}, null);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  assert.equal((await controlRequest("/v1/proxies", {}, null)).status, 401);

  const providers = await controlRequest("/v1/providers");
  assert.equal(providers.status, 200);
  const payload = (await providers.json()) as { data?: Array<{ id?: string }> };
  assert.deepEqual((payload.data ?? []).map(({ id }) => id).sort(), ["bright_data", "proxidize"]);
});

e2eTest("a caller can create, use, rotate, inspect, and destroy a residential proxy", async (t) => {
  const environment = e2eEnvironment();
  const route = await createRoute({
    name: `e2e-residential-${randomUUID()}`,
    location: { country: "US", postalCode: "10001" },
    egress: { continuity: "none", rotation: "manual" },
  });
  let destroyed = false;
  t.after(async () => {
    if (!destroyed) await bestEffortDestroyRoute(route.route.id);
  });

  assert.deepEqual(route.route.allowedProtocols, ["http", "https", "socks5"]);
  assert.equal(decodeURIComponent(new URL(route.proxyUrls.http).username), route.accessGrant.id);

  const first = await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl, {
    headers: { "x-profound-e2e-id": randomUUID() },
  });
  assert.equal(first.status, environment.expectedTargetStatus);
  const firstIp = optionalHeader(first, "x-mock-exit-ip");

  const socks = await requestViaSocks5(route.proxyUrls.socks5, environment.targetUrl);
  assert.equal(socks.status, environment.expectedTargetStatus);

  const wrongCredential = await requestViaHttpProxy(
    proxyWithCredentials(route.proxyUrls.http, route.accessGrant.id, "wrong-e2e-credential"),
    environment.targetUrl,
  );
  assert.equal(wrongCredential.status, 407);

  const detail = await controlRequest(`/v1/proxies/${route.route.id}`);
  assert.equal(detail.status, 200);
  const detailText = await detail.text();
  const routeToken = decodeURIComponent(new URL(route.proxyUrls.http).password);
  assert.ok(routeToken.length >= 32);
  assert.ok(!detailText.includes(routeToken));

  const rotate = await controlRequest(`/v1/proxies/${route.route.id}/rotate`, { method: "POST" });
  assert.equal(rotate.status, 202);
  await waitForRouteStatus(route.route.id, "ready");
  const rotated = await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl);
  assert.equal(rotated.status, environment.expectedTargetStatus);
  const rotatedIp = optionalHeader(rotated, "x-mock-exit-ip");
  if (firstIp !== undefined) {
    assert.notEqual(rotatedIp, firstIp);
  }

  const deletion = await destroyRoute(route.route.id);
  assert.equal(deletion.status, 204);
  destroyed = true;
  assert.equal((await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl)).status, 407);
  assert.equal((await controlRequest(`/v1/proxies/${route.route.id}`)).status, 404);
});

e2eTest("a proxy credential can be rotated and is invalidated with its proxy", async (t) => {
  const environment = e2eEnvironment();
  const route = await createRoute({
    name: `e2e-credential-${randomUUID()}`,
    location: { country: "US" },
    egress: { continuity: "none", rotation: "per_request" },
  });
  let destroyed = false;
  t.after(async () => {
    if (!destroyed) await bestEffortDestroyRoute(route.route.id);
  });

  const rotationResponse = await controlRequest(`/v1/proxies/${route.route.id}/credentials/rotate`, { method: "POST" });
  assert.equal(rotationResponse.status, 200);
  const rotated = (await rotationResponse.json()) as CreatedProxyApiResponse;
  const rotatedUrl = authenticatedProxyEndpoint(rotated, "http");
  assert.equal(rotated.proxy.credentials[0]?.status, "overlap");
  assert.equal((await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl)).status, environment.expectedTargetStatus);
  assert.equal((await requestViaHttpProxy(rotatedUrl, environment.targetUrl)).status, environment.expectedTargetStatus);

  assert.equal((await destroyRoute(route.route.id)).status, 204);
  destroyed = true;
  assert.equal((await requestViaHttpProxy(rotatedUrl, environment.targetUrl)).status, 407);
});

e2eTest("a geographic proxy preserves device affinity and rotates its exit within the requested city", async (t) => {
  const environment = e2eEnvironment();
  const route = await createRoute({
    name: `e2e-mobile-${randomUUID()}`,
    location: { country: "US", region: "NY", city: "New York" },
    egress: { continuity: "geographic", rotation: "manual", sessionKey: `e2e-${randomUUID()}` },
  });
  t.after(() => bestEffortDestroyRoute(route.route.id));

  const first = await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl);
  const stable = await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl);
  assert.equal(first.status, environment.expectedTargetStatus);
  assert.equal(stable.status, environment.expectedTargetStatus);
  const endpointId = optionalHeader(first, "x-mock-endpoint-id");
  const firstIp = optionalHeader(first, "x-mock-exit-ip");
  if (endpointId !== undefined) assert.equal(optionalHeader(stable, "x-mock-endpoint-id"), endpointId);
  if (firstIp !== undefined) assert.equal(optionalHeader(stable, "x-mock-exit-ip"), firstIp);

  assert.equal((await controlRequest(`/v1/proxies/${route.route.id}/rotate`, { method: "POST" })).status, 202);
  await waitForRouteStatus(route.route.id, "ready");
  const rotated = await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl);
  assert.equal(rotated.status, environment.expectedTargetStatus);
  if (endpointId !== undefined) assert.equal(optionalHeader(rotated, "x-mock-endpoint-id"), endpointId);
  const city = optionalHeader(rotated, "x-mock-city");
  if (city !== undefined) assert.equal(city.toLowerCase().replaceAll(" ", ""), "newyork");
  if (firstIp !== undefined) assert.notEqual(optionalHeader(rotated, "x-mock-exit-ip"), firstIp);
});
