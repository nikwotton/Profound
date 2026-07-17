import assert from "node:assert/strict";
import { test } from "node:test";
import { coordinateDeploymentDrain, type DeploymentDrainNotification } from "../src/deployment-coordinator.js";
import type { ActiveTunnel, DeploymentDrainState } from "../src/types.js";

function tunnel(id: string, deploymentId: string, startedAt: string, expiresAt: string): ActiveTunnel {
  return {
    id,
    deploymentId,
    routeId: `route-${id}`,
    accessGrantId: `grant-${id}`,
    protocol: "https",
    provider: "bright_data",
    startedAt,
    lastHeartbeatAt: startedAt,
    expiresAt,
  };
}

test("deployment coordinator ignores green tunnels and drains blue with durable policy state", async () => {
  const states = new Map<string, DeploymentDrainState>();
  const active = [
    tunnel("green", "new", "2026-01-01T00:00:00.000Z", "2026-01-01T08:00:00.000Z"),
    tunnel("blue", "old", "2026-01-01T00:00:00.000Z", "2026-01-01T08:00:00.000Z"),
  ];
  const notifications: DeploymentDrainNotification[] = [];
  const store = {
    async listAllActiveTunnels() {
      return active;
    },
    async getDeploymentDrain(id: string) {
      return states.get(id);
    },
    async saveDeploymentDrain(state: DeploymentDrainState) {
      states.set(state.deploymentId, state);
    },
  };
  const waiting = await coordinateDeploymentDrain(store, "new", "2026-01-01T01:00:00.000Z", async (event) => {
    notifications.push(event);
  });
  assert.equal(waiting.complete, false);
  assert.equal(waiting.activeTunnelCount, 1);
  assert.equal(notifications[0]?.action, "notify");
  assert.equal(states.get("old")?.terminateRemaining, false);

  await coordinateDeploymentDrain(store, "new", "2026-01-01T06:00:00.000Z", async (event) => {
    notifications.push(event);
  });
  assert.equal(notifications.at(-1)?.action, "terminate");
  assert.equal(states.get("old")?.terminateRemaining, true);
});
