import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/logger.js";
import { sessionRoutingTelemetryAttributes, sessionRoutingUsageContext, type ResolutionState } from "../src/route-service.js";
import { createRoute, requestViaProxy, socks5AuthenticationStatus, startHttpTarget, startTestApp } from "./helpers.js";

test("managed access-grant credentials, logical sessions, affinity, and route requirements survive a service restart", async (t) => {
  const target = await startHttpTarget();
  let testApp = await startTestApp([target.port]);
  t.after(async () => {
    await target.stop();
    await testApp.stop();
  });
  const route = await createRoute(
    testApp.application,
    {
      name: "persistent",
      customerId: "customer-persistent",
      targeting: { country: "US", region: "CA", city: "Los Angeles", carrier: "AT&T" },
    },
    "managed",
  );
  const before = await requestViaProxy(route.proxyUrls.http, target.url);
  const city = before.headers["x-mock-city"];
  const candidate = before.headers["x-mock-endpoint-id"];
  assert.ok(route.credential.sessionId);
  const saved = { storeState: testApp.storeState };
  await testApp.stop();
  testApp = await startTestApp([target.port], saved);

  const restartedHttpProxy = new URL(route.proxyUrls.http);
  restartedHttpProxy.port = String(testApp.application.forwardAddress.port);
  const response = await requestViaProxy(restartedHttpProxy.toString(), target.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-mock-city"], city);
  assert.equal(response.headers["x-mock-endpoint-id"], candidate);
  const persisted = await testApp.application.routes.get(route.profile.id, "local-dev");
  assert.equal(persisted.customerId, "customer-persistent");
  assert.equal(route.credential.sessionMode, "managed");
  assert.deepEqual(persisted.geography, { countryCode: "US", regionCode: "CA", city: "Los Angeles" });
  const persistedSession = await testApp.application.routes.getLogicalSession(
    route.accessGrant.id,
    route.credential.sessionId,
    "local-dev",
  );
  assert.equal(persistedSession.sessionId, route.credential.sessionId);
  assert.ok(persistedSession.lastUsedAt);
  const restartedSocks5Proxy = new URL(route.proxyUrls.socks5);
  restartedSocks5Proxy.port = String(testApp.application.socks5Address.port);
  assert.equal(await socks5AuthenticationStatus(restartedSocks5Proxy.toString()), 0x00);
});

test("managed session routing emits provider-neutral affinity, rebind, degradation, and failback telemetry", () => {
  const state: ResolutionState = {
    attemptsByProvider: new Map(),
    excludedEndpointIds: new Set(),
    establishmentWaitMs: 0,
    sessionRebindRetries: 0,
    sessionAffinityHit: true,
    sessionRebindCause: "binding_ineligible",
    desiredProviderClass: "device_backed",
    currentProviderClass: "residential",
    degradedFallback: true,
    failbackOutcome: "not_attempted",
  };
  assert.deepEqual(sessionRoutingUsageContext(state), {
    sessionAffinityHit: true,
    sessionRebindCause: "binding_ineligible",
    desiredProviderClass: "device_backed",
    currentProviderClass: "residential",
    degradedFallback: true,
    failbackOutcome: "not_attempted",
  });
  assert.deepEqual(sessionRoutingTelemetryAttributes(state), {
    "proxy.session.affinity_hit": true,
    "proxy.session.rebind_cause": "binding_ineligible",
    "proxy.session.desired_provider_class": "device_backed",
    "proxy.session.current_provider_class": "residential",
    "proxy.session.degraded_fallback": true,
    "proxy.session.failback_outcome": "not_attempted",
  });
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
  const simulator = testApp.application.simulators?.brightData;
  assert.ok(simulator);

  simulator.setFailure("auth");
  const authentication = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(authentication.status, 502);
  assert.doesNotMatch(authentication.body, /mock-bright-password/);

  simulator.setFailure("rate_limit");
  const rateLimit = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(rateLimit.status, 429);
  assert.match(rateLimit.body, /Rate limited/);

  simulator.setFailure("unavailable");
  const unavailable = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(unavailable.status, 502);

  simulator.setFailure("timeout");
  const timeout = await requestViaProxy(route.proxyUrls.http, target.url);
  assert.equal(timeout.status, 503);
  simulator.setFailure(null);
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
    error: new Error("request to https://error-user:error-password@example.test/failure?token=secret failed; token=another-secret"),
  });
  const output = lines.join("\n");
  assert.doesNotMatch(
    output,
    /Bearer secret|provider-password|route-token-secret|session=secret|user:token|secret=value|embedded-user|embedded-password|embedded=secret|fragment/,
  );
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /https:\/\/example\.test\/path/);
  assert.match(output, /https:\/\/example\.test\/other/);
  assert.match(output, /Error|failure/);
  assert.doesNotMatch(output, /error-user|error-password|another-secret/);
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
    sessionMode: "none",
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
