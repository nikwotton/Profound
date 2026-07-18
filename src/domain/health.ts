import type { ProviderId } from "./routing.js";

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
