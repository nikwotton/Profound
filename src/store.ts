import { randomBytes, scryptSync } from "node:crypto";
import type {
  ActiveTunnel,
  CapabilityHealthSnapshot,
  CapabilityName,
  CapacityCircuitReason,
  CapacityCircuitState,
  CapacityPressureEvidence,
  DeploymentDrainState,
  HealthAlertDelivery,
  HealthAlertEvent,
  HealthAlertState,
  ProviderHealth,
  ProviderInventorySnapshot,
  PublicAccessGrant,
  PublicRoute,
  RouteProfile,
  RouteStatus,
  StoredAccessGrant,
  StoredAccessGrantCredential,
  StoredRoute,
  UsageAlertEvent,
  UsageReconciliation,
  UsageRecord,
  UsageRollup,
} from "./types.js";

export const ACCESS_GRANT_CREDENTIAL_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const ACCESS_GRANT_CREDENTIAL_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const ACCESS_GRANT_CREDENTIAL_OVERLAP_MS = 72 * 60 * 60_000;

function credentialDates(createdAt: string): { renewalDueAt: string; expiresAt: string } {
  const createdAtMs = Date.parse(createdAt);
  return {
    renewalDueAt: new Date(createdAtMs + ACCESS_GRANT_CREDENTIAL_LIFETIME_MS - ACCESS_GRANT_CREDENTIAL_RENEWAL_WINDOW_MS).toISOString(),
    expiresAt: new Date(createdAtMs + ACCESS_GRANT_CREDENTIAL_LIFETIME_MS).toISOString(),
  };
}

export function createStoredCredential(id: string, token: string, createdAt: string): StoredAccessGrantCredential {
  const tokenSalt = randomBytes(16).toString("hex");
  return {
    id,
    tokenSalt,
    tokenHash: scryptSync(token, tokenSalt, 32).toString("hex"),
    status: "active",
    createdAt,
    ...credentialDates(createdAt),
  };
}

export function credentialUsername(credentialId: string): string {
  return `pxy_${credentialId}`;
}

export function toPublicAccessGrant(grant: StoredAccessGrant): PublicAccessGrant {
  const nowMs = Date.now();
  return {
    grantId: grant.id,
    profileId: grant.routeId,
    status: grant.status,
    credentials: grant.credentials.map((credential) => ({
      credentialId: credential.id,
      username: credentialUsername(credential.id),
      status:
        grant.status === "revoked" ||
        credential.status === "revoked" ||
        (credential.revokeAt !== undefined && Date.parse(credential.revokeAt) <= nowMs)
          ? "revoked"
          : Date.parse(credential.expiresAt) <= nowMs
            ? "expired"
            : credential.status,
      createdAt: credential.createdAt,
      renewalDueAt: credential.renewalDueAt,
      renewalDue: Date.parse(credential.renewalDueAt) <= nowMs && Date.parse(credential.expiresAt) > nowMs,
      expiresAt: credential.expiresAt,
      ...(credential.revokeAt === undefined ? {} : { revokeAt: credential.revokeAt }),
      ...(credential.lastUsedAt === undefined ? {} : { lastUsedAt: credential.lastUsedAt }),
    })),
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

export function toPublicRoute(route: StoredRoute): PublicRoute {
  return {
    profileId: route.id,
    customerId: route.customerId,
    ...(route.geography === undefined ? {} : { geography: route.geography }),
    ...(route.carrier === undefined ? {} : { carrier: route.carrier }),
    providerOverride: route.providerOverride ?? null,
    isTargetAuthenticated: route.isTargetAuthenticated,
    allowConnectionRetry: route.allowConnectionRetry,
    status: route.status,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

export interface RouteStore {
  create(id: string, profile: RouteProfile, provider: StoredRoute["provider"], endpointId?: string): Promise<StoredRoute>;
  update(id: string, profile: RouteProfile, provider: StoredRoute["provider"]): Promise<StoredRoute>;
  get(id: string, includeRevoked?: boolean): Promise<StoredRoute>;
  list(): Promise<StoredRoute[]>;
  createAccessGrant(id: string, routeId: string, principalId: string, credentialId: string, token: string): Promise<StoredAccessGrant>;
  getAccessGrant(id: string, includeRevoked?: boolean): Promise<StoredAccessGrant>;
  listAccessGrants(routeId: string, principalId?: string): Promise<StoredAccessGrant[]>;
  authenticateAccessGrant(id: string, token: string): Promise<StoredAccessGrant | undefined>;
  rotateAccessGrantCredential(id: string, credentialId: string, token: string, suspectedCompromise?: boolean): Promise<StoredAccessGrant>;
  revokeAccessGrantCredential(id: string, credentialId: string): Promise<void>;
  revokeAccessGrant(id: string, terminateActive?: boolean): Promise<void>;
  revoke(id: string, terminateActive?: boolean): Promise<void>;
  shouldTerminateActive(id: string, accessGrantId?: string): Promise<boolean>;
  registerActiveTunnel(tunnel: ActiveTunnel): Promise<void>;
  claimActiveTunnelSlot(
    candidateEndpointIds: readonly string[],
    selectEndpoint: (loads: ReadonlyMap<string, number>) => string,
    createTunnel: (endpointId: string) => ActiveTunnel,
  ): Promise<{ tunnel: ActiveTunnel; activeConnections: number }>;
  heartbeatActiveTunnel(id: string, lastHeartbeatAt: string, expiresAt: string): Promise<void>;
  removeActiveTunnel(id: string): Promise<void>;
  listActiveTunnels(deploymentId: string, now?: string): Promise<ActiveTunnel[]>;
  listAllActiveTunnels(now?: string): Promise<ActiveTunnel[]>;
  getCapacityCircuit(provider: StoredRoute["provider"], candidateKey: string, now?: string): Promise<CapacityCircuitState | undefined>;
  claimCapacityCircuit(
    provider: StoredRoute["provider"],
    candidateKey: string,
    now: string,
  ): Promise<{ allowed: boolean; state?: CapacityCircuitState }>;
  recordCapacityCircuitFailure(
    provider: StoredRoute["provider"],
    candidateKey: string,
    reason: CapacityCircuitReason,
    now: string,
  ): Promise<CapacityCircuitState>;
  resetCapacityCircuit(provider: StoredRoute["provider"], candidateKey: string): Promise<void>;
  listCapacityCircuits(now?: string): Promise<CapacityCircuitState[]>;
  getDeploymentDrain(deploymentId: string): Promise<DeploymentDrainState | undefined>;
  saveDeploymentDrain(state: DeploymentDrainState): Promise<void>;
  shouldTerminateDeployment(deploymentId: string): Promise<boolean>;
  setEndpoint(id: string, endpointId?: string): Promise<StoredRoute>;
  setStatus(id: string, status: RouteStatus, lastError?: string): Promise<StoredRoute>;
  claimScheduledRotation(id: string, dueBefore: string): Promise<StoredRoute | undefined>;
  completeRotation(id: string): Promise<StoredRoute>;
  incrementRotationEpoch(id: string): Promise<StoredRoute>;
  saveHealth(health: ProviderHealth): Promise<void>;
  listHealth(): Promise<ProviderHealth[]>;
  saveProviderInventory(snapshot: ProviderInventorySnapshot): Promise<void>;
  latestProviderInventory(provider: ProviderInventorySnapshot["provider"]): Promise<ProviderInventorySnapshot | undefined>;
  saveCapabilityHealth(snapshot: CapabilityHealthSnapshot): Promise<void>;
  latestCapabilityHealth(): Promise<CapabilityHealthSnapshot | undefined>;
  capabilityHealthHistory(limit: number): Promise<CapabilityHealthSnapshot[]>;
  getHealthAlertState(capability: CapabilityName): Promise<HealthAlertState | undefined>;
  saveHealthAlertState(state: HealthAlertState): Promise<void>;
  createHealthAlertEvent(event: HealthAlertEvent, destinationIds: readonly string[]): Promise<boolean>;
  pendingHealthAlertDeliveries(dueBefore: string, limit: number): Promise<HealthAlertDelivery[]>;
  saveHealthAlertDelivery(delivery: HealthAlertDelivery): Promise<void>;
  healthAlertHistory(limit: number): Promise<HealthAlertEvent[]>;
  recordUsage(record: UsageRecord): Promise<boolean>;
  listUsageRecords(from: string, to: string): Promise<UsageRecord[]>;
  saveUsageRollup(rollup: UsageRollup): Promise<void>;
  listUsageRollups(from: string, to: string, interval: UsageRollup["interval"]): Promise<UsageRollup[]>;
  saveUsageReconciliation(reconciliation: UsageReconciliation): Promise<boolean>;
  listUsageReconciliations(from: string, to: string): Promise<UsageReconciliation[]>;
  saveUsageAlertEvent(event: UsageAlertEvent): Promise<boolean>;
  listUsageAlertEvents(from: string, to: string): Promise<UsageAlertEvent[]>;
  saveCapacityPressureEvidence(evidence: CapacityPressureEvidence): Promise<void>;
  listCapacityPressureEvidence(observedAfter: string): Promise<CapacityPressureEvidence[]>;
  close(): Promise<void>;
}
