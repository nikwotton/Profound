import type { CapacityCircuitReason, CapacityCircuitState, ProviderId } from "./types.js";
import { ROUTING_POLICY, type RoutingPolicy } from "./routing-policy.js";

const CIRCUIT_RETENTION_MS = 24 * 60 * 60_000;

export function capacityCircuitAllowsCandidate(state: CapacityCircuitState | undefined, now: number): boolean {
  if (state === undefined || state.status === "closed") return true;
  if (state.status === "open") return state.cooldownUntil !== undefined && Date.parse(state.cooldownUntil) <= now;
  return state.probeExpiresAt !== undefined && Date.parse(state.probeExpiresAt) <= now;
}

export function claimCapacityCircuitProbe(
  state: CapacityCircuitState | undefined,
  now: number,
  policy: RoutingPolicy = ROUTING_POLICY,
): { allowed: boolean; state?: CapacityCircuitState } {
  if (state === undefined || state.status === "closed") return { allowed: true, ...(state === undefined ? {} : { state }) };
  if (!capacityCircuitAllowsCandidate(state, now)) return { allowed: false, state };
  const updatedAt = new Date(now).toISOString();
  return {
    allowed: true,
    state: {
      ...state,
      status: "half_open",
      probeExpiresAt: new Date(now + policy.capacityCircuitHalfOpenLeaseMs).toISOString(),
      updatedAt,
      expiresAt: new Date(now + CIRCUIT_RETENTION_MS).toISOString(),
    },
  };
}

export function recordCapacityCircuitFailure(
  previous: CapacityCircuitState | undefined,
  provider: ProviderId,
  candidateKey: string,
  reason: CapacityCircuitReason,
  now: number,
  policy: RoutingPolicy = ROUTING_POLICY,
): CapacityCircuitState {
  const failures = (previous?.consecutiveFailures ?? 0) + 1;
  const shouldOpen =
    reason === "provider_hard_limit" || previous?.status === "half_open" || failures >= policy.capacityCircuitFailureThreshold;
  const openCount = (previous?.openCount ?? 0) + (shouldOpen ? 1 : 0);
  const cooldownMs = Math.min(policy.capacityCircuitMaxCooldownMs, policy.capacityCircuitBaseCooldownMs * 2 ** Math.max(0, openCount - 1));
  const updatedAt = new Date(now).toISOString();
  return {
    provider,
    candidateKey,
    status: shouldOpen ? "open" : "closed",
    consecutiveFailures: failures,
    openCount,
    reason,
    ...(shouldOpen ? { cooldownUntil: new Date(now + cooldownMs).toISOString() } : {}),
    updatedAt,
    expiresAt: new Date(now + Math.max(CIRCUIT_RETENTION_MS, cooldownMs)).toISOString(),
  };
}
