export interface CredentialLifecyclePolicy {
  readonly version: string;
  readonly lastValidatedAt: string;
  readonly lifetimeMs: number;
  readonly renewalWindowMs: number;
  readonly overlapMs: number;
}

export const CREDENTIAL_LIFECYCLE_POLICY: CredentialLifecyclePolicy = Object.freeze({
  version: "credential-lifecycle-v0-2026-07-18",
  lastValidatedAt: "2026-07-18",
  lifetimeMs: 30 * 24 * 60 * 60_000,
  renewalWindowMs: 7 * 24 * 60 * 60_000,
  overlapMs: 72 * 60 * 60_000,
});

export interface AccountingPolicy {
  readonly version: string;
  readonly lastValidatedAt: string;
  readonly reconciliationCadence: "daily";
  readonly varianceAbsoluteFloorUsd: number;
  readonly varianceWarningRelative: number;
  readonly varianceErrorRelative: number;
}

export const ACCOUNTING_POLICY: AccountingPolicy = Object.freeze({
  version: "usage-accounting-roadmap-2026-07-18",
  lastValidatedAt: "2026-07-18",
  reconciliationCadence: "daily",
  varianceAbsoluteFloorUsd: 1,
  varianceWarningRelative: 0.05,
  varianceErrorRelative: 0.15,
});

export interface ObservabilityPolicy {
  readonly version: string;
  readonly lastValidatedAt: string;
  readonly traceSampling: "all";
  readonly logRetentionDays: number;
}

export const OBSERVABILITY_POLICY: ObservabilityPolicy = Object.freeze({
  version: "observability-v0-2026-07-18",
  lastValidatedAt: "2026-07-18",
  traceSampling: "all",
  logRetentionDays: 30,
});

export interface HealthPolicy {
  readonly version: string;
  readonly lastValidatedAt: string;
  readonly syntheticCooldownMs: number;
  readonly geoIpRefreshIntervalMs: number;
  readonly degradedPersistenceMs: number;
}

export const HEALTH_POLICY: HealthPolicy = Object.freeze({
  version: "health-policy-hypotheses-2026-07-18",
  lastValidatedAt: "2026-07-18",
  syntheticCooldownMs: 5 * 60_000,
  geoIpRefreshIntervalMs: (7 * 24 * 60 * 60_000) / 2,
  degradedPersistenceMs: 5 * 60_000,
});

export interface TransportPolicy {
  readonly version: string;
  readonly lastValidatedAt: string;
  readonly streamBufferBytes: number;
  readonly maxHeaderBytes: number;
  readonly allowedTargetPorts: readonly number[];
  readonly blockedTargetHostnames: readonly string[];
}

export const TRANSPORT_POLICY: TransportPolicy = Object.freeze({
  version: "proxy-transport-v0-2026-07-18",
  lastValidatedAt: "2026-07-18",
  streamBufferBytes: 64 * 1024,
  maxHeaderBytes: 32 * 1024,
  allowedTargetPorts: Object.freeze([80, 443]),
  blockedTargetHostnames: Object.freeze([]),
});
