import type { ResolutionState } from "./routing-resolution.js";
import type { AuthenticatedRoute, DataPlaneProtocol, UpstreamEndpoint } from "./domain/routing.js";
import type { UsageOutcome, UsageProvider, UsageRecord } from "./domain/usage.js";
import { usageDestination } from "./usage-destination.js";

export interface AttemptUsageInput {
  attemptId: string;
  operationId: string;
  protocol: DataPlaneProtocol;
  outcome: UsageOutcome;
  attemptIndex: number;
  attemptStartedAt: number;
  completedAt: string;
  provider: UsageProvider;
  bytesSent: number;
  bytesReceived: number;
  target: { host: string; port: number; path?: string };
  upstream?: UpstreamEndpoint;
}

export function attemptUsageRecord(
  route: AuthenticatedRoute,
  state: ResolutionState,
  input: AttemptUsageInput,
): Omit<UsageRecord, "kind" | "pricingVersion" | "pricingModel" | "priceUsd"> {
  const { upstream } = input;
  return {
    id: input.attemptId,
    logicalOperationId: input.operationId,
    ...(route.jobId === undefined ? {} : { jobId: route.jobId }),
    accessGrantId: route.accessGrantId,
    sessionMode: route.sessionMode,
    ...(route.sessionId === undefined ? {} : { sessionId: route.sessionId }),
    routeId: route.id,
    userId: route.userId,
    customerId: route.customerId,
    provider: input.provider,
    protocol: input.protocol,
    outcome: input.outcome,
    retryIndex: input.attemptIndex,
    failover: input.provider !== "unresolved" && state.primaryProvider !== undefined && input.provider !== state.primaryProvider,
    bytesSent: input.bytesSent,
    bytesReceived: input.bytesReceived,
    latencyMs: Math.max(0, Date.parse(input.completedAt) - input.attemptStartedAt),
    ...usageDestination(input.target.host, input.target.port, input.target.path),
    ...(route.targeting.country === undefined ? {} : { country: route.targeting.country }),
    ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
    ...(route.providerOverride === undefined ? {} : { providerOverride: route.providerOverride }),
    ...(upstream?.endpointId === undefined ? {} : { endpointId: upstream.endpointId }),
    ...(upstream?.proxySlotId === undefined
      ? {}
      : {
          proxySlotId: upstream.proxySlotId,
          ...(upstream.assignment.deviceId === undefined ? {} : { deviceId: upstream.assignment.deviceId }),
          selectedSlotLoad: upstream.selectedSlotLoad,
        }),
    ...(upstream?.upstreamConnectionId === undefined
      ? {}
      : {
          upstreamConnectionId: upstream.upstreamConnectionId,
          connectionStartedAt: upstream.upstreamConnectionStartedAt ?? new Date(input.attemptStartedAt).toISOString(),
          connectionEndedAt: input.completedAt,
        }),
    ...(upstream?.capacityPressure === true
      ? {
          capacityPressure: true,
          capacityPressureProvider: upstream.capacityPressureProvider ?? upstream.provider,
          ...(upstream.capacityPolicyVersion === undefined ? {} : { capacityPolicyVersion: upstream.capacityPolicyVersion }),
        }
      : state.capacityPolicyVersion === undefined
        ? {}
        : { capacityPolicyVersion: state.capacityPolicyVersion }),
    ...(state.capacityConstraint === undefined ? {} : { capacityConstraint: state.capacityConstraint }),
    ...(upstream?.capacityCircuitState === undefined
      ? {}
      : {
          capacityCircuitState: upstream.capacityCircuitState,
          capacityCircuitReason: upstream.capacityCircuitReason,
          capacityCircuitCooldownUntil: upstream.capacityCircuitCooldownUntil,
        }),
    ...(upstream?.routingPolicyVersion === undefined
      ? {}
      : {
          routingPolicyVersion: upstream.routingPolicyVersion,
          routingScore: upstream.routingScore,
          routingScoreComponents: upstream.routingScoreComponents,
        }),
    establishmentWaitMs: state.establishmentWaitMs,
    ...(state.sessionAffinityHit === undefined ? {} : { sessionAffinityHit: state.sessionAffinityHit }),
    ...(state.sessionRebindCause === undefined ? {} : { sessionRebindCause: state.sessionRebindCause }),
    ...(state.desiredProviderClass === undefined ? {} : { desiredProviderClass: state.desiredProviderClass }),
    ...(state.currentProviderClass === undefined ? {} : { currentProviderClass: state.currentProviderClass }),
    ...(state.degradedFallback === undefined ? {} : { degradedFallback: state.degradedFallback }),
    ...(state.failbackOutcome === undefined ? {} : { failbackOutcome: state.failbackOutcome }),
    startedAt: new Date(input.attemptStartedAt).toISOString(),
    completedAt: input.completedAt,
  };
}
