import assert from "node:assert/strict";
import {
  awsJson,
  controlRequest,
  createRoute,
  deployedEnvironment,
  deployedTest,
  proxyWithCredentials,
  requestViaHttpProxy,
  revokeRoute,
} from "./helpers.js";

deployedTest("deployed SST metadata identifies a mock integration stage with a controlled target", async () => {
  const { metadata } = await deployedEnvironment();
  assert.equal(metadata.providerMode, "mock", "the deterministic comprehensive suite requires PROVIDER_MODE=mock");
  assert.ok(metadata.integrationTarget, "redeploy the stage with DEPLOY_INTEGRATION_TARGET=true");
  assert.notEqual(metadata.productVpcId, metadata.canaryVpcId);
});

deployedTest("deployed control plane exposes liveness, readiness, OpenAPI, providers, and health", async () => {
  const live = await controlRequest("/health/live", {}, null);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "live" });

  const ready = await controlRequest("/health/ready", {}, null);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  const openapi = await controlRequest("/openapi.json", {}, null);
  assert.equal(openapi.status, 200);
  const contract = await openapi.json() as { openapi?: string; paths?: Record<string, unknown>; components?: unknown };
  assert.match(contract.openapi ?? "", /^3\./);
  for (const path of ["/v1/routes", "/v1/routes/{id}", "/v1/routes/{id}/rotate", "/v1/providers", "/v1/providers/health"]) {
    assert.ok(contract.paths?.[path], `OpenAPI is missing ${path}`);
  }

  const providers = await controlRequest("/v1/providers");
  assert.equal(providers.status, 200);
  const descriptors = (await providers.json() as { data: Array<Record<string, unknown>> }).data;
  assert.deepEqual(descriptors.map(({ id }) => id).sort(), ["bright_data", "proxidize"]);
  const serialized = JSON.stringify(descriptors);
  for (const capability of ["clientProtocols", "geography", "sessions", "exactCity", "rotation", "dnsResolution", "pricing", "usageDimensions"]) {
    assert.match(serialized, new RegExp(capability));
  }

  const health = await controlRequest("/v1/providers/health");
  assert.equal(health.status, 200);
  const providerHealth = (await health.json() as { data: Array<{ provider: string; state: string }> }).data;
  assert.deepEqual(providerHealth.map(({ provider }) => provider).sort(), ["bright_data", "proxidize"]);
  assert.ok(providerHealth.every(({ state }) => state === "healthy"));
});

deployedTest("deployed route management rejects untrusted and malformed requests", async () => {
  const unauthorized = await controlRequest("/v1/routes", {}, null);
  assert.equal(unauthorized.status, 401);

  const malformedCases: unknown[] = [
    {
      name: "missing-required-booleans",
      customerId: "customer",
      targeting: { country: "US" },
    },
    {
      name: "authenticated-without-city",
      customerId: "customer",
      targeting: { country: "US" },
      isAuthenticated: true,
      shouldRetry: false,
    },
    {
      name: "bad-interval",
      customerId: "customer",
      targeting: { country: "US" },
      isAuthenticated: false,
      shouldRetry: false,
      rotation: { mode: "interval", intervalSeconds: 59 },
    },
    {
      name: "bad-zip",
      customerId: "customer",
      targeting: { country: "CA", postalCode: "10001" },
      isAuthenticated: false,
      shouldRetry: false,
    },
    {
      name: "bad-retries",
      customerId: "customer",
      targeting: { country: "US" },
      isAuthenticated: false,
      shouldRetry: true,
      retryPolicy: { maxAttempts: 7 },
    },
  ];
  for (const payload of malformedCases) {
    const response = await controlRequest("/v1/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400, `${JSON.stringify(payload)} should be rejected`);
  }
});

deployedTest("deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles", async (t) => {
  const environment = await deployedEnvironment();
  const target = environment.metadata.integrationTarget;
  assert.ok(target);
  const route = await createRoute({
    name: `credential-lifecycle-${Date.now()}`,
    targeting: { country: "US" },
    customerId: "integration-customer",
    isAuthenticated: false,
    shouldRetry: false,
  });
  t.after(async () => {
    await revokeRoute(route.route.id).catch(() => undefined);
  });
  const issued = new URL(route.proxyUrls.http);
  const token = decodeURIComponent(issued.password);
  assert.equal(decodeURIComponent(issued.username), route.accessGrant.id);
  assert.equal(route.proxyUsername, route.accessGrant.id);
  assert.equal(route.accessGrant.routeId, route.route.id);
  assert.equal(route.credential.status, "active");
  assert.equal(Date.parse(route.credential.expiresAt) - Date.parse(route.credential.createdAt), 30 * 24 * 60 * 60_000);
  assert.equal(Date.parse(route.credential.expiresAt) - Date.parse(route.credential.renewalDueAt), 7 * 24 * 60 * 60_000);
  assert.ok(token.length >= 32);
  assert.equal(route.route.userId, process.env.DEPLOYED_EXPECTED_USER_ID?.trim() || `sst:${environment.stage}`);
  assert.equal(route.route.customerId, "integration-customer");
  assert.equal(route.route.provider, "bright_data");
  assert.deepEqual(route.route.allowedProtocols, ["http", "https", "socks5"]);

  const detail = await controlRequest(`/v1/routes/${route.route.id}`);
  assert.equal(detail.status, 200);
  const detailText = await detail.text();
  assert.doesNotMatch(detailText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(detailText, /proxyUrl|proxyPassword|tokenHash|tokenSalt|endpointId|password/i);

  const list = await controlRequest("/v1/routes");
  assert.equal(list.status, 200);
  assert.doesNotMatch(await list.text(), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const immutable = await controlRequest(`/v1/routes/${route.route.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targeting: { country: "CA" } }),
  });
  assert.ok(immutable.status === 404 || immutable.status === 405);

  const stored = await awsJson<Record<string, unknown>>([
    "dynamodb",
    "get-item",
    "--table-name",
    environment.metadata.routeTable,
    "--consistent-read",
    "--key",
    JSON.stringify({ pk: { S: `ROUTE#${route.route.id}` }, sk: { S: "STATE" } }),
  ], environment.region);
  const storedText = JSON.stringify(stored);
  assert.doesNotMatch(storedText, /tokenHash|tokenSalt/);
  assert.doesNotMatch(storedText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const storedGrant = await awsJson<Record<string, unknown>>([
    "dynamodb",
    "get-item",
    "--table-name",
    environment.metadata.routeTable,
    "--consistent-read",
    "--key",
    JSON.stringify({ pk: { S: `ACCESS_GRANT#${route.accessGrant.id}` }, sk: { S: "STATE" } }),
  ], environment.region);
  const storedGrantText = JSON.stringify(storedGrant);
  assert.match(storedGrantText, /tokenHash|tokenSalt/);
  assert.doesNotMatch(storedGrantText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const secondResponse = await controlRequest(`/v1/routes/${route.route.id}/access-grants`, { method: "POST" });
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json() as import("./helpers.js").IssuedAccessGrantResponse;
  assert.notEqual(second.accessGrant.id, route.accessGrant.id);
  assert.equal(second.accessGrant.principalId, route.accessGrant.principalId);

  const before = await requestViaHttpProxy(route.proxyUrls.http, new URL("/lifecycle", target.url).toString());
  assert.equal(before.status, 200);
  const rotationResponse = await controlRequest(
    `/v1/access-grants/${route.accessGrant.id}/credentials/rotate`,
    { method: "POST" },
  );
  assert.equal(rotationResponse.status, 200);
  const rotated = await rotationResponse.json() as import("./helpers.js").IssuedAccessGrantResponse;
  assert.equal(rotated.accessGrant.credentials[0]?.status, "overlap");
  assert.equal((await requestViaHttpProxy(route.proxyUrls.http, new URL("/lifecycle", target.url).toString())).status, 200);
  assert.equal((await requestViaHttpProxy(rotated.proxyUrls.http, new URL("/lifecycle", target.url).toString())).status, 200);

  const emergencyRotationResponse = await controlRequest(
    `/v1/access-grants/${route.accessGrant.id}/credentials/emergency-rotate`,
    { method: "POST" },
  );
  assert.equal(emergencyRotationResponse.status, 200);
  const emergency = await emergencyRotationResponse.json() as import("./helpers.js").IssuedAccessGrantResponse;
  assert.equal((await requestViaHttpProxy(route.proxyUrls.http, new URL("/lifecycle", target.url).toString())).status, 407);
  assert.equal((await requestViaHttpProxy(rotated.proxyUrls.http, new URL("/lifecycle", target.url).toString())).status, 407);
  assert.equal((await requestViaHttpProxy(emergency.proxyUrls.http, new URL("/lifecycle", target.url).toString())).status, 200);

  const revoke = await controlRequest(`/v1/access-grants/${route.accessGrant.id}`, { method: "DELETE" });
  assert.equal(revoke.status, 204);
  assert.equal((await controlRequest(`/v1/access-grants/${route.accessGrant.id}`, { method: "DELETE" })).status, 204);
  const revoked = await requestViaHttpProxy(emergency.proxyUrls.http, new URL("/lifecycle", target.url).toString());
  assert.equal(revoked.status, 407);
  assert.equal((await requestViaHttpProxy(second.proxyUrls.http, new URL("/lifecycle", target.url).toString())).status, 200);

  const wrong = await requestViaHttpProxy(
    proxyWithCredentials(route.proxyUrls.http, route.accessGrant.id, "wrong-route-secret"),
    new URL("/lifecycle", target.url).toString(),
  );
  assert.equal(wrong.status, 407);
});
