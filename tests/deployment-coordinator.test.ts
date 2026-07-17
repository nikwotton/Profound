import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateDeploymentDrain } from "../src/release-policy.js";

const startedAt = "2026-01-01T00:00:00.000Z";

test("deployment drain policy polls, notifies, escalates, terminates, and honors time-bounded extensions", () => {
  assert.equal(evaluateDeploymentDrain({ startedAt, now: "2026-01-01T00:15:00.000Z", activeTunnelCount: 0 }).action, "complete");
  assert.equal(evaluateDeploymentDrain({ startedAt, now: "2026-01-01T00:15:00.000Z", activeTunnelCount: 2 }).action, "wait");
  assert.equal(evaluateDeploymentDrain({ startedAt, now: "2026-01-01T01:00:00.000Z", activeTunnelCount: 2 }).action, "notify");
  assert.equal(evaluateDeploymentDrain({ startedAt, now: "2026-01-01T03:00:00.000Z", activeTunnelCount: 2 }).action, "escalate");
  assert.equal(evaluateDeploymentDrain({ startedAt, now: "2026-01-01T06:00:00.000Z", activeTunnelCount: 2 }).action, "terminate");
  assert.equal(
    evaluateDeploymentDrain({
      startedAt,
      now: "2026-01-01T06:00:00.000Z",
      activeTunnelCount: 2,
      extensionUntil: "2026-01-01T07:00:00.000Z",
      lastNotificationAt: "2026-01-01T05:30:00.000Z",
    }).action,
    "wait",
  );
});
