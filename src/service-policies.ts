export interface V0Policy {
  readonly version: string;
  readonly definedAt: string;
  readonly credentialLifecycle: {
    readonly lifetimeMs: number;
    readonly renewalWindowMs: number;
    readonly overlapMs: number;
  };
  readonly establishmentBudget: {
    readonly candidatesPerProvider: number;
    readonly providersPerOperation: number;
    readonly attemptTimeoutMs: number;
    readonly operationTimeoutMs: number;
  };
}

/** The complete set of currently authoritative v0 numeric policy decisions. */
export const V0_POLICY: V0Policy = Object.freeze({
  version: "proxy-v0-policy-2026-07-18",
  definedAt: "2026-07-18",
  credentialLifecycle: Object.freeze({
    lifetimeMs: 30 * 24 * 60 * 60_000,
    renewalWindowMs: 7 * 24 * 60 * 60_000,
    overlapMs: 72 * 60 * 60_000,
  }),
  establishmentBudget: Object.freeze({
    candidatesPerProvider: 2,
    providersPerOperation: 3,
    attemptTimeoutMs: 10_000,
    operationTimeoutMs: 30_000,
  }),
});

export interface AccountingPolicy {
  readonly version: string;
  readonly definedAt: string;
  readonly reconciliationCadence: "daily";
  readonly varianceAbsoluteFloorUsd: number;
  readonly varianceWarningRelative: number;
  readonly varianceErrorRelative: number;
}

export const ACCOUNTING_POLICY: AccountingPolicy = Object.freeze({
  version: "experimental-usage-accounting-defaults-2026-07-18",
  definedAt: "2026-07-18",
  reconciliationCadence: "daily",
  varianceAbsoluteFloorUsd: 1,
  varianceWarningRelative: 0.05,
  varianceErrorRelative: 0.15,
});

export interface ObservabilityPolicy {
  readonly version: string;
  readonly definedAt: string;
  readonly traceSampling: "all";
  readonly logRetentionDays: number;
}

export const OBSERVABILITY_POLICY: ObservabilityPolicy = Object.freeze({
  version: "experimental-observability-defaults-2026-07-18",
  definedAt: "2026-07-18",
  traceSampling: "all",
  logRetentionDays: 30,
});

export interface HealthPolicy {
  readonly version: string;
  readonly definedAt: string;
  readonly syntheticCooldownMs: number;
  readonly geoIpRefreshIntervalMs: number;
  readonly degradedPersistenceMs: number;
}

export const HEALTH_POLICY: HealthPolicy = Object.freeze({
  version: "experimental-health-defaults-2026-07-18",
  definedAt: "2026-07-18",
  syntheticCooldownMs: 5 * 60_000,
  geoIpRefreshIntervalMs: (7 * 24 * 60 * 60_000) / 2,
  degradedPersistenceMs: 5 * 60_000,
});

export interface TransportPolicy {
  readonly version: string;
  readonly definedAt: string;
  readonly streamBufferBytes: number;
  readonly maxHeaderBytes: number;
  readonly allowedTargetPorts: readonly number[];
  readonly blockedTargetHostnames: readonly string[];
}

export const TRANSPORT_POLICY: TransportPolicy = Object.freeze({
  version: "experimental-transport-defaults-2026-07-18",
  definedAt: "2026-07-18",
  streamBufferBytes: 64 * 1024,
  maxHeaderBytes: 32 * 1024,
  allowedTargetPorts: Object.freeze([80, 443]),
  blockedTargetHostnames: Object.freeze([]),
});
