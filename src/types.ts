export type ProviderId = "bright_data" | "proxidize";
export type ProviderClass = "residential" | "device_backed";
export type DataPlaneProtocol = "http" | "https" | "socks5";
export type UpstreamProxyProtocol = "http" | "socks5";
export type DnsResolutionBehavior = "provider_configurable" | "provider_remote" | "unverified";
export type ExactCitySupport = "provider_guaranteed" | "verifiable" | "unsupported";
export const ACTIVE_CONNECTION_TTL_MS = 2 * 60_000;

export interface ProxyTarget {
  host: string;
  port: number;
}

export interface Targeting {
  country?: string;
  region?: string;
  city?: string;
  postalCode?: string;
  asn?: number;
  carrier?: string;
}

export type RotationPolicy = { mode: "per_request" } | { mode: "interval"; intervalSeconds: number } | { mode: "manual" };

export interface RetryPolicy {
  maxAttempts: number;
}

export type SessionMode = "managed" | "stateless";
export type PublicSessionMode = "managed" | "none";

export interface RouteProfileInput {
  customerId: string;
  geography?: {
    countryCode?: string;
    regionCode?: string;
    city?: string;
  };
  carrier?: string;
  providerOverride?: ProviderId;
  allowConnectionRetry: boolean;
}

export interface RouteProfile {
  /** Internal display label; not part of the public profile contract. */
  name: string;
  customerId: string;
  geography?: NonNullable<RouteProfileInput["geography"]>;
  carrier?: string;
  providerOverride?: ProviderId;
  allowConnectionRetry: boolean;
  userId: string;
  /** Internal policy derived from the provider-neutral profile. */
  allowedProtocols: DataPlaneProtocol[];
  targeting: Targeting;
  rotation: RotationPolicy;
  shouldRetry: boolean;
  retryPolicy: RetryPolicy;
}

export type RouteStatus = "ready" | "revoked";

export interface StoredRoute extends RouteProfile {
  id: string;
  status: RouteStatus;
  /** Set only by an explicit emergency revocation; routine revocation leaves active connections alone. */
  terminateActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AccessGrantStatus = "ready" | "revoked";

export type StoredAccessGrantCredentialStatus = "active" | "overlap" | "revoked";
export type PublicAccessGrantCredentialStatus = StoredAccessGrantCredentialStatus | "expired";

export interface StoredAccessGrantCredential {
  id: string;
  sessionMode: SessionMode;
  sessionId?: string;
  tokenSalt: string;
  tokenHash: string;
  status: StoredAccessGrantCredentialStatus;
  createdAt: string;
  renewalDueAt: string;
  expiresAt: string;
  revokeAt?: string;
  lastUsedAt?: string;
}

export interface PublicAccessGrantCredential {
  credentialId: string;
  username: string;
  sessionMode: PublicSessionMode;
  sessionId?: string;
  status: PublicAccessGrantCredentialStatus;
  createdAt: string;
  renewalDueAt: string;
  renewalDue: boolean;
  expiresAt: string;
  revokeAt?: string;
  lastUsedAt?: string;
}

export interface StoredAccessGrant {
  id: string;
  routeId: string;
  principalId: string;
  jobId?: string;
  credentials: StoredAccessGrantCredential[];
  status: AccessGrantStatus;
  /** Set only by an explicit emergency revocation. */
  terminateActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedAccessGrant {
  grant: StoredAccessGrant;
  credential: StoredAccessGrantCredential;
}

export interface PublicAccessGrant {
  grantId: string;
  profileId: string;
  jobId?: string;
  status: AccessGrantStatus;
  credentials: PublicAccessGrantCredential[];
  createdAt: string;
  updatedAt: string;
}

export type LogicalSessionStatus = "open" | "closed";

export interface SessionAffinity {
  provider: ProviderId;
  providerClass: ProviderClass;
  candidateId: string;
  affinityHandle: string;
  profileFingerprint: string;
  desiredProviderClass: ProviderClass;
  currentProviderClass: ProviderClass;
  degradedFallback: boolean;
  boundAt: string;
  lastUsedAt: string;
}

export interface StoredLogicalSession {
  id: string;
  grantId: string;
  routeId: string;
  status: LogicalSessionStatus;
  terminateActive: boolean;
  bindingVersion: number;
  affinity?: SessionAffinity;
  preferredClassHealthySince?: string;
  lastDisconnectedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicLogicalSession {
  sessionId: string;
  grantId: string;
  profileId: string;
  status: LogicalSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  closedAt?: string;
}

/** Route policy resolved through a successfully authenticated access grant. */
export interface AuthenticatedRoute extends StoredRoute {
  accessGrantId: string;
  credentialId: string;
  jobId?: string;
  sessionMode: SessionMode;
  sessionId?: string;
}

export interface PublicRoute {
  profileId: string;
  customerId: string;
  geography?: NonNullable<RouteProfileInput["geography"]>;
  carrier?: string;
  providerOverride: ProviderId | null;
  allowConnectionRetry: boolean;
  status: RouteStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MobileEndpoint {
  id: string;
  username: string;
  password: string;
  host: string;
  port: number;
  country: string;
  region: string;
  city?: string;
  carrier: string;
  publicKey: string;
  deviceId?: string;
  healthy: boolean;
  egressIp?: string;
}

export interface ProviderInventorySnapshot {
  provider: "proxidize";
  providerAccountId: string;
  slots: Array<{
    proxySlotId: string;
    deviceId?: string;
    country: string;
    region: string;
    city?: string;
    carrier: string;
    healthy: boolean;
    egressIp?: string;
  }>;
  capturedAt: string;
}

export type AssignmentMode = "provider_guaranteed" | "service_verified" | "unverified";
export type CandidateChangeReason = "selection" | "retry" | "failover" | "rotation" | "provider_initiated";
export type CapacityCircuitStatus = "closed" | "open" | "half_open";
export type CapacityCircuitReason = "provider_hard_limit" | "capacity_failure" | "establishment_failure" | "timeout";

export interface CapacityCircuitState {
  provider: ProviderId;
  candidateKey: string;
  status: CapacityCircuitStatus;
  consecutiveFailures: number;
  openCount: number;
  reason?: CapacityCircuitReason;
  cooldownUntil?: string;
  probeExpiresAt?: string;
  updatedAt: string;
  expiresAt: string;
}

export interface AssignmentEvidence {
  candidateId: string;
  proxySlotId?: string;
  assignmentMode: AssignmentMode;
  providerManagedReassignmentDisabled: boolean;
  changeReason: CandidateChangeReason;
  previousCandidateId?: string;
  providerSessionId?: string;
  peerId?: string;
  deviceId?: string;
  egressIp?: string;
  opaqueIpId?: string;
  expectedCity?: string;
  observedCity?: string;
  verificationSource?: string;
}

export interface UpstreamEndpoint {
  provider: ProviderId;
  endpointId: string;
  protocol: UpstreamProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  /** Internal Proxidize inventory identity. Never returned through caller-facing APIs. */
  proxySlotId?: string;
  upstreamConnectionId?: string;
  upstreamConnectionStartedAt?: string;
  selectedSlotLoad?: number;
  capacityPressure?: boolean;
  capacityPressureProvider?: ProviderId;
  capacityPolicyVersion?: string;
  activeLoadClaimId?: string;
  capacityCircuitKey?: string;
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
  assignment: AssignmentEvidence;
}

export interface ActiveTunnel {
  id: string;
  deploymentId: string;
  routeId: string;
  accessGrantId: string;
  sessionId?: string;
  protocol: DataPlaneProtocol;
  provider: ProviderId;
  endpointId?: string;
  routingPolicyVersion?: string;
  routingScore?: number;
  startedAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
}

export interface DeploymentDrainState {
  deploymentId: string;
  startedAt: string;
  terminateRemaining: boolean;
  lastNotificationAt?: string;
  extensionUntil?: string;
  updatedAt: string;
}

export interface ProviderCapabilities {
  clientProtocols: ReadonlySet<DataPlaneProtocol>;
  upstreamProtocols: ReadonlySet<UpstreamProxyProtocol>;
  geography: ReadonlySet<keyof Targeting>;
  countries?: ReadonlySet<string>;
  sessions: boolean;
  exactCity: ExactCitySupport;
  assignmentControl: {
    providerManagedReassignment: "disabled" | "observable" | "uncontrolled";
    providerManagedRotation: "disabled" | "uncontrolled";
  };
  rotation: ReadonlySet<RotationPolicy["mode"]>;
  targetPorts: "any_public" | ReadonlySet<number>;
  dnsResolution: {
    http: DnsResolutionBehavior;
    socks5: DnsResolutionBehavior;
  };
  destinationSafety: {
    http: "verified" | "provider_trusted";
    socks5: "verified" | "provider_trusted";
    providerNetworkScope: "external_public_only" | "privileged_or_unknown";
  };
  health: {
    source: "provider_api_or_probe" | "provider_inventory";
  };
  capacity: {
    observation: "provider_api_or_evidence" | "provider_inventory";
    hardLimit: "provider_signal_or_proxy_failure";
    provisioning: "unsupported" | "operator_only" | "adapter_optional";
  };
}

export interface ProviderDescriptor {
  id: ProviderId;
  providerClass: ProviderClass;
  capabilities: ProviderCapabilities;
  pricing: {
    source: "provider_api" | "versioned_config";
    version: string;
    model: "per_gib" | "per_device_month";
    amountUsd: number;
  };
  usageDimensions: {
    common: readonly ["bytes_sent", "bytes_received"];
    providerSpecific: readonly string[];
  };
  costRank: number;
}

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

export type HealthState = "healthy" | "degraded" | "unhealthy";

export interface ProviderHealth {
  provider: ProviderId;
  state: HealthState;
  checkedAt: string;
  message?: string;
}

export type CapabilityName = "all_traffic" | "managed_sessions" | "stateless_traffic" | "health_verification";

export type CapabilityStatus = "operational" | "degraded" | "unavailable";

export interface CapabilityHealth {
  capability: CapabilityName;
  status: CapabilityStatus;
  providerStatusAt?: string;
  endToEndValidatedAt?: string;
  message?: string;
}

export interface GeographyHealth {
  country: string;
  city?: string;
  status: CapabilityStatus;
  validatedAt: string;
  source: "passive" | "synthetic";
}

export interface CapabilityHealthSnapshot {
  id: string;
  generatedAt: string;
  capabilities: CapabilityHealth[];
  providers: ProviderHealth[];
  geographies: GeographyHealth[];
}

export type HealthAlertKind = "alert" | "recovery";
export type HealthAlertSeverity = "critical" | "warning" | "info";
export type HealthAlertDeliveryStatus = "pending" | "delivered" | "failed";

export interface HealthAlertEvent {
  id: string;
  dedupeKey: string;
  kind: HealthAlertKind;
  capability: CapabilityName;
  status: CapabilityStatus;
  previousStatus?: Exclude<CapabilityStatus, "operational">;
  severity: HealthAlertSeverity;
  createdAt: string;
  snapshotId: string;
  configurationVersion: string;
  geographies: GeographyHealth[];
}

export interface HealthAlertState {
  capability: CapabilityName;
  observedStatus: CapabilityStatus;
  observedSince: string;
  alertedStatus?: Exclude<CapabilityStatus, "operational">;
  alertedAt?: string;
  updatedAt: string;
}

export interface HealthAlertDelivery {
  alertId: string;
  destinationId: string;
  status: HealthAlertDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  responseStatus?: number;
  error?: string;
  event: HealthAlertEvent;
}

export interface PassiveHealthSignal {
  provider: ProviderId;
  capability: Exclude<CapabilityName, "health_verification">;
  outcome: "success" | "failure";
  observedAt: string;
  country?: string;
  city?: string;
}

export type SyntheticValidationOutcome = "success" | "proxy_failure" | "inconclusive";

export type GeoIpStatus = "available" | "unverifiable" | "unavailable";

export interface GeoIpEvidence {
  status: GeoIpStatus;
  countryCode?: string;
  subdivisionCode?: string;
  city?: string;
  geonameId?: number;
  accuracyRadiusKm?: number;
}

export interface GeoIpDatasetMetadata {
  vendor: string;
  edition: string;
  buildTimestamp: string;
}

export interface GeoIpLookupResult {
  geo: GeoIpEvidence;
  geoDataset?: GeoIpDatasetMetadata;
}

export type GeographyVerification = "match" | "mismatch" | "unverifiable";

export interface SyntheticValidationResult {
  testId: string;
  outcome: SyntheticValidationOutcome;
  checkedAt: string;
  observedIp?: string;
  expectedCountry?: string;
  expectedCity?: string;
  country?: string;
  city?: string;
  geoStatus?: GeoIpStatus;
  geographyVerification?: GeographyVerification;
  geoDataset?: GeoIpDatasetMetadata;
  message?: string;
}

export interface ListenAddress {
  host: string;
  port: number;
}
