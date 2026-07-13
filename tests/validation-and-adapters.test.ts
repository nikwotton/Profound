import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenApi } from "@effect/platform";
import { loadConfig } from "../src/config.js";
import { ControlApi } from "../src/control-contract.js";
import { buildBrightDataUsername } from "../src/providers/bright-data.js";
import type { StoredRoute } from "../src/types.js";
import { validateRouteProfile } from "../src/validation.js";

function route(overrides: Partial<StoredRoute> = {}): StoredRoute {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "residential",
    kind: "residential",
    targeting: { country: "US", region: "NY", city: "New York", postalCode: "10001", asn: 12_345, carrier: "T-Mobile" },
    rotation: { mode: "per_request" },
    tokenSalt: "salt",
    tokenHash: "hash",
    provider: "bright_data",
    status: "ready",
    rotationEpoch: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("control API token defaults only for local mock mode", () => {
  const local = loadConfig({
    PROVIDER_MODE: "mock",
    CONTROL_API_HOST: "127.0.0.1",
    SQLITE_PATH: "./data/config-test.db",
  });
  assert.equal(local.adminToken, "change-me");

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
});

test("route validation supplies behavior defaults and normalizes countries", () => {
  const residential = validateRouteProfile({
    name: "public",
    kind: "residential",
    targeting: { country: "us" },
  });
  assert.deepEqual(residential.rotation, { mode: "per_request" });
  assert.equal(residential.targeting.country, "US");

  const mobile = validateRouteProfile({
    name: "session",
    kind: "mobile",
    targeting: { country: "US", region: "NY" },
  });
  assert.deepEqual(mobile.rotation, { mode: "manual" });
});

test("route validation rejects incompatible mobile and ZIP policies", () => {
  assert.throws(() => validateRouteProfile({
    name: "bad-mobile",
    kind: "mobile",
    targeting: { country: "US" },
    rotation: { mode: "per_request" },
  }), /do not support per_request/);
  assert.throws(() => validateRouteProfile({
    name: "bad-zip",
    kind: "residential",
    targeting: { country: "GB", postalCode: "SW1A" },
  }), /requires country US/);
  assert.throws(() => validateRouteProfile({
    name: "short-interval",
    kind: "residential",
    targeting: { country: "US" },
    rotation: { mode: "interval", intervalSeconds: 59 },
  }), /at least 60/);
});

test("Bright Data credentials encode targeting and omit sessions for per-request rotation", () => {
  const username = buildBrightDataUsername({ customerId: "customer-1", zone: "zone-1" }, route());
  assert.equal(
    username,
    "brd-customer-customer1-zone-zone1-country-us-state-ny-city-newyork-zip-10001-asn-12345-carrier-tmobile",
  );
  assert.doesNotMatch(username, /session/);
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
  assert.ok(paths["/v1/providers/health"]?.get);
  assert.equal(specification.info.title, "Profound Proxy Router Control API");
  assert.equal(specification.info.version, "0.1.0");
  assert.match(JSON.stringify(specification.components.securitySchemes), /bearer/i);
  assert.equal(paths["/health/live"]?.get?.security?.length, 0);
  assert.ok((paths["/v1/routes"]?.post?.security?.length ?? 0) > 0);
});
