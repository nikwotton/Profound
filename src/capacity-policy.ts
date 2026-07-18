export interface CapacityPolicy {
  readonly version: string;
  readonly definedAt: string;
  readonly headroomPercent: number;
  readonly plannedMbpsPerSlot: number;
  readonly assumedMbpsPerActiveConnection: number;
  readonly softConnectionsPerSlot: number;
  readonly prioritizedGbPerSlotPerBillingPeriod: number;
}

/** Experimental operator-planning defaults; not an authoritative v0 contract. */
export const CAPACITY_POLICY: CapacityPolicy = Object.freeze({
  version: "experimental-proxidize-capacity-defaults-2026-07-18",
  definedAt: "2026-07-18",
  headroomPercent: 20,
  plannedMbpsPerSlot: 8,
  assumedMbpsPerActiveConnection: 0.5,
  softConnectionsPerSlot: 16,
  prioritizedGbPerSlotPerBillingPeriod: 50,
});

export interface CapacityRecommendationInput {
  provisionedSlots: number;
  peakConcurrentConnections: number;
  observedMbps: number;
  prioritizedGbForecast: number;
  limitingConstraint?: "slot_exhaustion" | "geography" | "carrier" | "hard_limit" | "capacity_circuit";
  monthlyPricePerSlotUsd: number;
}

export interface CapacityRecommendation {
  policyVersion: string;
  evaluatedAt: string;
  recommendedSlots: number;
  slotDelta: number;
  estimatedMonthlyCostDeltaUsd: number;
  suppressed: boolean;
  evidence: {
    concurrencySlots: number;
    throughputSlots: number;
    prioritizedDataSlots: number;
    limitingConstraint: CapacityRecommendationInput["limitingConstraint"] | "none";
  };
}

export function recommendCapacity(
  input: CapacityRecommendationInput,
  policy: CapacityPolicy = CAPACITY_POLICY,
  now: () => number = Date.now,
): CapacityRecommendation {
  const headroom = 1 + policy.headroomPercent / 100;
  const concurrencySlots = Math.ceil((input.peakConcurrentConnections * headroom) / policy.softConnectionsPerSlot);
  const throughputSlots = Math.ceil((input.observedMbps * headroom) / policy.plannedMbpsPerSlot);
  const prioritizedDataSlots = Math.ceil((input.prioritizedGbForecast * headroom) / policy.prioritizedGbPerSlotPerBillingPeriod);
  const recommendedSlots = Math.max(0, concurrencySlots, throughputSlots, prioritizedDataSlots);
  const suppressed = input.limitingConstraint === "geography" || input.limitingConstraint === "carrier";
  const slotDelta = suppressed ? 0 : recommendedSlots - input.provisionedSlots;
  return {
    policyVersion: policy.version,
    evaluatedAt: new Date(now()).toISOString(),
    recommendedSlots,
    slotDelta,
    estimatedMonthlyCostDeltaUsd: slotDelta * input.monthlyPricePerSlotUsd,
    suppressed,
    evidence: {
      concurrencySlots,
      throughputSlots,
      prioritizedDataSlots,
      limitingConstraint: input.limitingConstraint ?? "none",
    },
  };
}
