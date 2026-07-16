import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenApi } from "@effect/platform";
import { loadConfig } from "../src/config.js";
import { ControlApi } from "../src/control-contract.js";
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
  return validateRouteProfile({
    customerId: "customer",
    isAuthenticated: false,
    shouldRetry: false,
    ...value,
  }, "user", { maxAttempts: 2 });
}

test("control API token defaults only for local mock mode", () => {
  const local = loadConfig({
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "127.0.0.1",
    SQLITE_PATH: "./data/config-test.db",
  });
  assert.equal(local.adminToken, "change-me");
  assert.equal(local.proxidizeExactCity, "provider_guaranteed");

  assert.throws(() => loadConfig({
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "0.0.0.0",
    SQLITE_PATH: "./data/config-test.db",
  }), /CONTROL_API_TOKEN must be set/);

  assert.throws(() => loadConfig({
    PROVIDER_MODE: "live",
    CONTROL_API_HOST: "127.0.0.1",
    BRIGHT_DATA_CUSTOMER_ID: "customer",
    BRIGHT_DATA_ZONE: "zone",
    BRIGHT_DATA_PASSWORD: "password",
    BRIGHT_DATA_API_KEY: "api-key",
    PROXIDIZE_API_TOKEN: "provider-token",
    SQLITE_PATH: "./data/config-test.db",
  }), /CONTROL_API_TOKEN must be set/);

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

  assert.throws(() => loadConfig({
    PROVIDER_MODE: "mock",
    PROXIDIZE_EXACT_CITY_SUPPORT: "verifiable",
    SQLITE_PATH: "./data/config-test.db",
  }), /canonical verifier/);

  assert.throws(() => loadConfig({
    PROVIDER_MODE: "mock",
    CONNECT_TIMEOUT_MS: "10001",
    SQLITE_PATH: "./data/config-test.db",
  }), /CONNECT_TIMEOUT_MS/);
  assert.throws(() => loadConfig({
    PROVIDER_MODE: "mock",
    OPERATION_TIMEOUT_MS: "30001",
    SQLITE_PATH: "./data/config-test.db",
  }), /OPERATION_TIMEOUT_MS/);

  const identities = loadConfig({
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "0.0.0.0",
    CONTROL_API_IDENTITIES_JSON: JSON.stringify({ tokenOne: "user-one", tokenTwo: "user-two" }),
    SQLITE_PATH: "./data/config-test.db",
  });
  assert.equal(identities.controlIdentities.get("tokenTwo"), "user-two");
});

test("DynamoDB persistence configuration requires an explicit table", () => {
  assert.throws(() => loadConfig({
    PROVIDER_MODE: "mock",
    PERSISTENCE_BACKEND: "dynamodb",
  }), /ROUTE_TABLE_NAME is required/);
  const config = loadConfig({
    PROVIDER_MODE: "mock",
    PERSISTENCE_BACKEND: "dynamodb",
    ROUTE_TABLE_NAME: "route-state",
  });
  assert.equal(config.persistenceBackend, "dynamodb");
  assert.equal(config.routeTableName, "route-state");
  assert.throws(() => loadConfig({
    PROVIDER_MODE: "mock",
    ADVERTISED_HTTP_PROXY_PROTOCOL: "ftp",
  }), /ADVERTISED_HTTP_PROXY_PROTOCOL must be http or https/);
});

test("route validation supplies behavior defaults and normalizes countries", () => {
  const residential = validate({
    name: "public",
    targeting: { country: "us" },
  });
  assert.deepEqual(residential.rotation, { mode: "per_request" });
  assert.deepEqual(residential.allowedProtocols, ["http", "https", "socks5"]);
  assert.deepEqual(residential.session, { mode: "none", requireGeographicContinuity: false });
  assert.equal(residential.targeting.country, "US");

  const mobile = validate({
    name: "session",
    isAuthenticated: true,
    targeting: { country: "US", region: "NY", city: "New York" },
  });
  assert.deepEqual(mobile.rotation, { mode: "manual" });
  assert.deepEqual(mobile.session, { mode: "sticky", requireGeographicContinuity: true });

  const authenticatedBrightData = validate({
    name: "authenticated-bright-data",
    targeting: { country: "US", city: "New York" },
    isAuthenticated: true,
    forceProvider: "bright_data",
    rotation: { mode: "per_request" },
  });
  assert.equal(authenticatedBrightData.forceProvider, "bright_data");
  assert.equal(authenticatedBrightData.isAuthenticated, true);
  assert.deepEqual(authenticatedBrightData.rotation, { mode: "per_request" });
  assert.deepEqual(authenticatedBrightData.session, { mode: "none", requireGeographicContinuity: false });
});

test("route validation rejects incompatible mobile and ZIP policies", () => {
  assert.throws(() => validate({
    name: "obsolete-kind",
    kind: "mobile",
    targeting: { country: "US", city: "New York" },
  }), /kind is not part of the route policy/);
  assert.throws(() => validate({
    name: "authenticated-without-city",
    targeting: { country: "US", region: "NY" },
    isAuthenticated: true,
  }), /targeting.city is required/);
  assert.throws(() => validate({
    name: "no-protocols",
    targeting: { country: "US" },
    allowedProtocols: [],
  }), /non-empty array/);
  assert.throws(() => validate({
    name: "bad-mobile",
    isAuthenticated: true,
    targeting: { country: "US" },
    rotation: { mode: "per_request" },
  }), /do not support per_request/);
  assert.throws(() => validate({
    name: "bad-forced-proxidize",
    targeting: { country: "US" },
    forceProvider: "proxidize",
    rotation: { mode: "per_request" },
  }), /do not support per_request/);
  assert.throws(() => validate({
    name: "bad-zip",
    targeting: { country: "GB", postalCode: "SW1A" },
  }), /requires country US/);
  assert.throws(() => validate({
    name: "short-interval",
    targeting: { country: "US" },
    rotation: { mode: "interval", intervalSeconds: 59 },
  }), /at least 60/);
  assert.throws(() => validate({
    name: "too-many-attempts",
    targeting: { country: "US" },
    retryPolicy: { maxAttempts: 7 },
  }), /from 1 to 6/);
  assert.throws(() => validate({
    name: "retry-backoff",
    targeting: { country: "US" },
    retryPolicy: { backoffMs: 100 },
  }), /do not back off/);
  assert.throws(() => validate({
    name: "contradictory-session",
    targeting: { country: "US" },
    rotation: { mode: "per_request" },
    session: { mode: "sticky", id: "session-1" },
  }), /incompatible with per_request/);
});

test("Bright Data credentials encode targeting and pin each per-request candidate to a unique constant session", () => {
  const prefix = "brd-customer-customer1-zone-zone1-country-us-state-ny-city-newyork-zip-10001-asn-12345-carrier-tmobile";
  const username = buildBrightDataUsername(
    { customerId: "customer-1", zone: "zone-1" },
    route(),
    1,
    { logicalOperationId: "operation-1", candidateIndex: 0 },
  );
  const next = buildBrightDataUsername(
    { customerId: "customer-1", zone: "zone-1" },
    route(),
    1,
    { logicalOperationId: "operation-2", candidateIndex: 0 },
  );
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
  assert.deepEqual(requested, [{
    url: "https://api.brightdata.com/network_status/res",
    authorization: "Bearer api-key",
  }]);
});

test("literal target validation blocks explicit private, metadata, and reserved addresses without using local DNS for routing", async () => {
  for (const address of [
    "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "198.51.100.1",
    "::1", "64:ff9b:1::1", "100:0:0:1::1", "2001:10::1", "3fff::1", "4000::1", "fc00::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  const validate = createTargetValidator(
    new Set([80, 443]),
    async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
  );
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
  assert.ok(paths["/v1/routes"]?.get);
  assert.ok(paths["/v1/routes"]?.post);
  assert.ok(paths["/v1/routes/{id}"]?.get);
  assert.ok(paths["/v1/routes/{id}"]?.delete);
  assert.ok(paths["/v1/routes/{id}/rotate"]?.post);
  assert.ok(paths["/v1/routes/{id}/access-grants"]?.post);
  assert.ok(paths["/v1/routes/{id}/access-grants"]?.get);
  assert.ok(paths["/v1/access-grants/{grantId}/credentials/rotate"]?.post);
  assert.ok(paths["/v1/access-grants/{grantId}/credentials/emergency-rotate"]?.post);
  assert.ok(paths["/v1/access-grants/{grantId}"]?.delete);
  assert.ok(paths["/v1/access-grants/{grantId}/release"]?.post);
  assert.ok(paths["/v1/access-grants/{grantId}/emergency-revoke"]?.post);
  assert.ok(paths["/v1/routes/{id}/emergency-revoke"]?.post);
  assert.ok(paths["/v1/providers/health"]?.get);
  assert.ok(paths["/v1/providers"]?.get);
  assert.equal(specification.info.title, "Profound Proxy Router Control API");
  assert.equal(specification.info.version, "0.5.0");
  assert.match(JSON.stringify(specification.components.securitySchemes), /bearer/i);
  assert.equal(paths["/health/live"]?.get?.security?.length, 0);
  assert.ok((paths["/v1/routes"]?.post?.security?.length ?? 0) > 0);
});
