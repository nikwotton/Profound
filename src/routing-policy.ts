import type { UsageRecord } from "./types.js";

export interface RoutingPolicy {
  readonly version: string;
  readonly lastValidatedAt: string;
  readonly weights: {
    readonly reliability: number;
    readonly headroom: number;
    readonly performance: number;
    readonly costEfficiency: number;
    readonly stability: number;
  };
  readonly topBandPoints: number;
  readonly selectionExponent: number;
  readonly evidenceWindowMs: number;
  readonly evidenceHalfLifeMs: number;
  readonly evidenceFreshnessMs: number;
  readonly performanceReferenceMs: number;
  readonly referenceCostUsd: number;
  readonly unknownSignalScore: number;
  readonly capacityCircuitFailureThreshold: number;
  readonly capacityCircuitBaseCooldownMs: number;
  readonly capacityCircuitMaxCooldownMs: number;
  readonly capacityCircuitHalfOpenLeaseMs: number;
}

export const ROUTING_POLICY: RoutingPolicy = Object.freeze({
  version: "proxy-routing-v0-2026-07-17",
  lastValidatedAt: "2026-07-17",
  weights: Object.freeze({
    reliability: 0.3,
    headroom: 0.3,
    performance: 0.2,
    costEfficiency: 0.15,
    stability: 0.05,
  }),
  topBandPoints: 5,
  selectionExponent: 2,
  evidenceWindowMs: 24 * 60 * 60_000,
  evidenceHalfLifeMs: 6 * 60 * 60_000,
  evidenceFreshnessMs: 15 * 60_000,
  performanceReferenceMs: 10_000,
  referenceCostUsd: 0.01,
  unknownSignalScore: 0.5,
  capacityCircuitFailureThreshold: 3,
  capacityCircuitBaseCooldownMs: 60_000,
  capacityCircuitMaxCooldownMs: 15 * 60_000,
  capacityCircuitHalfOpenLeaseMs: 30_000,
});

export interface RoutingScoreComponents {
  reliability: number;
  headroom: number;
  performance: number;
  costEfficiency: number;
  stability: number;
}

export interface RoutingScoreInput {
  reliability: number;
  activeConnections: number;
  softConnections: number;
  observedMbps: number;
  plannedMbps: number;
  projectedPeriodGb: number;
  prioritizedPeriodGb: number;
  performance: number;
  expectedCostUsd: number;
  stability: number;
}

export interface ScoredRoutingCandidate<T> {
  candidate: T;
  score: number;
  components: RoutingScoreComponents;
  saturated: boolean;
}

function unit(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function scoreRoutingCandidate(
  candidate: RoutingScoreInput,
  policy: RoutingPolicy = ROUTING_POLICY,
): Omit<ScoredRoutingCandidate<never>, "candidate"> {
  const utilization = Math.max(
    candidate.softConnections <= 0 ? 1 : candidate.activeConnections / candidate.softConnections,
    candidate.plannedMbps <= 0 ? 1 : candidate.observedMbps / candidate.plannedMbps,
    candidate.prioritizedPeriodGb <= 0 ? 1 : candidate.projectedPeriodGb / candidate.prioritizedPeriodGb,
  );
  const components: RoutingScoreComponents = {
    reliability: unit(candidate.reliability),
    headroom: unit(1 - utilization ** 2),
    performance: unit(candidate.performance),
    costEfficiency: unit(1 / (1 + Math.max(0, candidate.expectedCostUsd) / policy.referenceCostUsd)),
    stability: unit(candidate.stability),
  };
  const score =
    100 *
    (policy.weights.reliability * components.reliability +
      policy.weights.headroom * components.headroom +
      policy.weights.performance * components.performance +
      policy.weights.costEfficiency * components.costEfficiency +
      policy.weights.stability * components.stability);
  return { score, components, saturated: utilization >= 1 };
}

export function selectTopBandCandidate<T>(
  candidates: readonly ScoredRoutingCandidate<T>[],
  policy: RoutingPolicy = ROUTING_POLICY,
  random: () => number = Math.random,
): ScoredRoutingCandidate<T> | undefined {
  const best = Math.max(...candidates.map(({ score }) => score));
  if (!Number.isFinite(best)) return undefined;
  const band = candidates.filter(({ score }) => score >= best - policy.topBandPoints);
  const weights = band.map(({ score }) => Math.max(Number.EPSILON, score) ** policy.selectionExponent);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = Math.min(Math.max(random(), 0), 1 - Number.EPSILON) * total;
  for (let index = 0; index < band.length; index += 1) {
    cursor -= weights[index] ?? 0;
    if (cursor < 0) return band[index];
  }
  return band.at(-1);
}

export interface HistoricalRoutingEvidence {
  reliability: number;
  performance: number;
  observedMbps: number;
  projectedPeriodGb: number;
  expectedBytes: number;
  expectedConnectionSeconds: number;
  stability: number;
}

export interface RoutingScoreContext {
  routingPolicyVersion?: string;
  routingScore?: number;
  routingScoreComponents?: RoutingScoreComponents;
}

export function routingScoreTelemetryAttributes(context: RoutingScoreContext): Record<string, string | number> {
  const components = context.routingScoreComponents;
  return {
    ...(context.routingPolicyVersion === undefined ? {} : { "proxy.routing.policy.version": context.routingPolicyVersion }),
    ...(context.routingScore === undefined ? {} : { "proxy.routing.score": context.routingScore }),
    ...(components === undefined
      ? {}
      : {
          "proxy.routing.score.reliability": components.reliability,
          "proxy.routing.score.headroom": components.headroom,
          "proxy.routing.score.performance": components.performance,
          "proxy.routing.score.cost_efficiency": components.costEfficiency,
          "proxy.routing.score.stability": components.stability,
        }),
  };
}

export function routingScoreLogContext(context: RoutingScoreContext): Record<string, unknown> {
  return {
    ...(context.routingPolicyVersion === undefined ? {} : { routingPolicyVersion: context.routingPolicyVersion }),
    ...(context.routingScore === undefined ? {} : { routingScore: context.routingScore }),
    ...(context.routingScoreComponents === undefined ? {} : { routingScoreComponents: context.routingScoreComponents }),
  };
}

export function historicalRoutingEvidence(
  records: readonly UsageRecord[],
  now: number,
  policy: RoutingPolicy = ROUTING_POLICY,
): HistoricalRoutingEvidence {
  const attempts = records.filter((record) => record.kind === "attempt" && record.outcome !== "http_error");
  let successWeight = 0;
  let evidenceWeight = 0;
  for (const record of attempts) {
    const age = Math.max(0, now - Date.parse(record.completedAt));
    const weight = 0.5 ** (age / policy.evidenceHalfLifeMs);
    evidenceWeight += weight;
    if (record.outcome === "success") successWeight += weight;
  }
  const freshest = attempts.reduce((latest, record) => Math.max(latest, Date.parse(record.completedAt)), 0);
  const freshness = freshest === 0 ? 0 : unit(1 - Math.max(0, now - freshest) / policy.evidenceFreshnessMs);
  const measuredReliability = evidenceWeight === 0 ? policy.unknownSignalScore : successWeight / evidenceWeight;
  const reliability = policy.unknownSignalScore * (1 - freshness) + measuredReliability * freshness;
  const waits = attempts
    .flatMap((record) => (record.establishmentWaitMs === undefined ? [] : [record.establishmentWaitMs]))
    .sort((left, right) => left - right);
  const p95 = waits.length === 0 ? undefined : waits[Math.min(waits.length - 1, Math.ceil(waits.length * 0.95) - 1)];
  const performance = p95 === undefined ? policy.unknownSignalScore : unit(1 - p95 / policy.performanceReferenceMs);
  const bytes = attempts.reduce((sum, record) => sum + record.bytesSent + record.bytesReceived, 0);
  const connectionMs = attempts.reduce((sum, record) => {
    if (record.connectionStartedAt === undefined || record.connectionEndedAt === undefined) return sum;
    return sum + Math.max(0, Date.parse(record.connectionEndedAt) - Date.parse(record.connectionStartedAt));
  }, 0);
  const observedMbps = connectionMs === 0 ? 0 : (bytes * 8) / connectionMs / 1_000;
  const projectedPeriodGb = bytes / 1024 ** 3;
  const chronological = [...attempts].sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
  const failovers = attempts.filter((record) => record.failover).length;
  const identityChanges = chronological.slice(1).filter((record, index) => {
    const previous = chronological[index];
    return previous?.endpointId !== undefined && record.endpointId !== undefined && previous.endpointId !== record.endpointId;
  }).length;
  const measuredStability =
    attempts.length === 0 ? policy.unknownSignalScore : unit(1 - (failovers + identityChanges) / Math.max(1, attempts.length));
  const stability = policy.unknownSignalScore * (1 - freshness) + measuredStability * freshness;
  return {
    reliability,
    performance,
    observedMbps,
    projectedPeriodGb,
    expectedBytes: attempts.length === 0 ? 0 : bytes / attempts.length,
    expectedConnectionSeconds: attempts.length === 0 ? 0 : connectionMs / attempts.length / 1_000,
    stability,
  };
}
