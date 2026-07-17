import { Schema } from "effect";
import type {
  ActiveTunnel,
  CapabilityHealthSnapshot,
  CapacityCircuitState,
  DeploymentDrainState,
  HealthAlertDelivery,
  HealthAlertEvent,
  HealthAlertState,
  ProviderHealth,
  ProviderInventorySnapshot,
  StoredAccessGrant,
  StoredAccessGrantCredential,
  StoredRoute,
  UsageRecord,
  UsageAlertEvent,
  UsageReconciliation,
  UsageRollup,
} from "./types.js";

const mutableArray = <S extends Schema.Schema.Any>(schema: S) => Schema.mutable(Schema.Array(schema));
const exactOptional = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });

const Targeting = Schema.Struct({
  country: exactOptional(Schema.String),
  region: exactOptional(Schema.String),
  city: exactOptional(Schema.String),
  postalCode: exactOptional(Schema.String),
  asn: exactOptional(Schema.Number),
  carrier: exactOptional(Schema.String),
});

const Rotation = Schema.Union(
  Schema.Struct({ mode: Schema.Literal("per_request") }),
  Schema.Struct({ mode: Schema.Literal("interval"), intervalSeconds: Schema.Number }),
  Schema.Struct({ mode: Schema.Literal("manual") }),
);

const Session = Schema.Union(
  Schema.Struct({ mode: Schema.Literal("none"), requireGeographicContinuity: Schema.Literal(false) }),
  Schema.Struct({
    mode: Schema.Literal("sticky"),
    id: exactOptional(Schema.String),
    requireGeographicContinuity: Schema.Boolean,
  }),
);

const StoredAccessGrantCredentialSchema = Schema.Struct({
  id: Schema.String,
  tokenSalt: Schema.String,
  tokenHash: Schema.String,
  status: Schema.Literal("active", "overlap", "revoked"),
  createdAt: Schema.String,
  renewalDueAt: Schema.String,
  expiresAt: Schema.String,
  revokeAt: exactOptional(Schema.String),
  lastUsedAt: exactOptional(Schema.String),
});

const StoredAccessGrantSchema = Schema.Struct({
  id: Schema.String,
  routeId: Schema.String,
  principalId: Schema.String,
  credentials: mutableArray(StoredAccessGrantCredentialSchema),
  status: Schema.Literal("ready", "revoked"),
  terminateActive: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const StoredRouteSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  allowedProtocols: mutableArray(Schema.Literal("http", "https", "socks5")),
  targeting: Targeting,
  rotation: Rotation,
  session: Session,
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
  isTargetAuthenticated: Schema.Boolean,
  allowConnectionRetry: Schema.Boolean,
  userId: Schema.String,
  isAuthenticated: Schema.Boolean,
  shouldRetry: Schema.Boolean,
  retryPolicy: Schema.Struct({ maxAttempts: Schema.Number }),
  provider: Schema.Literal("bright_data", "proxidize"),
  endpointId: exactOptional(Schema.String),
  status: Schema.Literal("ready", "rotating", "failed", "revoked"),
  terminateActive: Schema.Boolean,
  lastError: exactOptional(Schema.String),
  rotationEpoch: Schema.Number,
  lastRotationAt: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ActiveTunnelSchema = Schema.Struct({
  id: Schema.String,
  deploymentId: Schema.String,
  routeId: Schema.String,
  accessGrantId: Schema.String,
  protocol: Schema.Literal("http", "https", "socks5"),
  provider: Schema.Literal("bright_data", "proxidize"),
  endpointId: exactOptional(Schema.String),
  routingPolicyVersion: exactOptional(Schema.String),
  routingScore: exactOptional(Schema.Number),
  startedAt: Schema.String,
  lastHeartbeatAt: Schema.String,
  expiresAt: Schema.String,
});

const CapacityCircuitStateSchema = Schema.Struct({
  provider: Schema.Literal("bright_data", "proxidize"),
  candidateKey: Schema.String,
  status: Schema.Literal("closed", "open", "half_open"),
  consecutiveFailures: Schema.Number,
  openCount: Schema.Number,
  reason: exactOptional(Schema.Literal("provider_hard_limit", "capacity_failure", "establishment_failure", "timeout")),
  cooldownUntil: exactOptional(Schema.String),
  probeExpiresAt: exactOptional(Schema.String),
  updatedAt: Schema.String,
  expiresAt: Schema.String,
});

const DeploymentDrainStateSchema = Schema.Struct({
  deploymentId: Schema.String,
  startedAt: Schema.String,
  terminateRemaining: Schema.Boolean,
  lastNotificationAt: exactOptional(Schema.String),
  extensionUntil: exactOptional(Schema.String),
  updatedAt: Schema.String,
});

const ProviderHealthSchema = Schema.Struct({
  provider: Schema.Literal("bright_data", "proxidize"),
  state: Schema.Literal("healthy", "degraded", "unhealthy"),
  checkedAt: Schema.String,
  message: exactOptional(Schema.String),
});

const ProviderInventorySnapshotSchema = Schema.Struct({
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
  capturedAt: Schema.String,
});

const CapabilityHealth = Schema.Struct({
  capability: Schema.Literal("all_traffic", "authenticated_traffic", "unauthenticated_traffic", "health_verification"),
  status: Schema.Literal("operational", "degraded", "unavailable"),
  providerStatusAt: exactOptional(Schema.String),
  endToEndValidatedAt: exactOptional(Schema.String),
  message: exactOptional(Schema.String),
});

const GeographyHealth = Schema.Struct({
  country: Schema.String,
  city: exactOptional(Schema.String),
  status: Schema.Literal("operational", "degraded", "unavailable"),
  validatedAt: Schema.String,
  source: Schema.Literal("passive", "synthetic"),
});

const CapabilityHealthSnapshotSchema = Schema.Struct({
  id: Schema.String,
  generatedAt: Schema.String,
  capabilities: mutableArray(CapabilityHealth),
  providers: mutableArray(ProviderHealthSchema),
  geographies: mutableArray(GeographyHealth),
});

const HealthAlertEventSchema = Schema.Struct({
  id: Schema.String,
  dedupeKey: Schema.String,
  kind: Schema.Literal("alert", "recovery"),
  capability: Schema.Literal("all_traffic", "authenticated_traffic", "unauthenticated_traffic", "health_verification"),
  status: Schema.Literal("operational", "degraded", "unavailable"),
  previousStatus: exactOptional(Schema.Literal("degraded", "unavailable")),
  severity: Schema.Literal("critical", "warning", "info"),
  createdAt: Schema.String,
  snapshotId: Schema.String,
  configurationVersion: Schema.String,
  geographies: mutableArray(GeographyHealth),
});

const HealthAlertStateSchema = Schema.Struct({
  capability: Schema.Literal("all_traffic", "authenticated_traffic", "unauthenticated_traffic", "health_verification"),
  observedStatus: Schema.Literal("operational", "degraded", "unavailable"),
  observedSince: Schema.String,
  alertedStatus: exactOptional(Schema.Literal("degraded", "unavailable")),
  alertedAt: exactOptional(Schema.String),
  updatedAt: Schema.String,
});

const HealthAlertDeliverySchema = Schema.Struct({
  alertId: Schema.String,
  destinationId: Schema.String,
  status: Schema.Literal("pending", "delivered", "failed"),
  attemptCount: Schema.Number,
  nextAttemptAt: Schema.String,
  lastAttemptAt: exactOptional(Schema.String),
  deliveredAt: exactOptional(Schema.String),
  responseStatus: exactOptional(Schema.Number),
  error: exactOptional(Schema.String),
  event: HealthAlertEventSchema,
});

const UsageRecordSchema = Schema.Struct({
  kind: Schema.Literal("attempt", "capacity"),
  id: Schema.String,
  logicalOperationId: Schema.String,
  accessGrantId: Schema.String,
  routeId: Schema.String,
  userId: Schema.String,
  customerId: Schema.String,
  provider: Schema.Literal("bright_data", "proxidize", "unresolved"),
  protocol: Schema.Literal("http", "https", "socks5"),
  outcome: Schema.Literal("success", "http_error", "retry", "failure"),
  retryIndex: Schema.Number,
  failover: Schema.Boolean,
  bytesSent: Schema.Number,
  bytesReceived: Schema.Number,
  country: exactOptional(Schema.String),
  city: exactOptional(Schema.String),
  endpointId: exactOptional(Schema.String),
  proxySlotId: exactOptional(Schema.String),
  upstreamConnectionId: exactOptional(Schema.String),
  connectionStartedAt: exactOptional(Schema.String),
  connectionEndedAt: exactOptional(Schema.String),
  selectedSlotLoad: exactOptional(Schema.Number),
  capacityPressure: exactOptional(Schema.Boolean),
  capacityConstraint: exactOptional(Schema.Literal("slot_exhaustion", "geography", "carrier", "hard_limit", "capacity_circuit")),
  establishmentWaitMs: exactOptional(Schema.Number),
  capacityPolicyVersion: exactOptional(Schema.String),
  providerOverride: exactOptional(Schema.Literal("bright_data", "proxidize")),
  capacityCircuitState: exactOptional(Schema.Literal("closed", "open", "half_open")),
  capacityCircuitReason: exactOptional(Schema.Literal("provider_hard_limit", "capacity_failure", "establishment_failure", "timeout")),
  capacityCircuitCooldownUntil: exactOptional(Schema.String),
  routingPolicyVersion: exactOptional(Schema.String),
  routingScore: exactOptional(Schema.Number),
  routingScoreComponents: exactOptional(
    Schema.Struct({
      reliability: Schema.Number,
      headroom: Schema.Number,
      performance: Schema.Number,
      costEfficiency: Schema.Number,
      stability: Schema.Number,
    }),
  ),
  pricingVersion: exactOptional(Schema.String),
  pricingModel: exactOptional(Schema.Literal("per_gib", "per_device_month")),
  priceUsd: exactOptional(Schema.Number),
  capacityState: exactOptional(Schema.Literal("healthy_idle", "unhealthy")),
  startedAt: Schema.String,
  completedAt: Schema.String,
});

const UsageRollupSchema = Schema.Struct({
  id: Schema.String,
  interval: Schema.Literal("hour", "day", "week", "month"),
  periodStartedAt: Schema.String,
  periodEndsAt: Schema.String,
  group: Schema.Record({ key: Schema.String, value: Schema.String }),
  requestCount: Schema.Number,
  successCount: Schema.Number,
  retryCount: Schema.Number,
  failoverCount: Schema.Number,
  bytesSent: Schema.Number,
  bytesReceived: Schema.Number,
  activeConnectionMs: Schema.Number,
  provisionedSlotMs: Schema.Number,
  healthyIdleSlotMs: Schema.Number,
  unhealthySlotMs: Schema.Number,
  slotOccupancy: Schema.Number,
  currentSlotOccupancy: Schema.Number,
  provisionedSlots: Schema.Number,
  activeConnections: Schema.Number,
  peakConcurrentConnections: Schema.Number,
  p95ConcurrentConnections: Schema.Number,
  concurrencyUtilization: Schema.Number,
  throughputUtilization: Schema.Number,
  prioritizedGbUsed: Schema.Number,
  prioritizedGbForecast: Schema.Number,
  capacityDrivenFallbackCount: Schema.Number,
  capacityFailureCount: Schema.Number,
  capacityWaitMs: Schema.Number,
  capacityConstraint: exactOptional(Schema.Literal("slot_exhaustion", "geography", "carrier", "hard_limit", "capacity_circuit")),
  capacityPolicyVersion: Schema.String,
  providerSpendUsd: Schema.Number,
  attributedCostUsd: Schema.Number,
  estimatedCostUsd: Schema.Number,
  costStatus: Schema.Literal("estimated", "reconciled"),
  pricingVersions: mutableArray(Schema.String),
  updatedAt: Schema.String,
});

const UsageReconciliationSchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.Literal("bright_data", "proxidize"),
  periodStartedAt: Schema.String,
  periodEndsAt: Schema.String,
  estimatedTotalUsd: Schema.Number,
  reportedTotalUsd: Schema.Number,
  varianceUsd: Schema.Number,
  relativeVariance: Schema.Number,
  varianceAttribution: Schema.Literal("Unallocated"),
  severity: Schema.Literal("normal", "warning", "error"),
  sourceVersion: Schema.String,
  createdAt: Schema.String,
});

const UsageAlertEventSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("capacity_pressure", "reconciliation_variance"),
  severity: Schema.Literal("warning", "error"),
  provider: Schema.Literal("bright_data", "proxidize"),
  periodStartedAt: Schema.String,
  periodEndsAt: Schema.String,
  relatedRecordId: Schema.String,
  capacityPolicyVersion: exactOptional(Schema.String),
  capacityConstraint: exactOptional(Schema.Literal("slot_exhaustion", "geography", "carrier", "hard_limit", "capacity_circuit")),
  capacityDrivenFallbackCount: exactOptional(Schema.Number),
  capacityFailureCount: exactOptional(Schema.Number),
  capacityWaitMs: exactOptional(Schema.Number),
  varianceUsd: exactOptional(Schema.Number),
  relativeVariance: exactOptional(Schema.Number),
  createdAt: Schema.String,
});

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown): A => Schema.decodeUnknownSync(schema)(value);

export const decodeStoredAccessGrantCredential = (value: unknown): StoredAccessGrantCredential =>
  decode(StoredAccessGrantCredentialSchema, value);
export const decodeStoredAccessGrant = (value: unknown): StoredAccessGrant => decode(StoredAccessGrantSchema, value);
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
export const decodeUsageRollup = (value: unknown): UsageRollup => decode(UsageRollupSchema, value);
export const decodeUsageReconciliation = (value: unknown): UsageReconciliation => decode(UsageReconciliationSchema, value);
export const decodeUsageAlertEvent = (value: unknown): UsageAlertEvent => decode(UsageAlertEventSchema, value);
