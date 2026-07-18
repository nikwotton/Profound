import assert from "node:assert/strict";
import test from "node:test";
import { toPublicAccessGrant } from "../src/store.js";
import type { RouteProfile, StoredAccessGrant } from "../src/domain/routing.js";
import { InMemoryRouteStore, InMemoryRouteStoreState } from "../src/in-memory-route-store.js";

const base = Date.parse("2026-07-15T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(base + offsetMs).toISOString();

const profile: RouteProfile = {
  name: "mobile-session",
  allowedProtocols: ["http", "https", "socks5"],
  targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
  rotation: { mode: "manual" },
  customerId: "customer",
  userId: "user",
  allowConnectionRetry: false,
  shouldRetry: false,
  retryPolicy: { maxAttempts: 1 },
};

test("active proxy-slot loads are shared across callers, durable, and released with each connection", async () => {
  const state = new InMemoryRouteStoreState();
  const firstStore = new InMemoryRouteStore(state);
  try {
    await firstStore.registerActiveTunnel({
      id: "connection-a",
      deploymentId: "deployment-a",
      routeId: "route-a",
      accessGrantId: "grant-a",
      protocol: "https",
      provider: "proxidize",
      endpointId: "slot-1",
      startedAt: at(0),
      lastHeartbeatAt: at(0),
      expiresAt: at(120_000),
    });
    await firstStore.registerActiveTunnel({
      id: "connection-b",
      deploymentId: "deployment-b",
      routeId: "route-b",
      accessGrantId: "grant-b",
      protocol: "http",
      provider: "proxidize",
      endpointId: "slot-1",
      startedAt: at(1_000),
      lastHeartbeatAt: at(1_000),
      expiresAt: at(121_000),
    });
    assert.equal((await firstStore.listAllActiveTunnels(at(60_000))).length, 2, "a proxy slot can serve multiple callers");
    await firstStore.removeActiveTunnel("connection-a");
    assert.deepEqual(
      (await firstStore.listAllActiveTunnels(at(60_000))).map((connection) => connection.id),
      ["connection-b"],
    );
    await firstStore.close();

    const restartedStore = new InMemoryRouteStore(state);
    try {
      assert.equal((await restartedStore.listAllActiveTunnels(at(60_000)))[0]?.id, "connection-b");
      assert.deepEqual(await restartedStore.listAllActiveTunnels(at(122_000)), [], "expired connection load is not retained");
    } finally {
      await restartedStore.close();
    }
  } finally {
    await firstStore.close();
  }
});

test("concurrent proxy-slot claims atomically include earlier claims in candidate load", async () => {
  const store = new InMemoryRouteStore();
  let sequence = 0;
  try {
    const claim = () =>
      store.claimActiveTunnelSlot(
        "proxidize",
        ["slot-a", "slot-b"],
        (loads) =>
          (["slot-a", "slot-b"] as const).toSorted(
            (left, right) => (loads.get(left) ?? 0) - (loads.get(right) ?? 0) || left.localeCompare(right),
          )[0] ?? "slot-a",
        (endpointId) => {
          sequence += 1;
          return {
            id: `claim-${sequence}`,
            deploymentId: "deployment",
            routeId: `route-${sequence}`,
            accessGrantId: `grant-${sequence}`,
            protocol: "https",
            provider: "proxidize",
            endpointId,
            startedAt: new Date().toISOString(),
            lastHeartbeatAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          };
        },
      );
    const claims = await Promise.all([claim(), claim()]);
    assert.deepEqual(new Set(claims.map(({ tunnel }) => tunnel.endpointId)), new Set(["slot-a", "slot-b"]));
    assert.equal((await store.listAllActiveTunnels()).length, 2);
  } finally {
    await store.close();
  }
});

test("logical-session affinity rebinding uses compare-and-swap so concurrent writers cannot split identity", async () => {
  const store = new InMemoryRouteStore();
  try {
    await store.create("route", profile);
    await store.createAccessGrant("grant", "route", "user", "credential", "token", "managed", "session");
    await store.createLogicalSession({
      id: "session",
      grantId: "grant",
      routeId: "route",
      status: "open",
      terminateActive: false,
      bindingVersion: 0,
      createdAt: at(0),
      updatedAt: at(0),
    });
    const binding = (candidateId: string) => ({
      id: "session",
      grantId: "grant",
      routeId: "route",
      status: "open" as const,
      terminateActive: false,
      bindingVersion: 1,
      affinity: {
        provider: "proxidize" as const,
        providerClass: "device_backed" as const,
        candidateId,
        affinityHandle: candidateId,
        profileFingerprint: "profile-fingerprint",
        desiredProviderClass: "device_backed" as const,
        currentProviderClass: "device_backed" as const,
        degradedFallback: false,
        boundAt: at(1),
        lastUsedAt: at(1),
      },
      createdAt: at(0),
      updatedAt: at(1),
    });
    const results = await Promise.all([store.saveLogicalSession(binding("slot-a"), 0), store.saveLogicalSession(binding("slot-b"), 0)]);
    assert.deepEqual(results.toSorted(), [false, true]);
    const persisted = await store.getLogicalSession("session");
    assert.equal(persisted.bindingVersion, 1);
    assert.ok(persisted.affinity?.candidateId === "slot-a" || persisted.affinity?.candidateId === "slot-b");
  } finally {
    await store.close();
  }
});

test("shared capacity circuits open, back off, half-open exactly one probe, and reset after success", async () => {
  const store = new InMemoryRouteStore();
  try {
    const first = await store.recordCapacityCircuitFailure("bright_data", "bright_data", "establishment_failure", at(0));
    const second = await store.recordCapacityCircuitFailure("bright_data", "bright_data", "establishment_failure", at(1));
    const opened = await store.recordCapacityCircuitFailure("bright_data", "bright_data", "establishment_failure", at(2));
    assert.equal(first.status, "closed");
    assert.equal(second.status, "closed");
    assert.equal(opened.status, "open");
    assert.equal(opened.cooldownUntil, at(60_002));
    assert.equal((await store.claimCapacityCircuit("bright_data", "bright_data", at(60_001))).allowed, false);

    const probe = await store.claimCapacityCircuit("bright_data", "bright_data", at(60_002));
    assert.equal(probe.allowed, true);
    assert.equal(probe.state?.status, "half_open");
    assert.equal((await store.claimCapacityCircuit("bright_data", "bright_data", at(60_003))).allowed, false);

    const reopened = await store.recordCapacityCircuitFailure("bright_data", "bright_data", "capacity_failure", at(60_004));
    assert.equal(reopened.status, "open");
    assert.equal(reopened.cooldownUntil, at(180_004), "a repeated opening doubles the cooldown");
    await store.resetCapacityCircuit("bright_data", "bright_data");
    assert.equal(await store.getCapacityCircuit("bright_data", "bright_data", at(60_005)), undefined);

    const hardLimit = await store.recordCapacityCircuitFailure("proxidize", "slot-a", "provider_hard_limit", at(70_000));
    assert.equal(hardLimit.status, "open", "a provider hard limit opens immediately");
  } finally {
    await store.close();
  }
});

test("routine revocation preserves active work and emergency revocation raises the kill switch", async () => {
  const store = new InMemoryRouteStore();
  try {
    await store.create("routine", profile);
    await store.revoke("routine", false);
    assert.equal(await store.shouldTerminateActive("routine"), false);

    await store.create("emergency", profile);
    await store.revoke("emergency", true);
    assert.equal(await store.shouldTerminateActive("emergency"), true);

    await store.revoke("routine", true);
    assert.equal(await store.shouldTerminateActive("routine"), true, "a routine revocation can be escalated later");
  } finally {
    await store.close();
  }
});

test("route profiles contain no credential verifier and access grants rotate and revoke independently", async () => {
  const store = new InMemoryRouteStore();
  try {
    const route = await store.create("shared-route", profile);
    assert.doesNotMatch(JSON.stringify(route), /tokenSalt|tokenHash/);
    const first = await store.createAccessGrant("grant-one", route.id, "user-one", "credential-one", "first-token", "stateless");
    const second = await store.createAccessGrant("grant-two", route.id, "user-two", "credential-two", "second-token", "stateless");
    assert.equal((await store.authenticateAccessGrant("pxy_credential-one", "first-token"))?.grant.principalId, "user-one");
    assert.equal((await store.authenticateAccessGrant("pxy_credential-two", "second-token"))?.grant.principalId, "user-two");

    const rotated = await store.rotateAccessGrantCredential(first.id, "credential-one", "credential-three", "rotated-token");
    assert.equal(
      (await store.authenticateAccessGrant("pxy_credential-one", "first-token"))?.grant.id,
      first.id,
      "ordinary rotation overlaps old and new credentials",
    );
    assert.doesNotMatch(
      JSON.stringify(await store.authenticateAccessGrant("pxy_credential-three", "rotated-token")),
      /endpointId|slot|device/,
    );
    assert.equal((await store.authenticateAccessGrant("pxy_credential-two", "second-token"))?.grant.id, second.id);
    const [overlappingCredential, activeCredential] = rotated.credentials;
    assert.ok(overlappingCredential);
    assert.ok(activeCredential);
    assert.equal(overlappingCredential.status, "overlap");
    assert.ok(overlappingCredential.revokeAt);
    assert.equal(Date.parse(overlappingCredential.revokeAt) - Date.parse(rotated.updatedAt), 72 * 60 * 60_000);
    assert.equal(Date.parse(activeCredential.expiresAt) - Date.parse(activeCredential.createdAt), 30 * 24 * 60 * 60_000);
    assert.equal(Date.parse(activeCredential.expiresAt) - Date.parse(activeCredential.renewalDueAt), 7 * 24 * 60 * 60_000);

    await store.rotateAccessGrantCredential(first.id, "credential-three", "credential-four", "emergency-token", true);
    assert.equal((await store.authenticateAccessGrant("pxy_credential-one", "first-token"))?.grant.id, first.id);
    assert.equal(await store.authenticateAccessGrant("pxy_credential-three", "rotated-token"), undefined);
    assert.equal((await store.authenticateAccessGrant("pxy_credential-four", "emergency-token"))?.grant.id, first.id);

    await store.revokeAccessGrant(first.id);
    await store.revokeAccessGrant(first.id);
    assert.equal(await store.authenticateAccessGrant("pxy_credential-four", "emergency-token"), undefined);
    assert.equal((await store.authenticateAccessGrant("pxy_credential-two", "second-token"))?.grant.id, second.id);
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
        sessionMode: "stateless",
        tokenSalt: "salt-one",
        tokenHash: "hash-one",
        status: "active",
        createdAt: new Date(now - 31 * 24 * 60 * 60_000).toISOString(),
        renewalDueAt: new Date(now - 8 * 24 * 60 * 60_000).toISOString(),
        expiresAt: new Date(now - 24 * 60 * 60_000).toISOString(),
      },
      {
        id: "overlap-ended",
        sessionMode: "stateless",
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
