import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import { basicAuth } from "../src/net-utils.js";
import {
  controlRequest,
  createRoute,
  requestViaProxy,
  startEchoTarget,
  startHttpTarget,
  startTestApp,
  waitForRouteStatus,
} from "./helpers.js";

test("residential routes rotate per request and preserve timed sessions", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => { await Promise.all([target.stop(), testApp.stop()]); });

  const rotating = await createRoute(testApp.application, {
    name: "rotating",
    kind: "residential",
    targeting: { country: "US", postalCode: "10001", asn: 12_345 },
    rotation: { mode: "per_request" },
  });
  const first = await requestViaProxy(rotating.proxyUrl, target.url);
  const second = await requestViaProxy(rotating.proxyUrl, target.url);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).body, "target-response");
  assert.notEqual(first.headers["x-mock-exit-ip"], second.headers["x-mock-exit-ip"]);
  assert.equal(first.headers["x-mock-postal-code"], "10001");
  assert.equal(first.headers["x-mock-asn"], "12345");

  const timed = await createRoute(testApp.application, {
    name: "timed",
    kind: "residential",
    targeting: { country: "US", region: "NY" },
    rotation: { mode: "interval", intervalSeconds: 60 },
  });
  const timedFirst = await requestViaProxy(timed.proxyUrl, target.url);
  const timedSecond = await requestViaProxy(timed.proxyUrl, target.url);
  assert.equal(timedFirst.headers["x-mock-exit-ip"], timedSecond.headers["x-mock-exit-ip"]);
});

test("mobile routes preserve affinity, rotate in-region, and distribute new routes", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => { await Promise.all([target.stop(), testApp.stop()]); });

  const firstRoute = await createRoute(testApp.application, {
    name: "mobile-one",
    kind: "mobile",
    targeting: { country: "US", region: "NY" },
    rotation: { mode: "manual" },
  });
  const secondRoute = await createRoute(testApp.application, {
    name: "mobile-two",
    kind: "mobile",
    targeting: { country: "US", region: "NY" },
    rotation: { mode: "manual" },
  });
  assert.notEqual(firstRoute.route.endpointId, secondRoute.route.endpointId);

  const before = await requestViaProxy(firstRoute.proxyUrl, target.url);
  const stable = await requestViaProxy(firstRoute.proxyUrl, target.url);
  assert.equal(before.headers["x-mock-exit-ip"], stable.headers["x-mock-exit-ip"]);
  assert.equal(before.headers["x-mock-region"], "NY");

  const rotateResponse = await controlRequest(testApp.application, `/v1/routes/${firstRoute.route.id}/rotate`, { method: "POST" });
  assert.equal(rotateResponse.status, 202);
  await waitForRouteStatus(testApp.application, firstRoute.route.id, "ready");
  const after = await requestViaProxy(firstRoute.proxyUrl, target.url);
  assert.notEqual(before.headers["x-mock-exit-ip"], after.headers["x-mock-exit-ip"]);
  assert.equal(after.headers["x-mock-region"], "NY");
  assert.equal(after.headers["x-mock-endpoint-id"], before.headers["x-mock-endpoint-id"]);
});

test("an unhealthy assigned mobile device fails closed without reassignment", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => { await Promise.all([target.stop(), testApp.stop()]); });
  const route = await createRoute(testApp.application, {
    name: "t-mobile-session",
    kind: "mobile",
    targeting: { country: "US", region: "NY", carrier: "T-Mobile" },
    rotation: { mode: "manual" },
  });
  assert.equal(route.route.endpointId, "px-us-ny-1");
  testApp.application.simulators?.proxidize.setDeviceHealth("px-us-ny-1", false);
  const response = await requestViaProxy(route.proxyUrl, target.url);
  assert.equal(response.status, 503);
  assert.match(response.body, /provider_unavailable/);
  assert.equal(testApp.application.routes.get(route.route.id).endpointId, "px-us-ny-1");
});

test("scheduled mobile rotation retains the assigned device and region", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => { await Promise.all([target.stop(), testApp.stop()]); });
  const route = await createRoute(testApp.application, {
    name: "scheduled-mobile",
    kind: "mobile",
    targeting: { country: "US", region: "NY", carrier: "T-Mobile" },
    rotation: { mode: "interval", intervalSeconds: 60 },
  });
  const before = await requestViaProxy(route.proxyUrl, target.url);
  testApp.application.simulators?.proxidize.ageDeviceRotation("px-us-ny-1", 61_000);
  const after = await requestViaProxy(route.proxyUrl, target.url);
  assert.notEqual(before.headers["x-mock-exit-ip"], after.headers["x-mock-exit-ip"]);
  assert.equal(before.headers["x-mock-endpoint-id"], after.headers["x-mock-endpoint-id"]);
  assert.equal(after.headers["x-mock-region"], "NY");
});

test("HTTPS CONNECT tunnels bytes through the selected provider", async (t) => {
  const echo = await startEchoTarget();
  const testApp = await startTestApp([echo.port]);
  t.after(async () => { await Promise.all([echo.stop(), testApp.stop()]); });
  const route = await createRoute(testApp.application, {
    name: "connect-route",
    kind: "mobile",
    targeting: { country: "US", region: "NY", carrier: "Verizon" },
  });
  const proxy = new URL(route.proxyUrl);
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

test("route revocation invalidates proxy credentials", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => { await Promise.all([target.stop(), testApp.stop()]); });
  const route = await createRoute(testApp.application, {
    name: "temporary",
    kind: "residential",
    targeting: { country: "US" },
  });
  const deletion = await controlRequest(testApp.application, `/v1/routes/${route.route.id}`, { method: "DELETE" });
  assert.equal(deletion.status, 204);
  const response = await requestViaProxy(route.proxyUrl, target.url);
  assert.equal(response.status, 407);
  assert.equal(response.headers["proxy-authenticate"], 'Basic realm="profound"');
});

test("control API rejects unauthorized and malformed route requests", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => { await Promise.all([target.stop(), testApp.stop()]); });
  const unauthorized = await controlRequest(testApp.application, "/v1/routes", {}, false);
  assert.equal(unauthorized.status, 401);
  const invalid = await controlRequest(testApp.application, "/v1/routes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bad", kind: "mobile", targeting: { country: "MX" } }),
  });
  assert.equal(invalid.status, 400);

  const openApi = await controlRequest(testApp.application, "/openapi.json", {}, false);
  assert.equal(openApi.status, 200);
  const specification = await openApi.json() as { info: { title: string }; paths: Record<string, unknown> };
  assert.equal(specification.info.title, "Profound Proxy Router Control API");
  assert.ok(specification.paths["/v1/routes"]);

  const documentation = await controlRequest(testApp.application, "/docs", {}, false);
  assert.equal(documentation.status, 200);
  assert.match(await documentation.text(), /swagger-ui/);
});
