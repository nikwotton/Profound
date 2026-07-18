import type { ProviderClass, ProviderId } from "./domain/routing.js";
import type { UsageRecord } from "./domain/usage.js";

export interface ResolutionState {
  readonly attemptsByProvider: Map<ProviderId, number>;
  readonly excludedEndpointIds: Set<string>;
  previousCandidateId?: string;
  previousProvider?: ProviderId;
  primaryProvider?: ProviderId;
  capacityDrivenFallback?: boolean;
  capacityPressureProvider?: ProviderId;
  capacityConstraint?: "slot_exhaustion" | "geography" | "carrier" | "hard_limit" | "capacity_circuit";
  establishmentWaitMs: number;
  capacityPolicyVersion?: string;
  preferredEndpointId?: string;
  preferredAffinityHandle?: string;
  sessionAffinityHit?: boolean;
  sessionRebindCause?: string;
  desiredProviderClass?: ProviderClass;
  currentProviderClass?: ProviderClass;
  degradedFallback?: boolean;
  failbackOutcome?: "not_attempted" | "success" | "failure";
  failbackProbe?: boolean;
  sessionRebindRetries: number;
}

export function createResolutionState(): ResolutionState {
  return { attemptsByProvider: new Map(), excludedEndpointIds: new Set(), establishmentWaitMs: 0, sessionRebindRetries: 0 };
}

export function sessionRoutingUsageContext(
  state: ResolutionState,
): Pick<
  UsageRecord,
  "sessionAffinityHit" | "sessionRebindCause" | "desiredProviderClass" | "currentProviderClass" | "degradedFallback" | "failbackOutcome"
> {
  return {
    ...(state.sessionAffinityHit === undefined ? {} : { sessionAffinityHit: state.sessionAffinityHit }),
    ...(state.sessionRebindCause === undefined ? {} : { sessionRebindCause: state.sessionRebindCause }),
    ...(state.desiredProviderClass === undefined ? {} : { desiredProviderClass: state.desiredProviderClass }),
    ...(state.currentProviderClass === undefined ? {} : { currentProviderClass: state.currentProviderClass }),
    ...(state.degradedFallback === undefined ? {} : { degradedFallback: state.degradedFallback }),
    ...(state.failbackOutcome === undefined ? {} : { failbackOutcome: state.failbackOutcome }),
  };
}

export function sessionRoutingTelemetryAttributes(state: ResolutionState): Record<string, string | boolean> {
  return {
    ...(state.sessionAffinityHit === undefined ? {} : { "proxy.session.affinity_hit": state.sessionAffinityHit }),
    ...(state.sessionRebindCause === undefined ? {} : { "proxy.session.rebind_cause": state.sessionRebindCause }),
    ...(state.desiredProviderClass === undefined ? {} : { "proxy.session.desired_provider_class": state.desiredProviderClass }),
    ...(state.currentProviderClass === undefined ? {} : { "proxy.session.current_provider_class": state.currentProviderClass }),
    ...(state.degradedFallback === undefined ? {} : { "proxy.session.degraded_fallback": state.degradedFallback }),
    ...(state.failbackOutcome === undefined ? {} : { "proxy.session.failback_outcome": state.failbackOutcome }),
  };
}
