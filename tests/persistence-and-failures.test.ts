import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/logger.js";
import { createRoute, requestViaProxy, socks5AuthenticationStatus, startHttpTarget, startTestApp } from "./helpers.js";

test("access-grant credentials and mobile affinity survive a service restart", async (t) => {
  const target = await startHttpTarget();
  let testApp = await startTestApp([target.port]);
  t.after(async () => {
    await target.stop();
    await testApp.stop();
  });
  const route = await createRoute(testApp.application, {
    name: "persistent",
    isAuthenticated: true,
    targeting: { country: "US", region: "CA", city: "Los Angeles", carrier: "AT&T" },
  });
  const before = await requestViaProxy(route.proxyUrls.http, target.url);
  const endpointId = before.headers["x-mock-endpoint-id"];
  const saved = { databasePath: testApp.databasePath, directory: testApp.directory };
  await testApp.stop(false);
  testApp = await startTestApp([target.port], saved);

  const response = await requestViaProxy(route.proxyUrls.http.replace(/:\d+$/, `:${testApp.application.forwardAddress.port}`), target.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-mock-endpoint-id"], endpointId);
  assert.equal((await testApp.application.routes.get(route.route.id)).customerId, "test-customer");
  assert.equal((await testApp.application.routes.get(route.route.id)).userId, "local-dev");
  assert.deepEqual((await testApp.application.routes.get(route.route.id)).allowedProtocols, ["http", "https", "socks5"]);
  const socks5Url = route.proxyUrls.socks5.replace(/:\d+$/, `:${testApp.application.socks5Address.port}`);
  assert.equal(await socks5AuthenticationStatus(socks5Url), 0x00);
});

test("provider authentication, rate limiting, and unavailable peers are normalized", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "failures",
    targeting: { country: "US" },
  });
  await testApp.simulators.setFailure("bright-data", "auth");
  const authentication = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(authentication.status, 502);
  assert.doesNotMatch(authentication.body, /mock-bright-password/);

  await testApp.simulators.setFailure("bright-data", "rate_limit");
  const rateLimit = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(rateLimit.status, 429);
  assert.match(rateLimit.body, /Rate limited/);

  await testApp.simulators.setFailure("bright-data", "unavailable");
  const unavailable = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(unavailable.status, 502);

  await testApp.simulators.setFailure("bright-data", "timeout");
  const timeout = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(timeout.status, 503);
  await testApp.simulators.setFailure("bright-data", null);
});

test("structured logs redact credentials, cookies, authorization, and URL queries", () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  logger.info("redaction", {
    authorization: "Bearer secret",
    password: "provider-password",
    routeToken: "route-token-secret",
    cookie: "session=secret",
    proxyUrl: "http://user:token@proxy",
    target: new URL("https://example.test/path?secret=value"),
    destination: "https://embedded-user:embedded-password@example.test/other?embedded=secret#fragment",
  });
  const output = lines.join("\n");
  assert.doesNotMatch(
    output,
    /Bearer secret|provider-password|route-token-secret|session=secret|user:token|secret=value|embedded-user|embedded-password|embedded=secret|fragment/,
  );
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /https:\/\/example\.test\/path/);
  assert.match(output, /https:\/\/example\.test\/other/);
});

test("OpenTelemetry mode keeps console output as an error-only fallback", () => {
  const lines: string[] = [];
  const logger = createLogger({
    write: (line) => lines.push(line),
    consoleMode: "errors",
  });
  logger.info("exported through OTLP");
  logger.warn("also exported through OTLP");
  logger.error("bootstrap fallback", { token: "secret" });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /bootstrap fallback/);
  assert.doesNotMatch(lines[0] ?? "", /secret/);
});

test("data-plane attempt logs include attribution and byte counts without request content", async (t) => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port], undefined, logger);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "telemetry",
    targeting: { country: "US" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  const response = await requestViaProxy(route.proxyUrls.http, target.url, {
    method: "POST",
    headers: { authorization: "Bearer target-secret", cookie: "session=secret-cookie" },
    body: "sensitive-request-content",
  });
  assert.equal(response.status, 200);
  const output = lines.join("\n");
  assert.match(output, /test-customer|local-dev|bytesSent|bytesReceived|upstreamAttemptId/);
  assert.match(output, /candidateId|assignmentMode|providerManagedReassignmentDisabled|changeReason/);
  assert.doesNotMatch(output, /target-secret|secret-cookie|sensitive-request-content|query-value|mock-bright-password/);
});
