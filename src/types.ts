export type ProviderId = "bright_data" | "proxidize";
export type ProviderClass = "residential" | "device_backed";
export type DataPlaneProtocol = "http" | "https" | "socks5";
export type UpstreamProxyProtocol = "http" | "socks5";
export type DnsResolutionBehavior = "provider_configurable" | "provider_remote" | "unverified";
export type ExactCitySupport = "provider_guaranteed" | "verifiable" | "unsupported";
export const DEVICE_LEASE_IDLE_TIMEOUT_MS = 15 * 60_000;

export interface ProxyTarget {
  host: string;
  port: number;
}

export interface Targeting {
  country: string;
  region?: string;
  city?: string;
  postalCode?: string;
  asn?: number;
  carrier?: string;
}

export type RotationPolicy =
  | { mode: "per_request" }
  | { mode: "interval"; intervalSeconds: number }
  | { mode: "manual" };

export interface RetryPolicy {
  maxAttempts: number;
}

export type SessionPolicy =
  | { mode: "none"; requireGeographicContinuity: false }
  | { mode: "sticky"; id?: string; requireGeographicContinuity: boolean };

export interface RouteProfileInput {
  name: string;
  allowedProtocols?: DataPlaneProtocol[];
  targeting: Targeting;
  rotation?: RotationPolicy;
  session?: {
    mode: "none" | "sticky";
    id?: string;
    requireGeographicContinuity?: boolean;
  };
  customerId: string;
  isAuthenticated: boolean;
  shouldRetry: boolean;
  retryPolicy?: Partial<RetryPolicy>;
  forceProvider?: ProviderId;
}

export interface RouteProfile {
  name: string;
  allowedProtocols: DataPlaneProtocol[];
  targeting: Targeting;
  rotation: RotationPolicy;
  session: SessionPolicy;
  customerId: string;
  userId: string;
  isAuthenticated: boolean;
  shouldRetry: boolean;
  retryPolicy: RetryPolicy;
  forceProvider?: ProviderId;
}

export type RouteStatus = "ready" | "rotating" | "failed" | "revoked";

export interface StoredRoute extends RouteProfile {
  id: string;
  provider: ProviderId;
  endpointId?: string;
  status: RouteStatus;
  /** Set only by an explicit emergency revocation; routine revocation leaves active connections alone. */
  terminateActive: boolean;
  lastError?: string;
  rotationEpoch: number;
  lastRotationAt: string;
  createdAt: string;
  updatedAt: string;
}

export type AccessGrantStatus = "ready" | "revoked";

export type StoredAccessGrantCredentialStatus = "active" | "overlap" | "revoked";
export type PublicAccessGrantCredentialStatus = StoredAccessGrantCredentialStatus | "expired";

export interface StoredAccessGrantCredential {
  id: string;
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
  id: string;
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
  credentials: StoredAccessGrantCredential[];
  endpointId?: string;
  status: AccessGrantStatus;
  /** Set only by an explicit emergency revocation. */
  terminateActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicAccessGrant {
  id: string;
  routeId: string;
  principalId: string;
  status: AccessGrantStatus;
  credentials: PublicAccessGrantCredential[];
  createdAt: string;
  updatedAt: string;
}

/** Route policy resolved through a successfully authenticated access grant. */
export interface AuthenticatedRoute extends StoredRoute {
  accessGrantId: string;
}

export interface PublicRoute extends RouteProfile {
  id: string;
  provider: ProviderId;
  status: RouteStatus;
  lastError?: string;
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
  healthy: boolean;
  egressIp?: string;
}

export type AssignmentMode = "provider_guaranteed" | "service_verified" | "unverified";
export type CandidateChangeReason = "selection" | "retry" | "failover" | "rotation" | "provider_initiated";

export interface AssignmentEvidence {
  candidateId: string;
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
  /** Internal opaque key for a service-owned device lease. Never returned or logged. */
  deviceLeaseKey?: string;
  assignment: AssignmentEvidence;
}

export interface DeviceLease {
  leaseKey: string;
  routeId: string;
  endpointId: string;
  lastActivityAt: string;
  activeUntil: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCapabilities {
  clientProtocols: ReadonlySet<DataPlaneProtocol>;
  upstreamProtocols: ReadonlySet<UpstreamProxyProtocol>;
  authenticatedTraffic: boolean;
  unauthenticatedTraffic: boolean;
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

export type HealthState = "healthy" | "degraded" | "unhealthy";

export interface ProviderHealth {
  provider: ProviderId;
  state: HealthState;
  checkedAt: string;
  message?: string;
}

export type CapabilityName =
  | "all_traffic"
  | "authenticated_traffic"
  | "unauthenticated_traffic"
  | "health_verification";

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
