import { Schema } from "effect";
import type {
  ActiveTunnel,
  CapabilityHealthSnapshot,
  CapacityCircuitState,
  CapacityPressureEvidence,
  DeploymentDrainState,
  HealthAlertDelivery,
  HealthAlertEvent,
  HealthAlertState,
  ProviderHealth,
  ProviderInventorySnapshot,
  StoredAccessGrant,
  StoredAccessGrantCredential,
  StoredLogicalSession,
  StoredRoute,
  UsageAlertEvent,
  UsageReconciliation,
  UsageRecord,
  UsageRollup,
} from "./types.js";

const mutableArray = <S extends Schema.Schema.Any>(schema: S) => Schema.mutable(Schema.Array(schema));
const exactOptional = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });
const IsoTimestamp = Schema.String.pipe(
  Schema.filter((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }),
);
const NonNegativeNumber = Schema.Number.pipe(Schema.finite(), Schema.nonNegative());
const NonNegativeInteger = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const PositiveInteger = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));

const Targeting = Schema.Struct({
  country: exactOptional(Schema.String),
  region: exactOptional(Schema.String),
  city: exactOptional(Schema.String),
  postalCode: exactOptional(Schema.String),
  asn: exactOptional(PositiveInteger),
  carrier: exactOptional(Schema.String),
});

const Rotation = Schema.Union(
  Schema.Struct({ mode: Schema.Literal("per_request") }),
  Schema.Struct({ mode: Schema.Literal("interval"), intervalSeconds: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(60)) }),
  Schema.Struct({ mode: Schema.Literal("manual") }),
);

const StoredAccessGrantCredentialSchema: Schema.Schema<StoredAccessGrantCredential> = Schema.Struct({
  id: Schema.String,
  sessionMode: Schema.Literal("managed", "stateless"),
  sessionId: exactOptional(Schema.String),
  tokenSalt: Schema.String,
  tokenHash: Schema.String,
  status: Schema.Literal("active", "overlap", "revoked"),
  createdAt: IsoTimestamp,
  renewalDueAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  revokeAt: exactOptional(IsoTimestamp),
  lastUsedAt: exactOptional(IsoTimestamp),
});

const StoredLogicalSessionSchema: Schema.Schema<StoredLogicalSession> = Schema.Struct({
  id: Schema.String,
  grantId: Schema.String,
  routeId: Schema.String,
  status: Schema.Literal("open", "closed"),
  terminateActive: Schema.Boolean,
  bindingVersion: NonNegativeInteger,
  affinity: exactOptional(
    Schema.Struct({
      provider: Schema.Literal("bright_data", "proxidize"),
      providerClass: Schema.Literal("residential", "device_backed"),
      candidateId: Schema.String,
      affinityHandle: Schema.String,
      profileFingerprint: Schema.String,
      desiredProviderClass: Schema.Literal("residential", "device_backed"),
      currentProviderClass: Schema.Literal("residential", "device_backed"),
      degradedFallback: Schema.Boolean,
      boundAt: IsoTimestamp,
      lastUsedAt: IsoTimestamp,
    }),
  ),
  preferredClassHealthySince: exactOptional(IsoTimestamp),
  lastDisconnectedAt: exactOptional(IsoTimestamp),
  closedAt: exactOptional(IsoTimestamp),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

const StoredAccessGrantSchema: Schema.Schema<StoredAccessGrant> = Schema.Struct({
  id: Schema.String,
  routeId: Schema.String,
  principalId: Schema.String,
  jobId: exactOptional(Schema.String),
  credentials: mutableArray(StoredAccessGrantCredentialSchema),
  status: Schema.Literal("ready", "revoked"),
  terminateActive: Schema.Boolean,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

const StoredRouteSchema: Schema.Schema<StoredRoute> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  allowedProtocols: mutableArray(Schema.Literal("http", "https", "socks5")),
  targeting: Targeting,
  rotation: Rotation,
  customerId: Schema.String,
  geography: exactOptional(
    Schema.Struct({
      countryCode: exactOptional(Schema.String),
      regionCode: exactOptional(Schema.String),
      city: exactOptional(Schema.String),
    }),
  ),
  carrier: exactOptional(Schema.String),
  providerOverride: exactOptional(Schema.Literal("bright_data", "proxidize")),
  allowConnectionRetry: Schema.Boolean,
  userId: Schema.String,
  shouldRetry: Schema.Boolean,
  retryPolicy: Schema.Struct({ maxAttempts: PositiveInteger }),
  provider: Schema.Literal("bright_data", "proxidize"),
  endpointId: exactOptional(Schema.String),
  status: Schema.Literal("ready", "rotating", "failed", "revoked"),
  terminateActive: Schema.Boolean,
  lastError: exactOptional(Schema.String),
  rotationEpoch: NonNegativeInteger,
  lastRotationAt: IsoTimestamp,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

const ActiveTunnelSchema: Schema.Schema<ActiveTunnel> = Schema.Struct({
  id: Schema.String,
  deploymentId: Schema.String,
  routeId: Schema.String,
  accessGrantId: Schema.String,
  sessionId: exactOptional(Schema.String),
  protocol: Schema.Literal("http", "https", "socks5"),
  provider: Schema.Literal("bright_data", "proxidize"),
  endpointId: exactOptional(Schema.String),
  routingPolicyVersion: exactOptional(Schema.String),
  routingScore: exactOptional(NonNegativeNumber),
  startedAt: IsoTimestamp,
  lastHeartbeatAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
});

const CapacityCircuitStateSchema: Schema.Schema<CapacityCircuitState> = Schema.Struct({
  provider: Schema.Literal("bright_data", "proxidize"),
  candidateKey: Schema.String,
  status: Schema.Literal("closed", "open", "half_open"),
  consecutiveFailures: NonNegativeInteger,
  openCount: NonNegativeInteger,
  reason: exactOptional(Schema.Literal("provider_hard_limit", "capacity_failure", "establishment_failure", "timeout")),
  cooldownUntil: exactOptional(IsoTimestamp),
  probeExpiresAt: exactOptional(IsoTimestamp),
  updatedAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
});

const DeploymentDrainStateSchema: Schema.Schema<DeploymentDrainState> = Schema.Struct({
  deploymentId: Schema.String,
  startedAt: IsoTimestamp,
  terminateRemaining: Schema.Boolean,
  lastNotificationAt: exactOptional(IsoTimestamp),
  extensionUntil: exactOptional(IsoTimestamp),
  updatedAt: IsoTimestamp,
});

const ProviderHealthSchema: Schema.Schema<ProviderHealth> = Schema.Struct({
  provider: Schema.Literal("bright_data", "proxidize"),
  state: Schema.Literal("healthy", "degraded", "unhealthy"),
  checkedAt: IsoTimestamp,
  message: exactOptional(Schema.String),
});

const ProviderInventorySnapshotSchema: Schema.Schema<ProviderInventorySnapshot> = Schema.Struct({
  provider: Schema.Literal("proxidize"),
  providerAccountId: Schema.String,
  slots: mutableArray(
    Schema.Struct({
      proxySlotId: Schema.String,
      deviceId: exactOptional(Schema.String),
      country: Schema.String,
      region: Schema.String,
      city: exactOptional(Schema.String),
      carrier: Schema.String,
      healthy: Schema.Boolean,
      egressIp: exactOptional(Schema.String),
    }),
  ),
  capturedAt: IsoTimestamp,
});

const CapabilityHealth = Schema.Struct({
  capability: Schema.Literal("all_traffic", "managed_sessions", "stateless_traffic", "health_verification"),
  status: Schema.Literal("operational", "degraded", "unavailable"),
  providerStatusAt: exactOptional(IsoTimestamp),
  endToEndValidatedAt: exactOptional(IsoTimestamp),
  message: exactOptional(Schema.String),
});

const GeographyHealth = Schema.Struct({
  country: Schema.String,
  city: exactOptional(Schema.String),
  status: Schema.Literal("operational", "degraded", "unavailable"),
  validatedAt: IsoTimestamp,
  source: Schema.Literal("passive", "synthetic"),
});

const CapabilityHealthSnapshotSchema: Schema.Schema<CapabilityHealthSnapshot> = Schema.Struct({
  id: Schema.String,
  generatedAt: IsoTimestamp,
  capabilities: mutableArray(CapabilityHealth),
  providers: mutableArray(ProviderHealthSchema),
  geographies: mutableArray(GeographyHealth),
});

const HealthAlertEventSchema: Schema.Schema<HealthAlertEvent> = Schema.Struct({
  id: Schema.String,
  dedupeKey: Schema.String,
  kind: Schema.Literal("alert", "recovery"),
  capability: Schema.Literal("all_traffic", "managed_sessions", "stateless_traffic", "health_verification"),
  status: Schema.Literal("operational", "degraded", "unavailable"),
  previousStatus: exactOptional(Schema.Literal("degraded", "unavailable")),
  severity: Schema.Literal("critical", "warning", "info"),
  createdAt: IsoTimestamp,
  snapshotId: Schema.String,
  configurationVersion: Schema.String,
  geographies: mutableArray(GeographyHealth),
});

const HealthAlertStateSchema: Schema.Schema<HealthAlertState> = Schema.Struct({
  capability: Schema.Literal("all_traffic", "managed_sessions", "stateless_traffic", "health_verification"),
  observedStatus: Schema.Literal("operational", "degraded", "unavailable"),
  observedSince: IsoTimestamp,
  alertedStatus: exactOptional(Schema.Literal("degraded", "unavailable")),
  alertedAt: exactOptional(IsoTimestamp),
  updatedAt: IsoTimestamp,
});

const HealthAlertDeliverySchema: Schema.Schema<HealthAlertDelivery> = Schema.Struct({
  alertId: Schema.String,
  destinationId: Schema.String,
  status: Schema.Literal("pending", "delivered", "failed"),
  attemptCount: NonNegativeInteger,
  nextAttemptAt: IsoTimestamp,
  lastAttemptAt: exactOptional(IsoTimestamp),
  deliveredAt: exactOptional(IsoTimestamp),
  responseStatus: exactOptional(Schema.Number.pipe(Schema.int(), Schema.between(100, 599))),
  error: exactOptional(Schema.String),
  event: HealthAlertEventSchema,
});

const UsageRecordSchema: Schema.Schema<UsageRecord> = Schema.Struct({
  kind: Schema.Literal("attempt", "capacity"),
  id: Schema.String,
  logicalOperationId: Schema.String,
  jobId: exactOptional(Schema.String),
  accessGrantId: Schema.String,
  sessionMode: exactOptional(Schema.Literal("managed", "stateless")),
  sessionId: exactOptional(Schema.String),
  routeId: Schema.String,
  userId: Schema.String,
  customerId: Schema.String,
  provider: Schema.Literal("bright_data", "proxidize", "unresolved"),
  protocol: Schema.Literal("http", "https", "socks5"),
  outcome: Schema.Literal("success", "http_error", "retry", "failure"),
  retryIndex: NonNegativeInteger,
  failover: Schema.Boolean,
  bytesSent: NonNegativeInteger,
  bytesReceived: NonNegativeInteger,
  latencyMs: exactOptional(NonNegativeNumber),
  destinationDomain: exactOptional(Schema.String),
  destinationHost: exactOptional(Schema.String),
  destinationPort: exactOptional(PositiveInteger),
  destinationPathTemplate: exactOptional(Schema.String),
  country: exactOptional(Schema.String),
  city: exactOptional(Schema.String),
  endpointId: exactOptional(Schema.String),
  proxySlotId: exactOptional(Schema.String),
  upstreamConnectionId: exactOptional(Schema.String),
  connectionStartedAt: exactOptional(IsoTimestamp),
  connectionEndedAt: exactOptional(IsoTimestamp),
  selectedSlotLoad: exactOptional(NonNegativeInteger),
  capacityPressure: exactOptional(Schema.Boolean),
  capacityPressureProvider: exactOptional(Schema.Literal("bright_data", "proxidize")),
  capacityConstraint: exactOptional(Schema.Literal("slot_exhaustion", "geography", "carrier", "hard_limit", "capacity_circuit")),
  establishmentWaitMs: exactOptional(NonNegativeNumber),
  capacityPolicyVersion: exactOptional(Schema.String),
  providerOverride: exactOptional(Schema.Literal("bright_data", "proxidize")),
  capacityCircuitState: exactOptional(Schema.Literal("closed", "open", "half_open")),
  capacityCircuitReason: exactOptional(Schema.Literal("provider_hard_limit", "capacity_failure", "establishment_failure", "timeout")),
  capacityCircuitCooldownUntil: exactOptional(IsoTimestamp),
  routingPolicyVersion: exactOptional(Schema.String),
  routingScore: exactOptional(NonNegativeNumber),
  routingScoreComponents: exactOptional(
    Schema.Struct({
      reliability: NonNegativeNumber,
      headroom: NonNegativeNumber,
      performance: NonNegativeNumber,
      costEfficiency: NonNegativeNumber,
      stability: NonNegativeNumber,
    }),
  ),
  sessionAffinityHit: exactOptional(Schema.Boolean),
  sessionRebindCause: exactOptional(Schema.String),
  desiredProviderClass: exactOptional(Schema.Literal("residential", "device_backed")),
  currentProviderClass: exactOptional(Schema.Literal("residential", "device_backed")),
  degradedFallback: exactOptional(Schema.Boolean),
  failbackOutcome: exactOptional(Schema.Literal("not_attempted", "success", "failure")),
  pricingVersion: exactOptional(Schema.String),
  pricingModel: exactOptional(Schema.Literal("per_gib", "per_device_month")),
  priceUsd: exactOptional(NonNegativeNumber),
  capacityState: exactOptional(Schema.Literal("healthy_idle", "unhealthy")),
  startedAt: IsoTimestamp,
  completedAt: IsoTimestamp,
});

const UsageRollupSchema: Schema.Schema<UsageRollup> = Schema.Struct({
  id: Schema.String,
  interval: Schema.Literal("hour", "day", "week", "month"),
  periodStartedAt: IsoTimestamp,
  periodEndsAt: IsoTimestamp,
  group: Schema.Record({ key: Schema.String, value: Schema.String }),
  requestCount: NonNegativeInteger,
  successCount: NonNegativeInteger,
  retryCount: NonNegativeInteger,
  failoverCount: NonNegativeInteger,
  bytesSent: NonNegativeInteger,
  bytesReceived: NonNegativeInteger,
  averageLatencyMs: NonNegativeNumber,
  p95LatencyMs: NonNegativeNumber,
  activeConnectionMs: NonNegativeNumber,
  provisionedSlotMs: NonNegativeNumber,
  healthyIdleSlotMs: NonNegativeNumber,
  unhealthySlotMs: NonNegativeNumber,
  slotOccupancy: NonNegativeNumber,
  currentSlotOccupancy: NonNegativeNumber,
  provisionedSlots: NonNegativeInteger,
  activeConnections: NonNegativeInteger,
  peakConcurrentConnections: NonNegativeInteger,
  p95ConcurrentConnections: NonNegativeNumber,
  concurrencyUtilization: NonNegativeNumber,
  throughputUtilization: NonNegativeNumber,
  prioritizedGbUsed: NonNegativeNumber,
  prioritizedGbForecast: NonNegativeNumber,
  capacityDrivenFallbackCount: NonNegativeInteger,
  capacityFailureCount: NonNegativeInteger,
  capacityWaitMs: NonNegativeNumber,
  capacityConstraint: exactOptional(Schema.Literal("slot_exhaustion", "geography", "carrier", "hard_limit", "capacity_circuit")),
  capacityPolicyVersion: Schema.String,
  providerSpendUsd: NonNegativeNumber,
  attributedCostUsd: NonNegativeNumber,
  estimatedCostUsd: NonNegativeNumber,
  costStatus: Schema.Literal("estimated", "reconciled"),
  pricingVersions: mutableArray(Schema.String),
  updatedAt: IsoTimestamp,
});

const UsageReconciliationSchema: Schema.Schema<UsageReconciliation> = Schema.Struct({
  id: Schema.String,
  provider: Schema.Literal("bright_data", "proxidize"),
  periodStartedAt: IsoTimestamp,
  periodEndsAt: IsoTimestamp,
  estimatedTotalUsd: NonNegativeNumber,
  reportedTotalUsd: NonNegativeNumber,
  varianceUsd: Schema.Number,
  relativeVariance: NonNegativeNumber,
  varianceAttribution: Schema.Literal("Unallocated"),
  severity: Schema.Literal("normal", "warning", "error"),
  sourceVersion: Schema.String,
  createdAt: IsoTimestamp,
});

const UsageAlertEventSchema: Schema.Schema<UsageAlertEvent> = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("capacity_recommendation", "reconciliation_variance"),
  severity: Schema.Literal("warning", "error"),
  provider: Schema.Literal("bright_data", "proxidize"),
  periodStartedAt: IsoTimestamp,
  periodEndsAt: IsoTimestamp,
  relatedRecordId: Schema.String,
  capacityPolicyVersion: exactOptional(Schema.String),
  capacityConstraint: exactOptional(Schema.Literal("slot_exhaustion", "geography", "carrier", "hard_limit", "capacity_circuit")),
  capacityDrivenFallbackCount: exactOptional(NonNegativeInteger),
  capacityFailureCount: exactOptional(NonNegativeInteger),
  capacityWaitMs: exactOptional(NonNegativeNumber),
  varianceUsd: exactOptional(Schema.Number),
  relativeVariance: exactOptional(NonNegativeNumber),
  createdAt: IsoTimestamp,
});

const CapacityPressureEvidenceSchema: Schema.Schema<CapacityPressureEvidence> = Schema.Struct({
  id: Schema.String,
  provider: Schema.Literal("bright_data", "proxidize"),
  periodStartedAt: IsoTimestamp,
  periodEndsAt: IsoTimestamp,
  relatedRollupId: Schema.String,
  capacityPolicyVersion: Schema.String,
  capacityConstraint: exactOptional(Schema.Literal("slot_exhaustion", "geography", "carrier", "hard_limit", "capacity_circuit")),
  capacityDrivenFallbackCount: NonNegativeInteger,
  capacityFailureCount: NonNegativeInteger,
  capacityWaitMs: NonNegativeNumber,
  concurrencyUtilization: NonNegativeNumber,
  throughputUtilization: NonNegativeNumber,
  observedAt: IsoTimestamp,
});

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown): A =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

function requirePositivePeriod<A extends { periodStartedAt: string; periodEndsAt: string }>(value: A): A {
  if (value.periodStartedAt >= value.periodEndsAt) {
    throw new TypeError("Persisted accounting record must have a positive time range");
  }
  return value;
}

export const decodeStoredAccessGrantCredential = (value: unknown): StoredAccessGrantCredential =>
  decode(StoredAccessGrantCredentialSchema, value);
export const decodeStoredAccessGrant = (value: unknown): StoredAccessGrant => decode(StoredAccessGrantSchema, value);
export const decodeStoredLogicalSession = (value: unknown): StoredLogicalSession => decode(StoredLogicalSessionSchema, value);
export const decodeStoredRoute = (value: unknown): StoredRoute => decode(StoredRouteSchema, value);
export const decodeActiveTunnel = (value: unknown): ActiveTunnel => decode(ActiveTunnelSchema, value);
export const decodeCapacityCircuitState = (value: unknown): CapacityCircuitState => decode(CapacityCircuitStateSchema, value);
export const decodeDeploymentDrainState = (value: unknown): DeploymentDrainState => decode(DeploymentDrainStateSchema, value);
export const decodeProviderHealth = (value: unknown): ProviderHealth => decode(ProviderHealthSchema, value);
export const decodeProviderInventorySnapshot = (value: unknown): ProviderInventorySnapshot =>
  decode(ProviderInventorySnapshotSchema, value);
export const decodeCapabilityHealthSnapshot = (value: unknown): CapabilityHealthSnapshot => decode(CapabilityHealthSnapshotSchema, value);
export const decodeHealthAlertEvent = (value: unknown): HealthAlertEvent => decode(HealthAlertEventSchema, value);
export const decodeHealthAlertState = (value: unknown): HealthAlertState => decode(HealthAlertStateSchema, value);
export const decodeHealthAlertDelivery = (value: unknown): HealthAlertDelivery => decode(HealthAlertDeliverySchema, value);
export const decodeUsageRecord = (value: unknown): UsageRecord => decode(UsageRecordSchema, value);
export const decodeUsageRollup = (value: unknown): UsageRollup => requirePositivePeriod(decode(UsageRollupSchema, value));
export const decodeUsageReconciliation = (value: unknown): UsageReconciliation =>
  requirePositivePeriod(decode(UsageReconciliationSchema, value));
export const decodeUsageAlertEvent = (value: unknown): UsageAlertEvent => requirePositivePeriod(decode(UsageAlertEventSchema, value));
export const decodeCapacityPressureEvidence = (value: unknown): CapacityPressureEvidence =>
  requirePositivePeriod(decode(CapacityPressureEvidenceSchema, value));
