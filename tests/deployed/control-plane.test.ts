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
  type PublicRoute,
} from "./helpers.js";

deployedTest("deployed SST metadata identifies a mock non-production stage with a controlled serverless target", async () => {
  const { stage, metadata } = await deployedEnvironment();
  assert.equal(metadata.providerMode, "mock", "the deterministic comprehensive suite requires PROVIDER_MODE=mock");
  assert.ok(metadata.integrationTarget, "deployed integration tests are forbidden against production stages");
  assert.equal(metadata.integrationTarget.compute, "lambda");
  assert.equal(metadata.integrationTarget.api, "api-gateway-v2");
  assert.equal(metadata.integrationTransportTarget !== null, stage === "ci" || stage.startsWith("ci-"));
  assert.notEqual(metadata.productVpcId, metadata.canaryVpcId);
});

deployedTest("deployed control plane exposes provider-neutral liveness, readiness, and OpenAPI", async () => {
  const live = await controlRequest("/health/live", {}, null);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "live" });

  const ready = await controlRequest("/health/ready", {}, null);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  const openapi = await controlRequest("/openapi.json", {}, null);
  assert.equal(openapi.status, 200);
  const contract = (await openapi.json()) as { openapi?: string; paths?: Record<string, unknown>; components?: unknown };
  assert.match(contract.openapi ?? "", /^3\./);
  for (const path of ["/v1/profiles", "/v1/profiles/{id}", "/v1/profiles/{id}/grants", "/v1/grants/{grantId}"]) {
    assert.ok(contract.paths?.[path], `OpenAPI is missing ${path}`);
  }
  assert.equal(contract.paths?.["/v1/providers"], undefined);
  assert.equal(contract.paths?.["/v1/providers/health"], undefined);
});

deployedTest("deployed route management rejects untrusted and malformed requests", async () => {
  const unauthorized = await controlRequest("/v1/profiles", {}, null);
  assert.equal(unauthorized.status, 401);

  const malformedCases: unknown[] = [
    {
      customerId: "customer",
      geography: { countryCode: "US" },
    },
    {
      customerId: "customer",
      geography: { countryCode: "US" },
      isTargetAuthenticated: true,
      allowConnectionRetry: false,
    },
    {
      customerId: "customer",
      geography: { countryCode: "USA" },
      isTargetAuthenticated: false,
      allowConnectionRetry: false,
    },
    {
      customerId: "customer",
      geography: { countryCode: "US" },
      isTargetAuthenticated: false,
      allowConnectionRetry: false,
      rotation: { mode: "interval", intervalSeconds: 59 },
    },
  ];
  for (const payload of malformedCases) {
    const response = await controlRequest("/v1/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400, `${JSON.stringify(payload)} should be rejected`);
  }
});

deployedTest(
  "deployed access grants are principal-scoped, one-time, independently revocable, and absent from route profiles",
  async (t) => {
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
      await revokeRoute(route.profile.id).catch(() => undefined);
    });
    const issued = new URL(route.proxyUrls.http);
    const token = decodeURIComponent(issued.password);
    assert.equal(decodeURIComponent(issued.username), route.credential.username);
    assert.equal(route.proxyUsername, route.credential.username);
    assert.notEqual(route.proxyUsername, route.accessGrant.id);
    assert.equal(route.accessGrant.routeId, route.profile.id);
    assert.equal(route.credential.status, "active");
    assert.equal(Date.parse(route.credential.expiresAt) - Date.parse(route.credential.createdAt), 30 * 24 * 60 * 60_000);
    assert.equal(Date.parse(route.credential.expiresAt) - Date.parse(route.credential.renewalDueAt), 7 * 24 * 60 * 60_000);
    assert.ok(token.length >= 32);
    assert.equal(route.profile.customerId, "integration-customer");
    assert.deepEqual(route.profile.geography, { countryCode: "US" });
    assert.equal(route.profile.isTargetAuthenticated, false);

    const detail = await controlRequest(`/v1/profiles/${route.profile.id}`);
    assert.equal(detail.status, 200);
    const detailText = await detail.text();
    assert.doesNotMatch(detailText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(detailText, /proxyUrl|proxyPassword|tokenHash|tokenSalt|endpointId|password/i);

    const list = await controlRequest("/v1/profiles");
    assert.equal(list.status, 200);
    assert.doesNotMatch(await list.text(), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const updated = await controlRequest(`/v1/profiles/${route.profile.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId: "integration-customer",
        geography: { countryCode: "CA" },
        isTargetAuthenticated: false,
        allowConnectionRetry: true,
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as { profile: PublicRoute }).profile.geography?.countryCode, "CA");

    const stored = await awsJson<Record<string, unknown>>(
      [
        "dynamodb",
        "get-item",
        "--table-name",
        environment.metadata.routeTable,
        "--consistent-read",
        "--key",
        JSON.stringify({ pk: { S: `ROUTE#${route.profile.id}` }, sk: { S: "STATE" } }),
      ],
      environment.region,
    );
    const storedText = JSON.stringify(stored);
    assert.doesNotMatch(storedText, /tokenHash|tokenSalt/);
    assert.doesNotMatch(storedText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const storedGrant = await awsJson<Record<string, unknown>>(
      [
        "dynamodb",
        "get-item",
        "--table-name",
        environment.metadata.routeTable,
        "--consistent-read",
        "--key",
        JSON.stringify({ pk: { S: `ACCESS_GRANT#${route.accessGrant.id}` }, sk: { S: "STATE" } }),
      ],
      environment.region,
    );
    const storedGrantText = JSON.stringify(storedGrant);
    assert.match(storedGrantText, /tokenHash|tokenSalt/);
    assert.doesNotMatch(storedGrantText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const secondResponse = await controlRequest(`/v1/profiles/${route.profile.id}/grants`, { method: "POST" });
    assert.equal(secondResponse.status, 201);
    const second = (await secondResponse.json()) as import("./helpers.js").IssuedAccessGrantResponse;
    assert.notEqual(second.grant.grantId, route.accessGrant.id);

    const before = await requestViaHttpProxy(route.proxyUrls.http, new URL("/lifecycle", target.url).toString());
    assert.equal(before.status, 200);
    const rotationResponse = await controlRequest(`/v1/grants/${route.accessGrant.id}/credentials/rotate`, { method: "POST" });
    assert.equal(rotationResponse.status, 200);
    const rotated = (await rotationResponse.json()) as import("./helpers.js").IssuedAccessGrantResponse;
    assert.equal(rotated.grant.credentials[0]?.status, "overlap");
    assert.equal((await requestViaHttpProxy(route.proxyUrls.http, new URL("/lifecycle", target.url).toString())).status, 200);
    const rotatedProxy = proxyWithCredentials(rotated.endpoints.http, rotated.credential.username, rotated.credential.password);
    assert.equal((await requestViaHttpProxy(rotatedProxy, new URL("/lifecycle", target.url).toString())).status, 200);

    const emergencyRotationResponse = await controlRequest(`/v1/grants/${route.accessGrant.id}/credentials/emergency-rotate`, {
      method: "POST",
    });
    assert.equal(emergencyRotationResponse.status, 200);
    const emergency = (await emergencyRotationResponse.json()) as import("./helpers.js").IssuedAccessGrantResponse;
    const emergencyProxy = proxyWithCredentials(emergency.endpoints.http, emergency.credential.username, emergency.credential.password);
    assert.equal((await requestViaHttpProxy(route.proxyUrls.http, new URL("/lifecycle", target.url).toString())).status, 407);
    assert.equal((await requestViaHttpProxy(rotatedProxy, new URL("/lifecycle", target.url).toString())).status, 407);
    assert.equal((await requestViaHttpProxy(emergencyProxy, new URL("/lifecycle", target.url).toString())).status, 200);

    const revoke = await controlRequest(`/v1/grants/${route.accessGrant.id}`, { method: "DELETE" });
    assert.equal(revoke.status, 204);
    assert.equal((await controlRequest(`/v1/grants/${route.accessGrant.id}`, { method: "DELETE" })).status, 204);
    const revoked = await requestViaHttpProxy(emergencyProxy, new URL("/lifecycle", target.url).toString());
    assert.equal(revoked.status, 407);
    const secondProxy = proxyWithCredentials(second.endpoints.http, second.credential.username, second.credential.password);
    assert.equal((await requestViaHttpProxy(secondProxy, new URL("/lifecycle", target.url).toString())).status, 200);

    const wrong = await requestViaHttpProxy(
      proxyWithCredentials(route.proxyUrls.http, route.proxyUsername, "wrong-route-secret"),
      new URL("/lifecycle", target.url).toString(),
    );
    assert.equal(wrong.status, 407);
  },
);
