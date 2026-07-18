import { CAPACITY_POLICY } from "./capacity-policy.js";
import { capacityCircuitAllowsCandidate } from "./capacity-circuit.js";
import type { Logger } from "./logger.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { preferredProviderClass } from "./provider-selection.js";
import { historicalRoutingEvidence, ROUTING_POLICY, scoreRoutingCandidate, type ScoredRoutingCandidate } from "./routing-policy.js";
import { V0_POLICY } from "./service-policies.js";
import type { ResolutionState } from "./routing-resolution.js";
import type { RoutingStore } from "./store.js";
import type { AuthenticatedRoute, ProviderId } from "./domain/routing.js";
import type { UsageRecord } from "./domain/usage.js";

export const MAX_PEERS_PER_PROVIDER = V0_POLICY.establishmentBudget.candidatesPerProvider;
export const MAX_VERIFICATION_CANDIDATES_PER_PROVIDER = V0_POLICY.establishmentBudget.candidatesPerProvider;
const SLOT_MONTH_SECONDS = (365.25 / 12) * 24 * 60 * 60;

export class RoutingCandidateRanker {
  constructor(
    private readonly store: RoutingStore,
    private readonly logger: Logger,
    private readonly now: () => number,
  ) {}

  scoreCandidate(
    provider: ProviderAdapter,
    records: readonly UsageRecord[],
    activeConnections: number,
    slotCapacity: boolean,
    pressureRecords: readonly UsageRecord[] = records,
  ): Omit<ScoredRoutingCandidate<never>, "candidate"> {
    const evidence = historicalRoutingEvidence(records, this.now(), ROUTING_POLICY);
    const expectedCostUsd =
      provider.descriptor.pricing.model === "per_gib"
        ? (evidence.expectedBytes / 1024 ** 3) * provider.descriptor.pricing.amountUsd
        : (evidence.expectedConnectionSeconds / SLOT_MONTH_SECONDS) * provider.descriptor.pricing.amountUsd;
    const score = scoreRoutingCandidate({
      reliability: evidence.reliability,
      activeConnections,
      softConnections: slotCapacity ? CAPACITY_POLICY.softConnectionsPerSlot : Number.MAX_SAFE_INTEGER,
      observedMbps: evidence.observedMbps,
      plannedMbps: slotCapacity ? CAPACITY_POLICY.plannedMbpsPerSlot : Number.MAX_SAFE_INTEGER,
      projectedPeriodGb: slotCapacity ? evidence.projectedPeriodGb * ((30 * 24 * 60 * 60_000) / ROUTING_POLICY.evidenceWindowMs) : 0,
      prioritizedPeriodGb: slotCapacity ? CAPACITY_POLICY.prioritizedGbPerSlotPerBillingPeriod : Number.MAX_SAFE_INTEGER,
      performance: evidence.performance,
      expectedCostUsd,
      stability: evidence.stability,
    });
    const recentCapacityPressure = pressureRecords.some(
      (record) =>
        record.kind === "attempt" &&
        record.capacityPressure === true &&
        this.now() - Date.parse(record.completedAt) <= ROUTING_POLICY.evidenceFreshnessMs,
    );
    return { ...score, saturated: score.saturated || recentCapacityPressure };
  }

  async capacityCircuitEligible(provider: ProviderId, candidateKey: string): Promise<boolean> {
    const state = await this.store.getCapacityCircuit(provider, candidateKey, new Date(this.now()).toISOString());
    return capacityCircuitAllowsCandidate(state, this.now());
  }

  async rankProviders(
    providers: readonly ProviderAdapter[],
    route: AuthenticatedRoute,
    state: ResolutionState,
    recentRecords: readonly UsageRecord[],
    signal: AbortSignal,
  ): Promise<ProviderAdapter[]> {
    const preferredClass = preferredProviderClass(route.sessionMode);
    const scored: Array<ScoredRoutingCandidate<ProviderAdapter> & { activeConnections: number }> = [];
    for (const provider of providers) {
      const providerRecords = recentRecords.filter((record) => record.provider === provider.descriptor.id);
      const providerPressureRecords = recentRecords.filter(
        (record) =>
          record.capacityPressure === true &&
          (record.capacityPressureProvider ?? (record.provider === "unresolved" ? undefined : record.provider)) === provider.descriptor.id,
      );
      if (provider.candidates !== undefined) {
        const candidateSource = provider.candidates;
        const compatibleCandidates = (await candidateSource.list(false, signal)).filter(
          (candidate) => candidate.healthy && !state.excludedCandidateIds.has(candidate.id) && candidateSource.matches(candidate, route),
        );
        const candidatesWithCapacity: typeof compatibleCandidates = [];
        for (const candidate of compatibleCandidates) {
          if (await this.capacityCircuitEligible(provider.descriptor.id, candidate.id)) candidatesWithCapacity.push(candidate);
          else state.capacityConstraint = "capacity_circuit";
        }
        if (candidatesWithCapacity.length === 0) continue;
        const candidateLoads = (
          await this.store.getActiveConnectionCounts(
            [provider.descriptor.id],
            candidatesWithCapacity.map(({ id }) => id),
            [],
          )
        ).endpoints;
        const candidates = candidatesWithCapacity.map((candidate): ScoredRoutingCandidate<string> & { activeConnections: number } => {
          const load = candidateLoads.get(candidate.id) ?? 0;
          return {
            candidate: candidate.id,
            activeConnections: load,
            ...this.scoreCandidate(
              provider,
              providerRecords.filter((record) => record.proxySlotId === candidate.id),
              load,
              true,
              providerPressureRecords.filter((record) => record.proxySlotId === candidate.id),
            ),
          };
        });
        const unsaturated = candidates.filter((candidate) => !candidate.saturated);
        const best = [...(unsaturated.length > 0 ? unsaturated : candidates)].sort(
          (left, right) => left.activeConnections - right.activeConnections || left.candidate.localeCompare(right.candidate),
        )[0];
        if (best !== undefined)
          scored.push({
            candidate: provider,
            score: best.score,
            components: best.components,
            saturated: unsaturated.length === 0,
            activeConnections: best.activeConnections,
          });
      } else {
        if (!(await this.capacityCircuitEligible(provider.descriptor.id, provider.descriptor.id))) {
          state.capacityConstraint = "capacity_circuit";
          continue;
        }
        const load =
          (await this.store.getActiveConnectionCounts([provider.descriptor.id], [], [])).providers.get(provider.descriptor.id) ?? 0;
        scored.push({
          candidate: provider,
          activeConnections: load,
          ...this.scoreCandidate(provider, providerRecords, load, false, providerPressureRecords),
        });
      }
    }
    const byLoadThenId = (
      left: ScoredRoutingCandidate<ProviderAdapter> & { activeConnections: number },
      right: ScoredRoutingCandidate<ProviderAdapter> & { activeConnections: number },
    ): number =>
      left.activeConnections - right.activeConnections || left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id);
    const previous = scored.find(({ candidate }) => candidate.descriptor.id === state.previousProvider);
    const baseline =
      previous ??
      [...scored].filter(({ candidate }) => candidate.descriptor.providerClass === preferredClass).sort(byLoadThenId)[0] ??
      [...scored].sort(byLoadThenId)[0];
    if (state.primaryProvider === undefined && baseline !== undefined) state.primaryProvider = baseline.candidate.descriptor.id;
    if (previous !== undefined) {
      const attempts = state.attemptsByProvider.get(previous.candidate.descriptor.id) ?? 0;
      const limit =
        route.targeting.city !== undefined && previous.candidate.descriptor.capabilities.exactCity === "verifiable"
          ? MAX_VERIFICATION_CANDIDATES_PER_PROVIDER
          : MAX_PEERS_PER_PROVIDER;
      if (attempts < limit) {
        return [
          previous.candidate,
          ...scored
            .filter((candidate) => candidate !== previous)
            .sort(byLoadThenId)
            .map(({ candidate }) => candidate),
        ];
      }
    }
    const preferredTier = scored.filter(({ candidate }) => candidate.descriptor.providerClass === preferredClass);
    const fallbackTier = scored.filter(({ candidate }) => candidate.descriptor.providerClass !== preferredClass);
    if (route.sessionMode === "stateless" && preferredTier.length > 0 && preferredTier.every(({ saturated }) => saturated)) {
      const eligibleFallback = fallbackTier.filter(({ saturated }) => !saturated);
      if (eligibleFallback.length > 0) {
        const orderedFallback = [...eligibleFallback].sort(
          (left, right) =>
            left.activeConnections - right.activeConnections || left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
        );
        const selected = orderedFallback[0];
        const pressureSource = [...preferredTier].sort(
          (left, right) =>
            left.activeConnections - right.activeConnections || left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
        )[0];
        if (pressureSource === undefined) throw new Error("Residential pressure source is unavailable");
        state.capacityDrivenFallback = true;
        state.capacityPressureProvider = pressureSource.candidate.descriptor.id;
        this.logger.info("Residential soft capacity promoted a device-backed fallback", {
          capacityPressureProvider: state.capacityPressureProvider,
          routingPolicyVersion: ROUTING_POLICY.version,
        });
        return [
          ...(selected === undefined ? [] : [selected.candidate]),
          ...orderedFallback.filter((candidate) => candidate !== selected).map(({ candidate }) => candidate),
          ...preferredTier
            .sort(
              (left, right) =>
                left.activeConnections - right.activeConnections ||
                left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
            )
            .map(({ candidate }) => candidate),
          ...fallbackTier
            .filter(({ saturated }) => saturated)
            .sort(
              (left, right) =>
                left.activeConnections - right.activeConnections ||
                left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
            )
            .map(({ candidate }) => candidate),
        ];
      }
    }
    const primaryTier = preferredTier.length > 0 ? preferredTier : scored;
    const unsaturatedPrimary = primaryTier.filter(({ saturated }) => !saturated);
    const selectionTier = unsaturatedPrimary.length > 0 ? unsaturatedPrimary : primaryTier;
    const selected = [...selectionTier].sort(
      (left, right) =>
        left.activeConnections - right.activeConnections || left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
    )[0];
    return [
      ...(selected === undefined ? [] : [selected.candidate]),
      ...primaryTier
        .filter((candidate) => candidate !== selected)
        .sort(
          (left, right) =>
            Number(left.saturated) - Number(right.saturated) ||
            left.activeConnections - right.activeConnections ||
            left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
        )
        .map(({ candidate }) => candidate),
      ...scored
        .filter((candidate) => !primaryTier.includes(candidate))
        .sort(
          (left, right) =>
            Number(left.saturated) - Number(right.saturated) ||
            left.activeConnections - right.activeConnections ||
            left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
        )
        .map(({ candidate }) => candidate),
    ];
  }
}
