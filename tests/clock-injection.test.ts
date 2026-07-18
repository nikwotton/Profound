import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";
import { toPublicAccessGrant } from "../src/store.js";
import type { RouteProfile, StoredAccessGrant } from "../src/types.js";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

const profile: RouteProfile = {
  name: "clock-test",
  customerId: "clock-test",
  allowedProtocols: ["http", "https", "socks5"],
  targeting: {},
  rotation: { mode: "per_request" },
  shouldRetry: false,
  allowConnectionRetry: false,
  retryPolicy: { maxAttempts: 1 },
  userId: "clock-user",
};

test("in-memory persistence uses its injected clock", async () => {
  const store = new InMemoryRouteStore(undefined, () => NOW);
  const route = await store.create("clock-route", profile);
  assert.equal(route.createdAt, NOW_ISO);
  assert.equal(route.updatedAt, NOW_ISO);

  const grant = await store.createAccessGrant("clock-grant", route.id, profile.userId, "clock-credential", "secret", "stateless");
  assert.equal(grant.createdAt, NOW_ISO);
  assert.equal(grant.credentials[0]?.createdAt, NOW_ISO);
});

test("access-grant projections use the caller's clock", () => {
  const grant: StoredAccessGrant = {
    id: "grant",
    routeId: "route",
    principalId: "user",
    credentials: [
      {
        id: "credential",
        sessionMode: "stateless",
        tokenSalt: "salt",
        tokenHash: "hash",
        status: "active",
        createdAt: "2026-06-18T12:00:00.000Z",
        renewalDueAt: "2026-07-17T12:00:00.000Z",
        expiresAt: "2026-07-19T12:00:00.000Z",
      },
    ],
    status: "ready",
    terminateActive: false,
    createdAt: "2026-06-18T12:00:00.000Z",
    updatedAt: "2026-06-18T12:00:00.000Z",
  };

  assert.equal(toPublicAccessGrant(grant, NOW).credentials[0]?.renewalDue, true);
  assert.equal(toPublicAccessGrant(grant, Date.parse("2026-07-16T12:00:00.000Z")).credentials[0]?.renewalDue, false);
});
