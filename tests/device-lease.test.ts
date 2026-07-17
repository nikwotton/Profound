import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRouteStore, toPublicAccessGrant } from "../src/store.js";
import type { RouteProfile, StoredAccessGrant } from "../src/types.js";

const minute = 60_000;
const base = Date.parse("2026-07-15T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(base + offsetMs).toISOString();

const profile: RouteProfile = {
  name: "mobile-session",
  allowedProtocols: ["http", "https", "socks5"],
  targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
  rotation: { mode: "manual" },
  session: { mode: "sticky", id: "logical-session", requireGeographicContinuity: true },
  customerId: "customer",
  userId: "user",
  isTargetAuthenticated: true,
  allowConnectionRetry: false,
  isAuthenticated: true,
  shouldRetry: false,
  retryPolicy: { maxAttempts: 1 },
};

test("device leases are exclusive, session-shareable, sliding, releasable, and durable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "profound-leases-"));
  const path = join(directory, "routes.db");
  const firstStore = new SqliteRouteStore(path);
  try {
    const first = await firstStore.acquireDeviceLease("session-a", "route-a", ["device-1", "device-2"], at(0), 15 * minute);
    assert.equal(first?.endpointId, "device-1");

    const shared = await firstStore.acquireDeviceLease("session-a", "route-b", ["device-1", "device-2"], at(minute), 15 * minute);
    assert.equal(shared?.endpointId, "device-1", "the same logical session reuses its device");

    const second = await firstStore.acquireDeviceLease("session-b", "route-c", ["device-1", "device-2"], at(minute), 15 * minute);
    assert.equal(second?.endpointId, "device-2");
    assert.equal(
      await firstStore.acquireDeviceLease("session-c", "route-d", ["device-1", "device-2"], at(minute), 15 * minute),
      undefined,
      "another logical session cannot share either leased device",
    );

    await firstStore.renewDeviceLease("session-a", at(10 * minute), at(25 * minute), false);
    const afterIdleExpiry = await firstStore.acquireDeviceLease(
      "session-c",
      "route-d",
      ["device-1", "device-2"],
      at(17 * minute),
      15 * minute,
    );
    assert.equal(afterIdleExpiry?.endpointId, "device-2", "an idle lease expires while an active lease remains reserved");
    await firstStore.close();

    const restartedStore = new SqliteRouteStore(path);
    try {
      assert.equal((await restartedStore.getDeviceLease("session-a"))?.endpointId, "device-1");
      await restartedStore.releaseDeviceLease("session-a");
      const replacement = await restartedStore.acquireDeviceLease(
        "session-d",
        "route-e",
        ["device-1", "device-2"],
        at(18 * minute),
        15 * minute,
      );
      assert.equal(replacement?.endpointId, "device-1", "explicit release makes the device immediately available");
    } finally {
      await restartedStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("routine revocation preserves active work and emergency revocation raises the kill switch", async () => {
  const store = new SqliteRouteStore(":memory:");
  try {
    await store.create("routine", profile, "proxidize");
    await store.revoke("routine", false);
    assert.equal(await store.shouldTerminateActive("routine"), false);

    await store.create("emergency", profile, "proxidize");
    await store.revoke("emergency", true);
    assert.equal(await store.shouldTerminateActive("emergency"), true);

    await store.revoke("routine", true);
    assert.equal(await store.shouldTerminateActive("routine"), true, "a routine revocation can be escalated later");
  } finally {
    await store.close();
  }
});

test("route profiles contain no credential verifier and access grants rotate and revoke independently", async () => {
  const store = new SqliteRouteStore(":memory:");
  try {
    const route = await store.create("shared-route", profile, "proxidize");
    assert.doesNotMatch(JSON.stringify(route), /tokenSalt|tokenHash/);
    const first = await store.createAccessGrant("grant-one", route.id, "user-one", "credential-one", "first-token");
    const second = await store.createAccessGrant("grant-two", route.id, "user-two", "credential-two", "second-token");
    await store.setAccessGrantEndpoint(first.id, "device-1");
    assert.equal((await store.authenticateAccessGrant("pxy_credential-one", "first-token"))?.principalId, "user-one");
    assert.equal((await store.authenticateAccessGrant("pxy_credential-two", "second-token"))?.principalId, "user-two");

    const rotated = await store.rotateAccessGrantCredential(first.id, "credential-three", "rotated-token");
    assert.equal(
      (await store.authenticateAccessGrant("pxy_credential-one", "first-token"))?.id,
      first.id,
      "ordinary rotation overlaps old and new credentials",
    );
    assert.equal((await store.authenticateAccessGrant("pxy_credential-three", "rotated-token"))?.endpointId, "device-1");
    assert.equal((await store.authenticateAccessGrant("pxy_credential-two", "second-token"))?.id, second.id);
    const [overlappingCredential, activeCredential] = rotated.credentials;
    assert.ok(overlappingCredential);
    assert.ok(activeCredential);
    assert.equal(overlappingCredential.status, "overlap");
    assert.ok(overlappingCredential.revokeAt);
    assert.equal(Date.parse(overlappingCredential.revokeAt) - Date.parse(rotated.updatedAt), 72 * 60 * 60_000);
    assert.equal(Date.parse(activeCredential.expiresAt) - Date.parse(activeCredential.createdAt), 30 * 24 * 60 * 60_000);
    assert.equal(Date.parse(activeCredential.expiresAt) - Date.parse(activeCredential.renewalDueAt), 7 * 24 * 60 * 60_000);

    await store.rotateAccessGrantCredential(first.id, "credential-four", "emergency-token", true);
    assert.equal(await store.authenticateAccessGrant("pxy_credential-one", "first-token"), undefined);
    assert.equal(await store.authenticateAccessGrant("pxy_credential-three", "rotated-token"), undefined);
    assert.equal((await store.authenticateAccessGrant("pxy_credential-four", "emergency-token"))?.id, first.id);

    await store.revokeAccessGrant(first.id);
    await store.revokeAccessGrant(first.id);
    assert.equal(await store.authenticateAccessGrant("pxy_credential-four", "emergency-token"), undefined);
    assert.equal((await store.authenticateAccessGrant("pxy_credential-two", "second-token"))?.id, second.id);
  } finally {
    await store.close();
  }
});

test("credential metadata enforces expiration and overlap revocation deadlines without exposing verifiers", () => {
  const now = Date.now();
  const grant: StoredAccessGrant = {
    id: "grant",
    routeId: "route",
    principalId: "user",
    status: "ready",
    terminateActive: false,
    createdAt: new Date(now - 40 * 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    credentials: [
      {
        id: "expired",
        tokenSalt: "salt-one",
        tokenHash: "hash-one",
        status: "active",
        createdAt: new Date(now - 31 * 24 * 60 * 60_000).toISOString(),
        renewalDueAt: new Date(now - 8 * 24 * 60 * 60_000).toISOString(),
        expiresAt: new Date(now - 24 * 60 * 60_000).toISOString(),
      },
      {
        id: "overlap-ended",
        tokenSalt: "salt-two",
        tokenHash: "hash-two",
        status: "overlap",
        createdAt: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
        renewalDueAt: new Date(now + 21 * 24 * 60 * 60_000).toISOString(),
        expiresAt: new Date(now + 28 * 24 * 60 * 60_000).toISOString(),
        revokeAt: new Date(now - 1_000).toISOString(),
      },
    ],
  };
  const publicGrant = toPublicAccessGrant(grant);
  assert.deepEqual(
    publicGrant.credentials.map((credential) => credential.status),
    ["expired", "revoked"],
  );
  assert.doesNotMatch(JSON.stringify(publicGrant), /tokenSalt|tokenHash|salt-one|hash-one/);
});
