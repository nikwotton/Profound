import { createHash, randomBytes } from "node:crypto";
import { V0_POLICY } from "./service-policies.js";
import type {
  ActiveTunnel,
  AuthenticatedAccessGrant,
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
  ProviderId,
  ProviderInventorySnapshot,
  PublicAccessGrant,
  PublicLogicalSession,
  PublicRoute,
  RouteProfile,
  StoredAccessGrant,
  StoredAccessGrantCredential,
  StoredLogicalSession,
  StoredRoute,
  UsageAlertEvent,
  UsageReconciliation,
  UsageRecord,
  UsageRollup,
} from "./types.js";

export const ACCESS_GRANT_CREDENTIAL_LIFETIME_MS = V0_POLICY.credentialLifecycle.lifetimeMs;
export const ACCESS_GRANT_CREDENTIAL_RENEWAL_WINDOW_MS = V0_POLICY.credentialLifecycle.renewalWindowMs;
export const ACCESS_GRANT_CREDENTIAL_OVERLAP_MS = V0_POLICY.credentialLifecycle.overlapMs;

export function hashAccessGrantToken(token: string, salt: string): Buffer {
  return createHash("sha256").update(salt, "utf8").update("\0", "utf8").update(token, "utf8").digest();
}

function credentialDates(createdAt: string): { renewalDueAt: string; expiresAt: string } {
  const createdAtMs = Date.parse(createdAt);
  return {
    renewalDueAt: new Date(createdAtMs + ACCESS_GRANT_CREDENTIAL_LIFETIME_MS - ACCESS_GRANT_CREDENTIAL_RENEWAL_WINDOW_MS).toISOString(),
    expiresAt: new Date(createdAtMs + ACCESS_GRANT_CREDENTIAL_LIFETIME_MS).toISOString(),
  };
}

export function createStoredCredential(
  id: string,
  token: string,
  sessionMode: StoredAccessGrantCredential["sessionMode"],
  createdAt: string,
  sessionId?: string,
): StoredAccessGrantCredential {
  const tokenSalt = randomBytes(16).toString("hex");
  return {
    id,
    sessionMode,
    ...(sessionId === undefined ? {} : { sessionId }),
    tokenSalt,
    // Access-grant tokens contain 256 random bits. A salted digest provides
    // one-way storage without putting a password KDF on every proxy request.
    tokenHash: hashAccessGrantToken(token, tokenSalt).toString("hex"),
    status: "active",
    createdAt,
    ...credentialDates(createdAt),
  };
}

export function credentialUsername(credentialId: string): string {
  return `pxy_${credentialId}`;
}

export function toPublicAccessGrant(grant: StoredAccessGrant, nowMs = Date.now()): PublicAccessGrant {
  return {
    grantId: grant.id,
    profileId: grant.routeId,
    ...(grant.jobId === undefined ? {} : { jobId: grant.jobId }),
    status: grant.status,
    credentials: grant.credentials.map((credential) => ({
      credentialId: credential.id,
      username: credentialUsername(credential.id),
      sessionMode: credential.sessionMode === "managed" ? "managed" : "none",
      ...(credential.sessionId === undefined ? {} : { sessionId: credential.sessionId }),
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

export function toPublicLogicalSession(session: StoredLogicalSession): PublicLogicalSession {
  return {
    sessionId: session.id,
    grantId: session.grantId,
    profileId: session.routeId,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.affinity?.lastUsedAt === undefined ? {} : { lastUsedAt: session.affinity.lastUsedAt }),
    ...(session.closedAt === undefined ? {} : { closedAt: session.closedAt }),
  };
}

export function toPublicRoute(route: StoredRoute): PublicRoute {
  return {
    profileId: route.id,
    customerId: route.customerId,
    ...(route.geography === undefined ? {} : { geography: route.geography }),
    ...(route.carrier === undefined ? {} : { carrier: route.carrier }),
    providerOverride: route.providerOverride ?? null,
    allowConnectionRetry: route.allowConnectionRetry,
    status: route.status,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

export interface RouteRepository {
  create(id: string, profile: RouteProfile): Promise<StoredRoute>;
  update(id: string, profile: RouteProfile): Promise<StoredRoute>;
  get(id: string, includeRevoked?: boolean): Promise<StoredRoute>;
  list(userId?: string): Promise<StoredRoute[]>;
  revoke(id: string, terminateActive?: boolean): Promise<void>;
  shouldTerminateActive(id: string, accessGrantId?: string, sessionId?: string): Promise<boolean>;
  getAuthorizationEpoch(): Promise<number>;
}

export interface AccessGrantRepository {
  createAccessGrant(
    id: string,
    routeId: string,
    principalId: string,
    credentialId: string,
    token: string,
    sessionMode: StoredAccessGrantCredential["sessionMode"],
    sessionId?: string,
    jobId?: string,
  ): Promise<StoredAccessGrant>;
  addAccessGrantCredential(
    id: string,
    credentialId: string,
    token: string,
    sessionMode: StoredAccessGrantCredential["sessionMode"],
    sessionId?: string,
  ): Promise<StoredAccessGrant>;
  getAccessGrant(id: string, includeRevoked?: boolean): Promise<StoredAccessGrant>;
  listAccessGrants(routeId: string, principalId?: string): Promise<StoredAccessGrant[]>;
  authenticateAccessGrant(id: string, token: string): Promise<AuthenticatedAccessGrant | undefined>;
  rotateAccessGrantCredential(
    id: string,
    previousCredentialId: string,
    credentialId: string,
    token: string,
    suspectedCompromise?: boolean,
  ): Promise<StoredAccessGrant>;
  revokeAccessGrantCredential(id: string, credentialId: string): Promise<void>;
  revokeAccessGrant(id: string, terminateActive?: boolean): Promise<void>;
}

export interface LogicalSessionRepository {
  createLogicalSession(session: StoredLogicalSession): Promise<void>;
  getLogicalSession(id: string, includeClosed?: boolean): Promise<StoredLogicalSession>;
  listLogicalSessions(grantId: string): Promise<StoredLogicalSession[]>;
  saveLogicalSession(session: StoredLogicalSession, expectedBindingVersion: number): Promise<boolean>;
  closeLogicalSession(id: string, terminateActive?: boolean): Promise<void>;
  closeLogicalSessions(grantId: string, terminateActive?: boolean): Promise<void>;
}

export interface ActiveTunnelRepository {
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
  getActiveConnectionCounts(
    providers: readonly ProviderId[],
    endpointIds: readonly string[],
    sessionIds: readonly string[],
    now?: string,
  ): Promise<{
    providers: ReadonlyMap<ProviderId, number>;
    endpoints: ReadonlyMap<string, number>;
    sessions: ReadonlyMap<string, number>;
  }>;
}

export interface CapacityCircuitRepository {
  getCapacityCircuit(provider: ProviderId, candidateKey: string, now?: string): Promise<CapacityCircuitState | undefined>;
  claimCapacityCircuit(
    provider: ProviderId,
    candidateKey: string,
    now: string,
  ): Promise<{ allowed: boolean; state?: CapacityCircuitState }>;
  recordCapacityCircuitFailure(
    provider: ProviderId,
    candidateKey: string,
    reason: CapacityCircuitReason,
    now: string,
  ): Promise<CapacityCircuitState>;
  resetCapacityCircuit(provider: ProviderId, candidateKey: string): Promise<void>;
  listCapacityCircuits(now?: string): Promise<CapacityCircuitState[]>;
}

export interface DeploymentRepository {
  getDeploymentDrain(deploymentId: string): Promise<DeploymentDrainState | undefined>;
  saveDeploymentDrain(state: DeploymentDrainState): Promise<void>;
  shouldTerminateDeployment(deploymentId: string): Promise<boolean>;
}

export interface ProviderHealthRepository {
  saveHealth(health: ProviderHealth): Promise<void>;
  listHealth(): Promise<ProviderHealth[]>;
  saveProviderInventory(snapshot: ProviderInventorySnapshot): Promise<void>;
  latestProviderInventory(provider: ProviderInventorySnapshot["provider"]): Promise<ProviderInventorySnapshot | undefined>;
}

export interface CapabilityHealthRepository {
  saveCapabilityHealth(snapshot: CapabilityHealthSnapshot): Promise<void>;
  latestCapabilityHealth(): Promise<CapabilityHealthSnapshot | undefined>;
  capabilityHealthHistory(limit: number): Promise<CapabilityHealthSnapshot[]>;
}

export interface HealthAlertRepository {
  getHealthAlertState(capability: CapabilityName): Promise<HealthAlertState | undefined>;
  saveHealthAlertState(state: HealthAlertState): Promise<void>;
  createHealthAlertEvent(event: HealthAlertEvent, destinationIds: readonly string[]): Promise<boolean>;
  pendingHealthAlertDeliveries(dueBefore: string, limit: number): Promise<HealthAlertDelivery[]>;
  saveHealthAlertDelivery(delivery: HealthAlertDelivery): Promise<void>;
  healthAlertHistory(limit: number): Promise<HealthAlertEvent[]>;
}

export interface UsageRepository {
  recordUsage(record: UsageRecord): Promise<boolean>;
  listUsageRecords(from: string, to: string, options?: { limit?: number; newestFirst?: boolean }): Promise<UsageRecord[]>;
  saveUsageRollup(rollup: UsageRollup): Promise<void>;
  listUsageRollups(from: string, to: string, interval: UsageRollup["interval"]): Promise<UsageRollup[]>;
  saveUsageReconciliation(reconciliation: UsageReconciliation): Promise<boolean>;
  listUsageReconciliations(from: string, to: string): Promise<UsageReconciliation[]>;
  saveUsageAlertEvent(event: UsageAlertEvent): Promise<boolean>;
  listUsageAlertEvents(from: string, to: string): Promise<UsageAlertEvent[]>;
  saveCapacityPressureEvidence(evidence: CapacityPressureEvidence): Promise<void>;
  listCapacityPressureEvidence(observedAfter: string): Promise<CapacityPressureEvidence[]>;
}

export interface RouteStore
  extends
    RouteRepository,
    AccessGrantRepository,
    LogicalSessionRepository,
    ActiveTunnelRepository,
    CapacityCircuitRepository,
    DeploymentRepository,
    ProviderHealthRepository,
    CapabilityHealthRepository,
    HealthAlertRepository,
    UsageRepository {
  close(): Promise<void>;
}

export interface RoutingStore
  extends
    RouteRepository,
    AccessGrantRepository,
    LogicalSessionRepository,
    ActiveTunnelRepository,
    CapacityCircuitRepository,
    DeploymentRepository,
    ProviderHealthRepository,
    UsageRepository {}
