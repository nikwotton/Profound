import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenApi } from "@effect/platform";
import { loadConfig } from "../src/config.js";
import { ControlApi } from "../src/control-contract.js";
import { assertSafeProviderResolution, destinationSafetyClassification } from "../src/destination-resolution.js";
import { parseHostPort } from "../src/net-utils.js";
import { BrightDataAdapter, buildBrightDataUsername } from "../src/providers/bright-data.js";
import { ROUTING_POLICY } from "../src/routing-policy.js";
import {
  ACCOUNTING_POLICY,
  CREDENTIAL_LIFECYCLE_POLICY,
  HEALTH_POLICY,
  OBSERVABILITY_POLICY,
  TRANSPORT_POLICY,
} from "../src/service-policies.js";
import { createTargetValidator, isPublicAddress } from "../src/target-security.js";
import type { StoredRoute } from "../src/types.js";
import { validateRouteProfile } from "../src/validation.js";

function route(overrides: Partial<StoredRoute> = {}): StoredRoute {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "residential",
    allowedProtocols: ["http", "https", "socks5"],
    targeting: { country: "US", region: "NY", city: "New York", postalCode: "10001", asn: 12_345, carrier: "T-Mobile" },
    rotation: { mode: "per_request" },
    customerId: "customer",
    geography: { countryCode: "US", regionCode: "NY", city: "New York" },
    carrier: "T-Mobile",
    allowConnectionRetry: false,
    userId: "user",
    shouldRetry: false,
    retryPolicy: { maxAttempts: 2 },
    provider: "bright_data",
    status: "ready",
    rotationEpoch: 0,
    lastRotationAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    terminateActive: overrides.terminateActive ?? false,
  };
}

function validate(value: Record<string, unknown>) {
  return validateRouteProfile(
    {
      customerId: "customer",
      allowConnectionRetry: false,
      ...value,
    },
    "user",
    { maxAttempts: 2 },
  );
}

const sstRuntime = { ROUTE_TABLE_NAME: "route-state" } as const;

test("control API token defaults only for local mock mode", () => {
  const local = loadConfig({
    ...sstRuntime,
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "127.0.0.1",
  });
  assert.equal(local.adminToken, "change-me");
  assert.equal(local.proxidizeExactCity, "provider_guaranteed");
  assert.equal(local.streamBufferBytes, 64 * 1024);
  assert.deepEqual([...local.blockedTargetHostnames], []);

  const transportPolicy = loadConfig({
    ...sstRuntime,
    PROVIDER_MODE: "mock",
    STREAM_BUFFER_BYTES: "16384",
    BLOCKED_TARGET_HOSTNAMES: "Internal.Example.,metadata.internal",
  });
  assert.equal(transportPolicy.streamBufferBytes, 16_384);
  assert.deepEqual([...transportPolicy.blockedTargetHostnames], ["internal.example", "metadata.internal"]);

  assert.throws(
    () =>
      loadConfig({
        ...sstRuntime,
        PROVIDER_MODE: "mock",
        CONTROL_API_HOST: "0.0.0.0",
      }),
    /CONTROL_API_TOKEN must be set/,
  );

  assert.throws(
    () =>
      loadConfig({
        ...sstRuntime,
        PROVIDER_MODE: "live",
        CONTROL_API_HOST: "127.0.0.1",
        BRIGHT_DATA_CUSTOMER_ID: "customer",
        BRIGHT_DATA_ZONE: "zone",
        BRIGHT_DATA_PASSWORD: "password",
        BRIGHT_DATA_API_KEY: "api-key",
        PROXIDIZE_API_TOKEN: "provider-token",
      }),
    /CONTROL_API_TOKEN must be set/,
  );

  const shared = loadConfig({
    ...sstRuntime,
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "0.0.0.0",
    CONTROL_API_TOKEN: "local-network-secret",
  });
  assert.equal(shared.adminToken, "local-network-secret");

  const live = loadConfig({
    ...sstRuntime,
    PROVIDER_MODE: "live",
    CONTROL_API_TOKEN: "strong-token",
    BRIGHT_DATA_CUSTOMER_ID: "customer",
    BRIGHT_DATA_ZONE: "zone",
    BRIGHT_DATA_PASSWORD: "password",
    BRIGHT_DATA_API_KEY: "api-key",
    PROXIDIZE_API_TOKEN: "provider-token",
  });
  assert.equal(live.proxidizeExactCity, "verifiable");

  assert.equal(
    loadConfig({
      ...sstRuntime,
      PROVIDER_MODE: "mock",
      PROXIDIZE_EXACT_CITY_SUPPORT: "verifiable",
    }).proxidizeExactCity,
    "verifiable",
  );

  assert.throws(
    () =>
      loadConfig({
        ...sstRuntime,
        PROVIDER_MODE: "mock",
        CONNECT_TIMEOUT_MS: "10001",
      }),
    /CONNECT_TIMEOUT_MS/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...sstRuntime,
        PROVIDER_MODE: "mock",
        OPERATION_TIMEOUT_MS: "30001",
      }),
    /OPERATION_TIMEOUT_MS/,
  );

  const identities = loadConfig({
    ...sstRuntime,
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "0.0.0.0",
    CONTROL_API_IDENTITIES_JSON: JSON.stringify({ tokenOne: "user-one", tokenTwo: "user-two" }),
  });
  assert.equal(identities.controlIdentities.get("tokenTwo"), "user-two");
});

test("provisional operational values are typed, versioned policies", () => {
  for (const policy of [
    ROUTING_POLICY,
    ACCOUNTING_POLICY,
    CREDENTIAL_LIFECYCLE_POLICY,
    HEALTH_POLICY,
    OBSERVABILITY_POLICY,
    TRANSPORT_POLICY,
  ]) {
    assert.match(policy.version, /v0|hypotheses/);
    assert.equal(policy.lastValidatedAt, "2026-07-18");
  }
  assert.deepEqual(
    {
      candidates: ROUTING_POLICY.maxCandidatesPerProvider,
      exactCityCandidates: ROUTING_POLICY.maxExactCityCandidatesPerProvider,
      providers: ROUTING_POLICY.maxProvidersPerOperation,
      attemptMs: ROUTING_POLICY.attemptEstablishmentTimeoutMs,
      operationMs: ROUTING_POLICY.operationEstablishmentTimeoutMs,
      circuitMs: ROUTING_POLICY.capacityCircuitBaseCooldownMs,
      stabilizationMs: ROUTING_POLICY.preferredClassStabilizationMs,
      quiescenceMs: ROUTING_POLICY.sessionQuiescenceMs,
    },
    {
      candidates: 2,
      exactCityCandidates: 3,
      providers: 3,
      attemptMs: 10_000,
      operationMs: 30_000,
      circuitMs: 60_000,
      stabilizationMs: 300_000,
      quiescenceMs: 30_000,
    },
  );
  assert.equal(CREDENTIAL_LIFECYCLE_POLICY.lifetimeMs, 30 * 24 * 60 * 60_000);
  assert.equal(CREDENTIAL_LIFECYCLE_POLICY.renewalWindowMs, 7 * 24 * 60 * 60_000);
  assert.equal(CREDENTIAL_LIFECYCLE_POLICY.overlapMs, 72 * 60 * 60_000);
  assert.equal(ACCOUNTING_POLICY.reconciliationCadence, "daily");
  assert.equal(ACCOUNTING_POLICY.varianceWarningRelative, 0.05);
  assert.equal(ACCOUNTING_POLICY.varianceErrorRelative, 0.15);
  assert.equal(OBSERVABILITY_POLICY.traceSampling, "all");
  assert.equal(OBSERVABILITY_POLICY.logRetentionDays, 30);
  assert.equal(HEALTH_POLICY.syntheticCooldownMs, 300_000);
  assert.equal(HEALTH_POLICY.geoIpRefreshIntervalMs, 302_400_000);
  assert.equal(HEALTH_POLICY.degradedPersistenceMs, 300_000);
  assert.equal(TRANSPORT_POLICY.streamBufferBytes, 64 * 1024);
  assert.equal(TRANSPORT_POLICY.maxHeaderBytes, 32 * 1024);
});

test("SST runtime configuration requires its DynamoDB table", () => {
  assert.throws(
    () =>
      loadConfig({
        PROVIDER_MODE: "mock",
      }),
    /ROUTE_TABLE_NAME is required/,
  );
  const config = loadConfig({
    ...sstRuntime,
    PROVIDER_MODE: "mock",
  });
  assert.equal(config.routeTableName, "route-state");
  assert.throws(
    () =>
      loadConfig({
        ...sstRuntime,
        PROVIDER_MODE: "mock",
        ADVERTISED_HTTP_PROXY_PROTOCOL: "ftp",
      }),
    /ADVERTISED_HTTP_PROXY_PROTOCOL must be http or https/,
  );
});

test("profile validation accepts only stable requirements and derives routing behavior", () => {
  const residential = validate({
    geography: { countryCode: "us" },
  });
  assert.deepEqual(residential.rotation, { mode: "per_request" });
  assert.deepEqual(residential.allowedProtocols, ["http", "https", "socks5"]);
  assert.equal(residential.targeting.country, "US");

  const cityTargeted = validate({
    geography: { countryCode: "US", regionCode: "NY", city: "New York" },
  });
  assert.deepEqual(cityTargeted.rotation, { mode: "per_request" });
  assert.equal(cityTargeted.allowConnectionRetry, false);

  const overridden = validate({ providerOverride: "bright_data" });
  assert.equal(overridden.providerOverride, "bright_data");
  assert.throws(() => validate({ providerOverride: null }), /providerOverride must be bright_data or proxidize/);
  assert.throws(() => validate({ providerOverride: "unknown" }), /providerOverride must be bright_data or proxidize/);
});

test("profile validation enforces geography hierarchy and rejects every non-canonical field", () => {
  assert.throws(
    () => validate({ kind: "mobile", geography: { countryCode: "US", city: "New York" } }),
    /profile.kind is not part of the profile contract/,
  );
  assert.throws(() => validate({ geography: { regionCode: "NY" } }), /require geography.countryCode/);
  for (const field of ["name", "allowedProtocols", "targeting", "rotation", "session", "retryPolicy", "forceProvider"]) {
    assert.throws(() => validate({ [field]: {} }), new RegExp(`profile\\.${field} is not part of the profile contract`));
  }
  assert.throws(
    () => validate({ geography: { countryCode: "US", postalCode: "10001" } }),
    /geography.postalCode is not part of the profile contract/,
  );
});

test("Bright Data credentials encode targeting and pin each per-request candidate to a unique constant session", () => {
  const prefix = "brd-customer-customer1-zone-zone1-country-us-state-ny-city-newyork-zip-10001-asn-12345-carrier-tmobile";
  const username = buildBrightDataUsername({ customerId: "customer-1", zone: "zone-1" }, route(), 1, {
    logicalOperationId: "operation-1",
    candidateIndex: 0,
  });
  const next = buildBrightDataUsername({ customerId: "customer-1", zone: "zone-1" }, route(), 1, {
    logicalOperationId: "operation-2",
    candidateIndex: 0,
  });
  assert.match(username, new RegExp(`^${prefix}-session-[a-f0-9]{20}$`));
  assert.notEqual(username, next);
});

test("Bright Data managed sessions preserve one provider affinity handle until explicit rebinding", () => {
  const managed = route();
  const first = buildBrightDataUsername({ customerId: "c", zone: "z" }, managed, 120_001, {
    sessionMode: "managed",
    affinityHandle: "logical-session",
  });
  const second = buildBrightDataUsername({ customerId: "c", zone: "z" }, managed, 180_000, {
    sessionMode: "managed",
    affinityHandle: "logical-session",
  });
  const third = buildBrightDataUsername({ customerId: "c", zone: "z" }, managed, 180_000, {
    sessionMode: "managed",
    affinityHandle: "replacement-session",
  });
  assert.equal(first, second);
  assert.notEqual(first, third);
});

test("Bright Data health uses the authenticated residential network-status API when configured", async () => {
  const requested: Array<{ url: string; authorization?: string }> = [];
  const adapter = new BrightDataAdapter({
    host: "unused.example",
    port: 33_335,
    customerId: "customer",
    zone: "zone",
    password: "password",
    connectTimeoutMs: 1_000,
    statusApiUrl: "https://api.brightdata.com/network_status/res",
    apiKey: "api-key",
    fetchImplementation: async (input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push({ url, ...(authorization === undefined ? {} : { authorization }) });
      return Response.json({ status: true });
    },
  });
  assert.equal((await adapter.health()).state, "healthy");
  assert.deepEqual(requested, [
    {
      url: "https://api.brightdata.com/network_status/res",
      authorization: "Bearer api-key",
    },
  ]);
});

test("literal target validation blocks explicit private, metadata, and reserved addresses without using local DNS for routing", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "198.51.100.1",
    "::1",
    "64:ff9b:1::1",
    "100:0:0:1::1",
    "2001:10::1",
    "3fff::1",
    "4000::1",
    "fc00::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  const validate = createTargetValidator(new Set([80, 443]), async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]);
  const diagnostic = await validate("mixed.example", 443);
  assert.deepEqual(await diagnostic?.localResolution, {
    status: "available",
    addresses: ["10.0.0.1", "8.8.8.8"],
  });
  assert.throws(() => validate("169.254.169.254", 80), /public Internet/);
  assert.throws(() => validate("public.example", 8080), /port is not allowed/);

  const unavailable = await createTargetValidator(new Set([443]), () => {
    throw new Error("local DNS unavailable");
  })("public.example", 443);
  assert.deepEqual(await unavailable?.localResolution, { status: "unavailable", addresses: [] });
});

test("destination safety is verified with provider evidence and provider-trusted when DNS is opaque", () => {
  assert.doesNotThrow(() => assertSafeProviderResolution(undefined));
  assert.doesNotThrow(() => assertSafeProviderResolution({}));
  assert.doesNotThrow(() => assertSafeProviderResolution({ resolvedDestinationAddresses: ["8.8.8.8"] }));
  assert.throws(() => assertSafeProviderResolution({ resolvedDestinationAddresses: ["8.8.8.8", "169.254.169.254"] }), /non-public address/);
  assert.equal(destinationSafetyClassification({ resolvedDestinationAddresses: ["8.8.8.8"] }), "verified");
  assert.equal(destinationSafetyClassification(undefined), "provider_trusted");
});

test("CONNECT authority parsing rejects embedded credentials, paths, and queries", () => {
  assert.deepEqual(parseHostPort("example.com:443", 443), { host: "example.com", port: 443 });
  assert.deepEqual(parseHostPort("[2606:4700:4700::1111]:443", 443), {
    host: "2606:4700:4700::1111",
    port: 443,
  });
  assert.throws(() => parseHostPort("user:password@example.com:443", 443), /without credentials/);
  assert.throws(() => parseHostPort("example.com:443/path?secret=value", 443), /without credentials/);
});

test("Effect generates a complete secured OpenAPI contract from the control API", () => {
  const specification = OpenApi.fromApi(ControlApi);
  const paths = specification.paths;
  assert.ok(paths["/health/live"]?.get);
  assert.ok(paths["/health/ready"]?.get);
  assert.ok(paths["/v1/profiles"]?.get);
  assert.ok(paths["/v1/profiles"]?.post);
  assert.ok(paths["/v1/profiles/{id}"]?.get);
  assert.ok(paths["/v1/profiles/{id}"]?.put);
  assert.ok(paths["/v1/profiles/{id}"]?.delete);
  assert.ok(paths["/v1/profiles/{id}/grants"]?.post);
  assert.ok(paths["/v1/profiles/{id}/grants"]?.get);
  assert.ok(paths["/v1/grants/{grantId}"]?.get);
  assert.ok(paths["/v1/grants/{grantId}"]?.delete);
  assert.ok(paths["/v1/grants/{grantId}/credentials"]?.post);
  assert.ok(paths["/v1/grants/{grantId}/credentials/{credentialId}/rotate"]?.post);
  assert.ok(paths["/v1/grants/{grantId}/credentials/{credentialId}/emergency-rotate"]?.post);
  assert.ok(paths["/v1/grants/{grantId}/credentials/{credentialId}"]?.get);
  assert.ok(paths["/v1/grants/{grantId}/credentials/{credentialId}"]?.delete);
  assert.ok(paths["/v1/grants/{grantId}/sessions"]?.post);
  assert.ok(paths["/v1/grants/{grantId}/sessions"]?.get);
  assert.ok(paths["/v1/grants/{grantId}/sessions/{sessionId}"]?.get);
  assert.ok(paths["/v1/grants/{grantId}/sessions/{sessionId}"]?.delete);
  assert.ok(paths["/v1/grants/{grantId}/sessions/{sessionId}/force-close"]?.post);
  assert.equal(paths["/v1/providers"], undefined);
  assert.equal(paths["/v1/providers/health"], undefined);
  assert.equal(specification.info.title, "Profound Proxy Router Control API");
  assert.equal(specification.info.version, "0.8.0");
  assert.match(JSON.stringify(specification.components.securitySchemes), /bearer/i);
  assert.doesNotMatch(JSON.stringify(specification), /HttpApiDecodeError|"_tag"/);
  assert.match(JSON.stringify(specification.components.schemas), /ApiError/);
  assert.equal(paths["/v1/grants/{grantId}/credentials"]?.post?.requestBody, undefined);
  assert.equal(paths["/health/live"]?.get?.security?.length, 0);
  assert.ok((paths["/v1/profiles"]?.post?.security?.length ?? 0) > 0);
});
