import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUTING_POLICY,
  historicalRoutingEvidence,
  scoreRoutingCandidate,
  selectTopBandCandidate,
  type ScoredRoutingCandidate,
} from "../src/routing-policy.js";
import type { UsageRecord } from "../src/domain/usage.js";

const now = Date.parse("2026-07-17T12:00:00.000Z");

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    kind: "attempt",
    id: "attempt",
    logicalOperationId: "operation",
    accessGrantId: "grant",
    routeId: "route",
    userId: "user",
    customerId: "customer",
    provider: "proxidize",
    protocol: "https",
    outcome: "success",
    retryIndex: 0,
    failover: false,
    bytesSent: 1_000_000,
    bytesReceived: 1_000_000,
    endpointId: "slot-a",
    establishmentWaitMs: 1_000,
    connectionStartedAt: "2026-07-17T11:59:50.000Z",
    connectionEndedAt: "2026-07-17T12:00:00.000Z",
    startedAt: "2026-07-17T11:59:49.000Z",
    completedAt: "2026-07-17T12:00:00.000Z",
    ...overrides,
  };
}

test("roadmap routing-score hypothesis uses the documented weighted formula and nonlinear headroom", () => {
  const result = scoreRoutingCandidate({
    reliability: 0.8,
    activeConnections: 2,
    softConnections: 4,
    observedMbps: 2,
    plannedMbps: 8,
    projectedPeriodGb: 10,
    prioritizedPeriodGb: 50,
    performance: 0.7,
    expectedCostUsd: ROUTING_POLICY.referenceCostUsd,
    stability: 0.9,
  });
  assert.equal(result.components.headroom, 0.75);
  assert.equal(result.components.costEfficiency, 0.5);
  assert.equal(result.score, 72.5);
  assert.equal(result.saturated, false);
});

test("roadmap top-band hypothesis excludes candidates more than five points behind and weights score squared", () => {
  const candidates: Array<ScoredRoutingCandidate<string>> = [
    {
      candidate: "best",
      score: 90,
      components: { reliability: 1, headroom: 1, performance: 1, costEfficiency: 1, stability: 1 },
      saturated: false,
    },
    {
      candidate: "band",
      score: 86,
      components: { reliability: 1, headroom: 1, performance: 1, costEfficiency: 1, stability: 1 },
      saturated: false,
    },
    {
      candidate: "excluded",
      score: 84,
      components: { reliability: 1, headroom: 1, performance: 1, costEfficiency: 1, stability: 1 },
      saturated: false,
    },
  ];
  assert.equal(selectTopBandCandidate(candidates, ROUTING_POLICY, () => 0)?.candidate, "best");
  assert.equal(selectTopBandCandidate(candidates, ROUTING_POLICY, () => 0.999)?.candidate, "band");
});

test("routing evidence excludes target HTTP outcomes and discounts stale or churning evidence", () => {
  const targetOutcome = usage({ id: "target-status", outcome: "http_error", endpointId: "slot-z" });
  const fresh = historicalRoutingEvidence([usage(), targetOutcome], now);
  assert.equal(fresh.reliability, 1);
  assert.equal(fresh.stability, 1);

  const churning = historicalRoutingEvidence(
    [usage({ id: "first", completedAt: "2026-07-17T11:59:00.000Z" }), usage({ id: "second", endpointId: "slot-b" })],
    now,
  );
  assert.ok(churning.stability < fresh.stability);

  const stale = historicalRoutingEvidence([usage({ completedAt: "2026-07-17T10:00:00.000Z" })], now);
  assert.equal(stale.reliability, ROUTING_POLICY.unknownSignalScore);
  assert.equal(stale.stability, ROUTING_POLICY.unknownSignalScore);
});
