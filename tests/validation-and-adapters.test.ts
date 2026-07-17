import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenApi } from "@effect/platform";
import { loadConfig } from "../src/config.js";
import { ControlApi } from "../src/control-contract.js";
import { assertSafeProviderResolution } from "../src/destination-resolution.js";
import { parseHostPort } from "../src/net-utils.js";
import { BrightDataAdapter, buildBrightDataUsername } from "../src/providers/bright-data.js";
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
    session: { mode: "none", requireGeographicContinuity: false },
    customerId: "customer",
    geography: { countryCode: "US", regionCode: "NY", city: "New York" },
    carrier: "T-Mobile",
    isTargetAuthenticated: false,
    allowConnectionRetry: false,
    userId: "user",
    isAuthenticated: false,
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
      isTargetAuthenticated: false,
      allowConnectionRetry: false,
      ...value,
    },
    "user",
    { maxAttempts: 2 },
  );
}

test("control API token defaults only for local mock mode", () => {
  const local = loadConfig({
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "127.0.0.1",
    SQLITE_PATH: "./data/config-test.db",
  });
  assert.equal(local.adminToken, "change-me");
  assert.equal(local.proxidizeExactCity, "provider_guaranteed");

  assert.throws(
    () =>
      loadConfig({
        PROVIDER_MODE: "mock",
        CONTROL_API_HOST: "0.0.0.0",
        SQLITE_PATH: "./data/config-test.db",
      }),
    /CONTROL_API_TOKEN must be set/,
  );

  assert.throws(
    () =>
      loadConfig({
        PROVIDER_MODE: "live",
        CONTROL_API_HOST: "127.0.0.1",
        BRIGHT_DATA_CUSTOMER_ID: "customer",
        BRIGHT_DATA_ZONE: "zone",
        BRIGHT_DATA_PASSWORD: "password",
        BRIGHT_DATA_API_KEY: "api-key",
        PROXIDIZE_API_TOKEN: "provider-token",
        SQLITE_PATH: "./data/config-test.db",
      }),
    /CONTROL_API_TOKEN must be set/,
  );

  const shared = loadConfig({
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "0.0.0.0",
    CONTROL_API_TOKEN: "local-network-secret",
    SQLITE_PATH: "./data/config-test.db",
  });
  assert.equal(shared.adminToken, "local-network-secret");

  const live = loadConfig({
    PROVIDER_MODE: "live",
    CONTROL_API_TOKEN: "strong-token",
    BRIGHT_DATA_CUSTOMER_ID: "customer",
    BRIGHT_DATA_ZONE: "zone",
    BRIGHT_DATA_PASSWORD: "password",
    BRIGHT_DATA_API_KEY: "api-key",
    PROXIDIZE_API_TOKEN: "provider-token",
    SQLITE_PATH: "./data/config-test.db",
  });
  assert.equal(live.proxidizeExactCity, "unsupported");

  assert.throws(
    () =>
      loadConfig({
        PROVIDER_MODE: "mock",
        PROXIDIZE_EXACT_CITY_SUPPORT: "verifiable",
        SQLITE_PATH: "./data/config-test.db",
      }),
    /canonical verifier/,
  );

  assert.throws(
    () =>
      loadConfig({
        PROVIDER_MODE: "mock",
        CONNECT_TIMEOUT_MS: "10001",
        SQLITE_PATH: "./data/config-test.db",
      }),
    /CONNECT_TIMEOUT_MS/,
  );
  assert.throws(
    () =>
      loadConfig({
        PROVIDER_MODE: "mock",
        OPERATION_TIMEOUT_MS: "30001",
        SQLITE_PATH: "./data/config-test.db",
      }),
    /OPERATION_TIMEOUT_MS/,
  );

  const identities = loadConfig({
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "0.0.0.0",
    CONTROL_API_IDENTITIES_JSON: JSON.stringify({ tokenOne: "user-one", tokenTwo: "user-two" }),
    SQLITE_PATH: "./data/config-test.db",
  });
  assert.equal(identities.controlIdentities.get("tokenTwo"), "user-two");
});

test("DynamoDB persistence configuration requires an explicit table", () => {
  assert.throws(
    () =>
      loadConfig({
        PROVIDER_MODE: "mock",
        PERSISTENCE_BACKEND: "dynamodb",
      }),
    /ROUTE_TABLE_NAME is required/,
  );
  const config = loadConfig({
    PROVIDER_MODE: "mock",
    PERSISTENCE_BACKEND: "dynamodb",
    ROUTE_TABLE_NAME: "route-state",
  });
  assert.equal(config.persistenceBackend, "dynamodb");
  assert.equal(config.routeTableName, "route-state");
  assert.throws(
    () =>
      loadConfig({
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
  assert.deepEqual(residential.session, { mode: "none", requireGeographicContinuity: false });
  assert.equal(residential.targeting.country, "US");

  const mobile = validate({
    isTargetAuthenticated: true,
    geography: { countryCode: "US", regionCode: "NY", city: "New York" },
  });
  assert.deepEqual(mobile.rotation, { mode: "manual" });
  assert.deepEqual(mobile.session, { mode: "sticky", requireGeographicContinuity: true });

  assert.equal(mobile.isTargetAuthenticated, true);
  assert.equal(mobile.allowConnectionRetry, false);
});

test("profile validation rejects missing authenticated geography and every non-canonical field", () => {
  assert.throws(
    () => validate({ kind: "mobile", geography: { countryCode: "US", city: "New York" } }),
    /profile.kind is not part of the profile contract/,
  );
  assert.throws(
    () =>
      validate({
        geography: { countryCode: "US", regionCode: "NY" },
        isTargetAuthenticated: true,
      }),
    /geography.countryCode and geography.city are required/,
  );
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

test("Bright Data interval sessions are stable within a bucket and change across buckets or manual rotation", () => {
  const timed = route({ rotation: { mode: "interval", intervalSeconds: 60 } });
  const first = buildBrightDataUsername({ customerId: "c", zone: "z" }, timed, 120_001);
  const second = buildBrightDataUsername({ customerId: "c", zone: "z" }, timed, 179_999);
  const third = buildBrightDataUsername({ customerId: "c", zone: "z" }, timed, 180_000);
  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.notEqual(first, buildBrightDataUsername({ customerId: "c", zone: "z" }, { ...timed, rotationEpoch: 1 }, 120_001));
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
      requested.push({ url: String(input), ...(authorization === undefined ? {} : { authorization }) });
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

test("verified provider-side private resolution is rejected while unavailable evidence remains best effort", () => {
  assert.doesNotThrow(() => assertSafeProviderResolution(undefined));
  assert.doesNotThrow(() => assertSafeProviderResolution({}));
  assert.doesNotThrow(() => assertSafeProviderResolution({ resolvedDestinationAddresses: ["8.8.8.8"] }));
  assert.throws(() => assertSafeProviderResolution({ resolvedDestinationAddresses: ["8.8.8.8", "169.254.169.254"] }), /non-public address/);
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
  assert.ok(paths["/v1/grants/{grantId}/credentials/rotate"]?.post);
  assert.ok(paths["/v1/grants/{grantId}/credentials/{credentialId}"]?.get);
  assert.ok(paths["/v1/grants/{grantId}/credentials/{credentialId}"]?.delete);
  assert.equal(paths["/v1/providers"], undefined);
  assert.equal(paths["/v1/providers/health"], undefined);
  assert.equal(specification.info.title, "Profound Proxy Router Control API");
  assert.equal(specification.info.version, "0.6.0");
  assert.match(JSON.stringify(specification.components.securitySchemes), /bearer/i);
  assert.equal(paths["/health/live"]?.get?.security?.length, 0);
  assert.ok((paths["/v1/profiles"]?.post?.security?.length ?? 0) > 0);
});
