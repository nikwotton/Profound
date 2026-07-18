import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryRouteStore } from "./in-memory-route-store.js";
import type { ActiveTunnel } from "../src/types.js";

test("active tunnel registry and deployment drain flags share a store", async (t) => {
  const store = new InMemoryRouteStore();
  t.after(() => store.close());
  const tunnel: ActiveTunnel = {
    id: "tunnel-1",
    deploymentId: "blue",
    routeId: "route-1",
    accessGrantId: "grant-1",
    protocol: "https",
    provider: "bright_data",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:02:00.000Z",
  };
  await store.registerActiveTunnel(tunnel);
  assert.equal((await store.listActiveTunnels("blue", "2026-01-01T00:01:00.000Z")).length, 1);
  await store.heartbeatActiveTunnel("tunnel-1", "2026-01-01T00:01:30.000Z", "2026-01-01T00:03:30.000Z");
  assert.equal((await store.listAllActiveTunnels("2026-01-01T00:03:00.000Z"))[0]?.lastHeartbeatAt, "2026-01-01T00:01:30.000Z");
  await store.saveDeploymentDrain({
    deploymentId: "blue",
    startedAt: tunnel.startedAt,
    terminateRemaining: true,
    updatedAt: "2026-01-01T06:00:00.000Z",
  });
  assert.equal(await store.shouldTerminateDeployment("blue"), true);
  await store.removeActiveTunnel("tunnel-1");
  assert.deepEqual(await store.listActiveTunnels("blue"), []);
});
