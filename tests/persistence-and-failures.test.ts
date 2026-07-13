import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/logger.js";
import {
  createRoute,
  requestViaProxy,
  startHttpTarget,
  startTestApp,
} from "./helpers.js";

test("route credentials and mobile affinity survive a service restart", async (t) => {
  const target = await startHttpTarget();
  let testApp = await startTestApp([target.port]);
  t.after(async () => {
    await target.stop();
    await testApp.stop();
  });
  const route = await createRoute(testApp.application, {
    name: "persistent",
    kind: "mobile",
    targeting: { country: "US", region: "CA", carrier: "AT&T" },
  });
  const endpointId = route.route.endpointId;
  const saved = { databasePath: testApp.databasePath, directory: testApp.directory };
  await testApp.stop(false);
  testApp = await startTestApp([target.port], saved);

  const response = await requestViaProxy(route.proxyUrl.replace(/:\d+$/, `:${testApp.application.forwardAddress.port}`), target.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-mock-endpoint-id"], endpointId);
  assert.equal(testApp.application.routes.get(route.route.id).endpointId, endpointId);
});

test("provider authentication, rate limiting, and unavailable peers are normalized", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => { await Promise.all([target.stop(), testApp.stop()]); });
  const route = await createRoute(testApp.application, {
    name: "failures",
    kind: "residential",
    targeting: { country: "US" },
  });
  const simulator = testApp.application.simulators?.brightData;
  assert.ok(simulator);

  simulator.setFailure("auth");
  const authentication = await requestViaProxy(route.proxyUrl, target.url);
  assert.equal(authentication.status, 502);
  assert.doesNotMatch(authentication.body, /mock-bright-password/);

  simulator.setFailure("rate_limit");
  const rateLimit = await requestViaProxy(route.proxyUrl, target.url);
  assert.equal(rateLimit.status, 503);
  assert.match(rateLimit.body, /provider_rate_limited/);

  simulator.setFailure("unavailable");
  const unavailable = await requestViaProxy(route.proxyUrl, target.url);
  assert.equal(unavailable.status, 502);

  simulator.setFailure("timeout");
  const timeout = await requestViaProxy(route.proxyUrl, target.url);
  assert.equal(timeout.status, 503);
  simulator.setFailure(null);
});

test("structured logs redact credentials, cookies, authorization, and URL queries", () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  logger.info("redaction", {
    authorization: "Bearer secret",
    password: "provider-password",
    cookie: "session=secret",
    proxyUrl: "http://user:token@proxy",
    target: new URL("https://example.test/path?secret=value"),
  });
  const output = lines.join("\n");
  assert.doesNotMatch(output, /Bearer secret|provider-password|session=secret|user:token|secret=value/);
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /https:\/\/example\.test\/path/);
});
