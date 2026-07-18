import type { CapacityCircuitReason, CapacityCircuitStatus, DataPlaneProtocol, ProviderClass, ProviderId, SessionMode } from "./routing.js";

export type UsageProvider = ProviderId | "unresolved";
export type UsageOutcome = "success" | "http_error" | "retry" | "failure";
export type UsageCostStatus = "estimated" | "reconciled";
export type UsageInterval = "hour" | "day" | "week" | "month";
export type UsageGroupBy =
  | "provider"
  | "customer"
  | "user"
  | "route"
  | "job"
  | "session_mode"
  | "destination_domain"
  | "destination_host"
  | "destination_path_template"
  | "country"
  | "city"
  | "outcome";

export interface UsageRecord {
  kind: "attempt" | "capacity";
  id: string;
  logicalOperationId: string;
  jobId?: string;
  accessGrantId: string;
  sessionMode?: SessionMode;
  sessionId?: string;
  routeId: string;
  userId: string;
  customerId: string;
  provider: UsageProvider;
  protocol: DataPlaneProtocol;
  outcome: UsageOutcome;
  retryIndex: number;
  failover: boolean;
  bytesSent: number;
  bytesReceived: number;
  latencyMs?: number;
  destinationDomain?: string;
  destinationHost?: string;
  destinationPort?: number;
  destinationPathTemplate?: string;
  country?: string;
  city?: string;
  endpointId?: string;
  proxySlotId?: string;
  deviceId?: string;
  upstreamConnectionId?: string;
  connectionStartedAt?: string;
  connectionEndedAt?: string;
  selectedSlotLoad?: number;
  capacityPressure?: boolean;
  capacityPressureProvider?: ProviderId;
  capacityConstraint?: "slot_exhaustion" | "geography" | "carrier" | "hard_limit" | "capacity_circuit";
  establishmentWaitMs?: number;
  capacityPolicyVersion?: string;
  providerOverride?: ProviderId;
  capacityCircuitState?: CapacityCircuitStatus;
  capacityCircuitReason?: CapacityCircuitReason;
  capacityCircuitCooldownUntil?: string;
  routingPolicyVersion?: string;
  routingScore?: number;
  routingScoreComponents?: {
    reliability: number;
    headroom: number;
    performance: number;
    costEfficiency: number;
    stability: number;
  };
  sessionAffinityHit?: boolean;
  sessionRebindCause?: string;
  desiredProviderClass?: ProviderClass;
  currentProviderClass?: ProviderClass;
  degradedFallback?: boolean;
  failbackOutcome?: "not_attempted" | "success" | "failure";
  pricingVersion?: string;
  pricingModel?: "per_gib" | "per_device_month";
  priceUsd?: number;
  capacityState?: "healthy_idle" | "unhealthy";
  startedAt: string;
  completedAt: string;
}

export interface UsageRollup {
  id: string;
  interval: UsageInterval;
  periodStartedAt: string;
  periodEndsAt: string;
  group: Partial<Record<UsageGroupBy, string>>;
  operationCount: number;
  successCount: number;
  retryCount: number;
  failoverCount: number;
  bytesSent: number;
  bytesReceived: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  activeConnectionMs: number;
  provisionedSlotMs: number;
  healthyIdleSlotMs: number;
  unhealthySlotMs: number;
  slotOccupancy: number;
  currentSlotOccupancy: number;
  provisionedSlots: number;
  activeConnections: number;
  peakConcurrentConnections: number;
  p95ConcurrentConnections: number;
  concurrencyUtilization: number;
  throughputUtilization: number;
  prioritizedGbUsed: number;
  prioritizedGbForecast: number;
  capacityDrivenFallbackCount: number;
  capacityFailureCount: number;
  capacityWaitMs: number;
  capacityConstraint?: "slot_exhaustion" | "geography" | "carrier" | "hard_limit" | "capacity_circuit";
  capacityPolicyVersion: string;
  providerSpendUsd: number;
  attributedCostUsd: number;
  estimatedCostUsd: number;
  costStatus: UsageCostStatus;
  pricingVersions: string[];
  updatedAt: string;
}

export interface UsageReconciliation {
  kind: "provider_usage_adjustment";
  id: string;
  provider: ProviderId;
  periodStartedAt: string;
  periodEndsAt: string;
  estimatedTotalUsd: number;
  reportedTotalUsd: number;
  adjustmentUsd: number;
  relativeVariance: number;
  varianceAttribution: "Unallocated";
  severity: "normal" | "warning" | "error";
  sourceVersion: string;
  createdAt: string;
}

export interface UsageAlertEvent {
  id: string;
  kind: "capacity_recommendation" | "reconciliation_variance";
  severity: "warning" | "error";
  provider: ProviderId;
  periodStartedAt: string;
  periodEndsAt: string;
  relatedRecordId: string;
  capacityPolicyVersion?: string;
  capacityConstraint?: "slot_exhaustion" | "geography" | "carrier" | "hard_limit" | "capacity_circuit";
  capacityDrivenFallbackCount?: number;
  capacityFailureCount?: number;
  capacityWaitMs?: number;
  varianceUsd?: number;
  relativeVariance?: number;
  createdAt: string;
}

export interface CapacityPressureEvidence {
  id: string;
  provider: ProviderId;
  periodStartedAt: string;
  periodEndsAt: string;
  relatedRollupId: string;
  capacityPolicyVersion: string;
  capacityConstraint?: "slot_exhaustion" | "geography" | "carrier" | "hard_limit" | "capacity_circuit";
  capacityDrivenFallbackCount: number;
  capacityFailureCount: number;
  capacityWaitMs: number;
  concurrencyUtilization: number;
  throughputUtilization: number;
  observedAt: string;
}
