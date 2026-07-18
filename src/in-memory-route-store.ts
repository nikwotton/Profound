import { scryptSync, timingSafeEqual } from "node:crypto";
import { claimCapacityCircuitProbe, recordCapacityCircuitFailure as nextCapacityCircuitFailure } from "./capacity-circuit.js";
import { NotFoundError } from "./errors.js";
import { InMemoryUsageRepository } from "./in-memory-usage-repository.js";
import { ACCESS_GRANT_CREDENTIAL_OVERLAP_MS, createStoredCredential, credentialUsername, type RouteStore } from "./store.js";
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
  ProviderInventorySnapshot,
  RouteProfile,
  RouteStatus,
  StoredAccessGrant,
  StoredAccessGrantCredential,
  StoredLogicalSession,
  StoredRoute,
  UsageAlertEvent,
  UsageReconciliation,
  UsageRecord,
  UsageRollup,
} from "./types.js";

const copy = <T>(value: T): T => structuredClone(value);

function credentialUsable(credential: StoredAccessGrantCredential, nowMs: number): boolean {
  return (
    credential.status !== "revoked" &&
    Date.parse(credential.expiresAt) > nowMs &&
    (credential.revokeAt === undefined || Date.parse(credential.revokeAt) > nowMs)
  );
}

function circuitKey(provider: StoredRoute["provider"], candidateKey: string): string {
  return `${provider}:${candidateKey}`;
}

export class InMemoryRouteStoreState {
  readonly routes = new Map<string, StoredRoute>();
  readonly grants = new Map<string, StoredAccessGrant>();
  readonly sessions = new Map<string, StoredLogicalSession>();
  readonly tunnels = new Map<string, ActiveTunnel>();
  readonly circuits = new Map<string, CapacityCircuitState>();
  readonly drains = new Map<string, DeploymentDrainState>();
  readonly health = new Map<ProviderHealth["provider"], ProviderHealth>();
  readonly inventory = new Map<ProviderInventorySnapshot["provider"], ProviderInventorySnapshot>();
  readonly capabilityHealth = new Map<string, CapabilityHealthSnapshot>();
  readonly healthAlertStates = new Map<CapabilityName, HealthAlertState>();
  readonly healthAlertEvents = new Map<string, HealthAlertEvent>();
  readonly healthAlertEventIdsByDedupeKey = new Map<string, string>();
  readonly healthAlertDeliveries = new Map<string, HealthAlertDelivery>();
  readonly usageRecords = new Map<string, UsageRecord>();
  readonly usageRollups = new Map<string, UsageRollup>();
  readonly usageReconciliations = new Map<string, UsageReconciliation>();
  readonly usageAlertEvents = new Map<string, UsageAlertEvent>();
  readonly capacityPressureEvidence = new Map<string, CapacityPressureEvidence>();
}

/** Ephemeral persistence for local development and tests. Deployed services use DynamoRouteStore. */
export class InMemoryRouteStore implements RouteStore {
  readonly #usage: InMemoryUsageRepository;

  constructor(
    readonly state = new InMemoryRouteStoreState(),
    private readonly now: () => number = Date.now,
  ) {
    this.#usage = new InMemoryUsageRepository(state);
  }

  #nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  async create(id: string, profile: RouteProfile, provider: StoredRoute["provider"], endpointId?: string): Promise<StoredRoute> {
    if (this.state.routes.has(id)) throw new Error("duplicate_route");
    const now = this.#nowIso();
    const route: StoredRoute = {
      ...copy(profile),
      id,
      provider,
      ...(endpointId === undefined ? {} : { endpointId }),
      status: "ready",
      terminateActive: false,
      rotationEpoch: 0,
      lastRotationAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.state.routes.set(id, route);
    return copy(route);
  }

  async update(id: string, profile: RouteProfile, provider: StoredRoute["provider"]): Promise<StoredRoute> {
    const previous = await this.get(id);
    const route: StoredRoute = {
      ...previous,
      ...copy(profile),
      provider,
      status: "ready",
      updatedAt: this.#nowIso(),
    };
    delete route.endpointId;
    delete route.lastError;
    this.state.routes.set(id, route);
    return copy(route);
  }

  async get(id: string, includeRevoked = false): Promise<StoredRoute> {
    const route = this.state.routes.get(id);
    if (route === undefined || (!includeRevoked && route.status === "revoked")) throw new NotFoundError();
    return copy(route);
  }

  async list(): Promise<StoredRoute[]> {
    return [...this.state.routes.values()]
      .filter((route) => route.status !== "revoked")
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async createAccessGrant(
    id: string,
    routeId: string,
    principalId: string,
    credentialId: string,
    token: string,
    sessionMode: StoredAccessGrantCredential["sessionMode"],
    sessionId?: string,
    jobId?: string,
  ): Promise<StoredAccessGrant> {
    await this.get(routeId);
    if (this.state.grants.has(id)) throw new Error("duplicate_access_grant");
    const now = this.#nowIso();
    const grant: StoredAccessGrant = {
      id,
      routeId,
      principalId,
      ...(jobId === undefined ? {} : { jobId }),
      credentials: [createStoredCredential(credentialId, token, sessionMode, now, sessionId)],
      status: "ready",
      terminateActive: false,
      createdAt: now,
      updatedAt: now,
    };
    this.state.grants.set(id, grant);
    return copy(grant);
  }

  async addAccessGrantCredential(
    id: string,
    credentialId: string,
    token: string,
    sessionMode: StoredAccessGrantCredential["sessionMode"],
    sessionId?: string,
  ): Promise<StoredAccessGrant> {
    const grant = await this.getAccessGrant(id);
    const now = this.#nowIso();
    grant.credentials.push(createStoredCredential(credentialId, token, sessionMode, now, sessionId));
    grant.updatedAt = now;
    this.state.grants.set(id, copy(grant));
    return copy(grant);
  }

  async getAccessGrant(id: string, includeRevoked = false): Promise<StoredAccessGrant> {
    const grant = this.state.grants.get(id);
    if (grant === undefined || (!includeRevoked && grant.status === "revoked")) throw new NotFoundError();
    return copy(grant);
  }

  async listAccessGrants(routeId: string, principalId?: string): Promise<StoredAccessGrant[]> {
    await this.get(routeId);
    return [...this.state.grants.values()]
      .filter((grant) => grant.routeId === routeId && (principalId === undefined || grant.principalId === principalId))
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async authenticateAccessGrant(username: string, token: string): Promise<AuthenticatedAccessGrant | undefined> {
    const grant = [...this.state.grants.values()].find(
      (candidate) =>
        candidate.status !== "revoked" && candidate.credentials.some((credential) => credentialUsername(credential.id) === username),
    );
    if (grant === undefined) return undefined;
    const route = this.state.routes.get(grant.routeId);
    if (route === undefined || route.status === "revoked") return undefined;
    const now = this.#nowIso();
    const nowMs = Date.parse(now);
    const credential = grant.credentials.find((candidate) => {
      if (credentialUsername(candidate.id) !== username || !credentialUsable(candidate, nowMs)) return false;
      const actual = scryptSync(token, candidate.tokenSalt, 32);
      const expected = Buffer.from(candidate.tokenHash, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    if (credential === undefined) return undefined;
    credential.lastUsedAt = now;
    grant.updatedAt = now;
    return copy({ grant, credential });
  }

  async rotateAccessGrantCredential(
    id: string,
    previousCredentialId: string,
    credentialId: string,
    token: string,
    suspectedCompromise = false,
  ): Promise<StoredAccessGrant> {
    const grant = this.state.grants.get(id);
    if (grant === undefined || grant.status === "revoked") throw new NotFoundError();
    const now = this.#nowIso();
    const nowMs = Date.parse(now);
    const overlapLimit = nowMs + ACCESS_GRANT_CREDENTIAL_OVERLAP_MS;
    const previous = grant.credentials.find((credential) => credential.id === previousCredentialId);
    if (previous === undefined || !credentialUsable(previous, nowMs)) throw new NotFoundError();
    grant.credentials = grant.credentials.map((credential) => {
      if (credential.id !== previousCredentialId || !credentialUsable(credential, nowMs)) return credential;
      if (suspectedCompromise) return { ...credential, status: "revoked", revokeAt: now };
      return {
        ...credential,
        status: "overlap",
        revokeAt: new Date(Math.min(Date.parse(credential.expiresAt), overlapLimit)).toISOString(),
      };
    });
    grant.credentials.push(createStoredCredential(credentialId, token, previous.sessionMode, now, previous.sessionId));
    grant.updatedAt = now;
    return copy(grant);
  }

  async revokeAccessGrantCredential(id: string, credentialId: string): Promise<void> {
    const grant = this.state.grants.get(id);
    if (grant === undefined) throw new NotFoundError();
    const credential = grant.credentials.find((candidate) => candidate.id === credentialId);
    if (credential === undefined) throw new NotFoundError();
    if (credential.status === "revoked") return;
    const now = this.#nowIso();
    credential.status = "revoked";
    credential.revokeAt = now;
    grant.updatedAt = now;
  }

  async revokeAccessGrant(id: string, terminateActive = false): Promise<void> {
    const grant = this.state.grants.get(id);
    if (grant === undefined) throw new NotFoundError();
    grant.status = "revoked";
    if (terminateActive) grant.terminateActive = true;
    grant.updatedAt = this.#nowIso();
    await this.closeLogicalSessions(id, terminateActive);
  }

  async createLogicalSession(session: StoredLogicalSession): Promise<void> {
    if (this.state.sessions.has(session.id)) throw new Error("duplicate_logical_session");
    this.state.sessions.set(session.id, copy(session));
  }

  async getLogicalSession(id: string, includeClosed = false): Promise<StoredLogicalSession> {
    const session = this.state.sessions.get(id);
    if (session === undefined || (!includeClosed && session.status === "closed")) throw new NotFoundError();
    return copy(session);
  }

  async listLogicalSessions(grantId: string): Promise<StoredLogicalSession[]> {
    return [...this.state.sessions.values()]
      .filter((session) => session.grantId === grantId)
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async saveLogicalSession(session: StoredLogicalSession, expectedBindingVersion: number): Promise<boolean> {
    const current = this.state.sessions.get(session.id);
    if (current === undefined || current.bindingVersion !== expectedBindingVersion || current.status === "closed") return false;
    this.state.sessions.set(session.id, copy(session));
    return true;
  }

  async closeLogicalSession(id: string, terminateActive = false): Promise<void> {
    const session = await this.getLogicalSession(id, true);
    if (session.status === "closed") return;
    const now = this.#nowIso();
    session.status = "closed";
    session.terminateActive = terminateActive;
    session.closedAt = now;
    session.updatedAt = now;
    session.bindingVersion += 1;
    this.state.sessions.set(id, copy(session));
  }

  async closeLogicalSessions(grantId: string, terminateActive = false): Promise<void> {
    for (const session of await this.listLogicalSessions(grantId)) await this.closeLogicalSession(session.id, terminateActive);
  }

  async revoke(id: string, terminateActive = false): Promise<void> {
    const route = this.state.routes.get(id);
    if (route === undefined || (route.status === "revoked" && !terminateActive)) throw new NotFoundError();
    route.status = "revoked";
    route.terminateActive = terminateActive || route.terminateActive;
    route.updatedAt = this.#nowIso();
  }

  async shouldTerminateActive(id: string, accessGrantId?: string, sessionId?: string): Promise<boolean> {
    if (this.state.routes.get(id)?.terminateActive === true) return true;
    if (accessGrantId !== undefined && this.state.grants.get(accessGrantId)?.terminateActive === true) return true;
    return sessionId !== undefined && this.state.sessions.get(sessionId)?.terminateActive === true;
  }

  async registerActiveTunnel(tunnel: ActiveTunnel): Promise<void> {
    if (this.state.tunnels.has(tunnel.id)) throw new Error("duplicate_active_tunnel");
    this.state.tunnels.set(tunnel.id, copy(tunnel));
  }

  async claimActiveTunnelSlot(
    candidateEndpointIds: readonly string[],
    selectEndpoint: (loads: ReadonlyMap<string, number>) => string,
    createTunnel: (endpointId: string) => ActiveTunnel,
  ): Promise<{ tunnel: ActiveTunnel; activeConnections: number }> {
    if (candidateEndpointIds.length === 0) throw new Error("no_slot_candidates");
    const candidates = new Set(candidateEndpointIds);
    const loads = new Map<string, number>();
    const now = this.#nowIso();
    for (const tunnel of this.state.tunnels.values()) {
      if (
        tunnel.expiresAt <= now ||
        tunnel.provider !== "proxidize" ||
        tunnel.endpointId === undefined ||
        !candidates.has(tunnel.endpointId)
      )
        continue;
      loads.set(tunnel.endpointId, (loads.get(tunnel.endpointId) ?? 0) + 1);
    }
    const endpointId = selectEndpoint(loads);
    if (!candidates.has(endpointId)) throw new Error("invalid_slot_selection");
    const tunnel = createTunnel(endpointId);
    await this.registerActiveTunnel(tunnel);
    return { tunnel: copy(tunnel), activeConnections: (loads.get(endpointId) ?? 0) + 1 };
  }

  async heartbeatActiveTunnel(id: string, lastHeartbeatAt: string, expiresAt: string): Promise<void> {
    const tunnel = this.state.tunnels.get(id);
    if (tunnel === undefined) return;
    tunnel.lastHeartbeatAt = lastHeartbeatAt;
    tunnel.expiresAt = expiresAt;
  }

  async removeActiveTunnel(id: string): Promise<void> {
    this.state.tunnels.delete(id);
  }

  async listActiveTunnels(deploymentId: string, now = this.#nowIso()): Promise<ActiveTunnel[]> {
    return (await this.listAllActiveTunnels(now)).filter((tunnel) => tunnel.deploymentId === deploymentId);
  }

  async listAllActiveTunnels(now = this.#nowIso()): Promise<ActiveTunnel[]> {
    return [...this.state.tunnels.values()]
      .filter((tunnel) => tunnel.expiresAt > now)
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map(copy);
  }

  async getCapacityCircuit(
    provider: StoredRoute["provider"],
    candidateKey: string,
    now = this.#nowIso(),
  ): Promise<CapacityCircuitState | undefined> {
    const key = circuitKey(provider, candidateKey);
    const state = this.state.circuits.get(key);
    if (state !== undefined && state.expiresAt <= now) {
      this.state.circuits.delete(key);
      return undefined;
    }
    return state === undefined ? undefined : copy(state);
  }

  async claimCapacityCircuit(
    provider: StoredRoute["provider"],
    candidateKey: string,
    now: string,
  ): Promise<{ allowed: boolean; state?: CapacityCircuitState }> {
    const previous = await this.getCapacityCircuit(provider, candidateKey, now);
    const claim = claimCapacityCircuitProbe(previous, Date.parse(now));
    if (claim.state !== undefined && claim.state !== previous)
      this.state.circuits.set(circuitKey(provider, candidateKey), copy(claim.state));
    return copy(claim);
  }

  async recordCapacityCircuitFailure(
    provider: StoredRoute["provider"],
    candidateKey: string,
    reason: CapacityCircuitReason,
    now: string,
  ): Promise<CapacityCircuitState> {
    const previous = this.state.circuits.get(circuitKey(provider, candidateKey));
    const state = nextCapacityCircuitFailure(previous, provider, candidateKey, reason, Date.parse(now));
    this.state.circuits.set(circuitKey(provider, candidateKey), state);
    return copy(state);
  }

  async resetCapacityCircuit(provider: StoredRoute["provider"], candidateKey: string): Promise<void> {
    this.state.circuits.delete(circuitKey(provider, candidateKey));
  }

  async listCapacityCircuits(now = this.#nowIso()): Promise<CapacityCircuitState[]> {
    for (const [key, state] of this.state.circuits) if (state.expiresAt <= now) this.state.circuits.delete(key);
    return [...this.state.circuits.values()]
      .toSorted((left, right) => left.provider.localeCompare(right.provider) || left.candidateKey.localeCompare(right.candidateKey))
      .map(copy);
  }

  async getDeploymentDrain(deploymentId: string): Promise<DeploymentDrainState | undefined> {
    const state = this.state.drains.get(deploymentId);
    return state === undefined ? undefined : copy(state);
  }

  async saveDeploymentDrain(state: DeploymentDrainState): Promise<void> {
    this.state.drains.set(state.deploymentId, copy(state));
  }

  async shouldTerminateDeployment(deploymentId: string): Promise<boolean> {
    return this.state.drains.get(deploymentId)?.terminateRemaining === true;
  }

  async setEndpoint(id: string, endpointId?: string): Promise<StoredRoute> {
    const route = this.state.routes.get(id);
    if (route === undefined || route.status === "revoked") throw new NotFoundError();
    if (endpointId === undefined) delete route.endpointId;
    else route.endpointId = endpointId;
    route.updatedAt = this.#nowIso();
    return copy(route);
  }

  async setStatus(id: string, status: RouteStatus, lastError?: string): Promise<StoredRoute> {
    const route = this.state.routes.get(id);
    if (route === undefined || route.status === "revoked") throw new NotFoundError();
    route.status = status;
    if (lastError === undefined) delete route.lastError;
    else route.lastError = lastError;
    route.updatedAt = this.#nowIso();
    return copy(route);
  }

  async claimScheduledRotation(id: string, dueBefore: string): Promise<StoredRoute | undefined> {
    const route = this.state.routes.get(id);
    if (route === undefined || route.status !== "ready" || route.lastRotationAt > dueBefore) return undefined;
    route.status = "rotating";
    delete route.lastError;
    route.updatedAt = this.#nowIso();
    return copy(route);
  }

  async completeRotation(id: string): Promise<StoredRoute> {
    const route = this.state.routes.get(id);
    if (route === undefined || route.status !== "rotating") throw new NotFoundError();
    const now = this.#nowIso();
    route.status = "ready";
    delete route.lastError;
    route.lastRotationAt = now;
    route.updatedAt = now;
    return copy(route);
  }

  async incrementRotationEpoch(id: string): Promise<StoredRoute> {
    const route = this.state.routes.get(id);
    if (route === undefined || route.status === "revoked") throw new NotFoundError();
    route.rotationEpoch += 1;
    route.updatedAt = this.#nowIso();
    return copy(route);
  }

  async saveHealth(health: ProviderHealth): Promise<void> {
    this.state.health.set(health.provider, copy(health));
  }

  async listHealth(): Promise<ProviderHealth[]> {
    return [...this.state.health.values()].toSorted((left, right) => left.provider.localeCompare(right.provider)).map(copy);
  }

  async saveProviderInventory(snapshot: ProviderInventorySnapshot): Promise<void> {
    this.state.inventory.set(snapshot.provider, copy(snapshot));
  }

  async latestProviderInventory(provider: ProviderInventorySnapshot["provider"]): Promise<ProviderInventorySnapshot | undefined> {
    const snapshot = this.state.inventory.get(provider);
    return snapshot === undefined ? undefined : copy(snapshot);
  }

  async saveCapabilityHealth(snapshot: CapabilityHealthSnapshot): Promise<void> {
    this.state.capabilityHealth.set(snapshot.id, copy(snapshot));
  }

  async latestCapabilityHealth(): Promise<CapabilityHealthSnapshot | undefined> {
    return (await this.capabilityHealthHistory(1))[0];
  }

  async capabilityHealthHistory(limit: number): Promise<CapabilityHealthSnapshot[]> {
    return [...this.state.capabilityHealth.values()]
      .toSorted((left, right) => right.generatedAt.localeCompare(left.generatedAt))
      .slice(0, limit)
      .map(copy);
  }

  async getHealthAlertState(capability: CapabilityName): Promise<HealthAlertState | undefined> {
    const state = this.state.healthAlertStates.get(capability);
    return state === undefined ? undefined : copy(state);
  }

  async saveHealthAlertState(state: HealthAlertState): Promise<void> {
    this.state.healthAlertStates.set(state.capability, copy(state));
  }

  async createHealthAlertEvent(event: HealthAlertEvent, destinationIds: readonly string[]): Promise<boolean> {
    const existingId = this.state.healthAlertEventIdsByDedupeKey.get(event.dedupeKey);
    const persisted = existingId === undefined ? event : this.state.healthAlertEvents.get(existingId);
    if (persisted === undefined) throw new Error("persisted_health_alert_event_missing");
    if (existingId === undefined) {
      this.state.healthAlertEvents.set(event.id, copy(event));
      this.state.healthAlertEventIdsByDedupeKey.set(event.dedupeKey, event.id);
    }
    for (const destinationId of destinationIds) {
      const key = `${persisted.id}:${destinationId}`;
      if (this.state.healthAlertDeliveries.has(key)) continue;
      this.state.healthAlertDeliveries.set(key, {
        alertId: persisted.id,
        destinationId,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: persisted.createdAt,
        event: copy(persisted),
      });
    }
    return existingId === undefined;
  }

  async pendingHealthAlertDeliveries(dueBefore: string, limit: number): Promise<HealthAlertDelivery[]> {
    return [...this.state.healthAlertDeliveries.values()]
      .filter((delivery) => delivery.status === "pending" && delivery.nextAttemptAt <= dueBefore)
      .toSorted((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
      .slice(0, limit)
      .map(copy);
  }

  async saveHealthAlertDelivery(delivery: HealthAlertDelivery): Promise<void> {
    this.state.healthAlertDeliveries.set(`${delivery.alertId}:${delivery.destinationId}`, copy(delivery));
  }

  async healthAlertHistory(limit: number): Promise<HealthAlertEvent[]> {
    return [...this.state.healthAlertEvents.values()]
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(copy);
  }

  recordUsage(record: UsageRecord): Promise<boolean> {
    return this.#usage.recordUsage(record);
  }

  listUsageRecords(from: string, to: string): Promise<UsageRecord[]> {
    return this.#usage.listUsageRecords(from, to);
  }

  saveUsageRollup(rollup: UsageRollup): Promise<void> {
    return this.#usage.saveUsageRollup(rollup);
  }

  listUsageRollups(from: string, to: string, interval: UsageRollup["interval"]): Promise<UsageRollup[]> {
    return this.#usage.listUsageRollups(from, to, interval);
  }

  saveUsageReconciliation(reconciliation: UsageReconciliation): Promise<boolean> {
    return this.#usage.saveUsageReconciliation(reconciliation);
  }

  listUsageReconciliations(from: string, to: string): Promise<UsageReconciliation[]> {
    return this.#usage.listUsageReconciliations(from, to);
  }

  saveUsageAlertEvent(event: UsageAlertEvent): Promise<boolean> {
    return this.#usage.saveUsageAlertEvent(event);
  }

  listUsageAlertEvents(from: string, to: string): Promise<UsageAlertEvent[]> {
    return this.#usage.listUsageAlertEvents(from, to);
  }

  saveCapacityPressureEvidence(evidence: CapacityPressureEvidence): Promise<void> {
    return this.#usage.saveCapacityPressureEvidence(evidence);
  }

  listCapacityPressureEvidence(observedAfter: string): Promise<CapacityPressureEvidence[]> {
    return this.#usage.listCapacityPressureEvidence(observedAfter);
  }
  async close(): Promise<void> {
    // State lifetime is controlled explicitly by the test that owns it.
  }
}
