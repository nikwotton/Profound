import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expectNumber, expectRecord, expectString, parseJson } from "./decoding.js";
import { claimCapacityCircuitProbe, recordCapacityCircuitFailure } from "./capacity-circuit.js";
import { NotFoundError } from "./errors.js";
import {
  decodeActiveTunnel,
  decodeCapacityCircuitState,
  decodeCapabilityHealthSnapshot,
  decodeDeploymentDrainState,
  decodeHealthAlertDelivery,
  decodeHealthAlertEvent,
  decodeHealthAlertState,
  decodeProviderHealth,
  decodeProviderInventorySnapshot,
  decodeStoredAccessGrant,
  decodeStoredRoute,
  decodeUsageReconciliation,
  decodeUsageAlertEvent,
  decodeUsageRecord,
  decodeUsageRollup,
} from "./storage-decoding.js";
import type {
  CapabilityHealthSnapshot,
  CapabilityName,
  CapacityCircuitReason,
  CapacityCircuitState,
  ActiveTunnel,
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
  UsageRecord,
  UsageAlertEvent,
  UsageReconciliation,
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

function credentialUsable(credential: StoredAccessGrantCredential, nowMs: number): boolean {
  return (
    credential.status !== "revoked" &&
    Date.parse(credential.expiresAt) > nowMs &&
    (credential.revokeAt === undefined || Date.parse(credential.revokeAt) > nowMs)
  );
}

function nullableString(value: unknown, context: string): string | undefined {
  return value === null ? undefined : expectString(value, context);
}

function rowField(row: Record<string, unknown>, name: string, context: string): unknown {
  if (!(name in row)) throw new TypeError(`${context}.${name} is required`);
  return row[name];
}

function jsonColumn(rowValue: unknown, name: string, context: string): unknown {
  const row = expectRecord(rowValue, context);
  return parseJson(expectString(rowField(row, name, context), `${context}.${name}`), `${context}.${name}`);
}

function accessGrantFromRow(rowValue: unknown): StoredAccessGrant {
  const context = "SQLite access-grant row";
  const row = expectRecord(rowValue, context);
  return decodeStoredAccessGrant({
    id: rowField(row, "id", context),
    routeId: rowField(row, "route_id", context),
    principalId: rowField(row, "principal_id", context),
    credentials: jsonColumn(row, "credentials_json", context),
    status: rowField(row, "status", context),
    terminateActive: expectNumber(rowField(row, "terminate_active", context), `${context}.terminate_active`) === 1,
    createdAt: rowField(row, "created_at", context),
    updatedAt: rowField(row, "updated_at", context),
  });
}

function routeFromRow(rowValue: unknown): StoredRoute {
  const context = "SQLite route row";
  const row = expectRecord(rowValue, context);
  const endpointId = nullableString(rowField(row, "endpoint_id", context), `${context}.endpoint_id`);
  const lastError = nullableString(rowField(row, "last_error", context), `${context}.last_error`);
  return decodeStoredRoute({
    ...expectRecord(jsonColumn(row, "policy_json", context), `${context}.policy_json`),
    id: rowField(row, "id", context),
    name: rowField(row, "name", context),
    targeting: jsonColumn(row, "targeting_json", context),
    rotation: jsonColumn(row, "rotation_json", context),
    provider: rowField(row, "provider", context),
    ...(endpointId === undefined ? {} : { endpointId }),
    status: rowField(row, "status", context),
    terminateActive: expectNumber(rowField(row, "terminate_active", context), `${context}.terminate_active`) === 1,
    ...(lastError === undefined ? {} : { lastError }),
    rotationEpoch: rowField(row, "rotation_epoch", context),
    lastRotationAt: rowField(row, "last_rotation_at", context),
    createdAt: rowField(row, "created_at", context),
    updatedAt: rowField(row, "updated_at", context),
  });
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
  close(): Promise<void>;
}

export class SqliteRouteStore implements RouteStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        targeting_json TEXT NOT NULL,
        rotation_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('bright_data', 'proxidize')),
        endpoint_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('ready', 'rotating', 'failed', 'revoked')),
        terminate_active INTEGER NOT NULL DEFAULT 0 CHECK(terminate_active IN (0, 1)),
        last_error TEXT,
        rotation_epoch INTEGER NOT NULL DEFAULT 0,
        last_rotation_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS routes_endpoint_id ON routes(endpoint_id) WHERE status != 'revoked';
      CREATE TABLE IF NOT EXISTS access_grants (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        credentials_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ready', 'revoked')),
        terminate_active INTEGER NOT NULL DEFAULT 0 CHECK(terminate_active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(route_id) REFERENCES routes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS access_grants_route_principal
        ON access_grants(route_id, principal_id, created_at);
      DROP INDEX IF EXISTS access_grants_endpoint;
      DROP TABLE IF EXISTS device_leases;
      CREATE TABLE IF NOT EXISTS provider_health (
        provider TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('healthy', 'degraded', 'unhealthy')),
        checked_at TEXT NOT NULL,
        message TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_inventory (
        provider TEXT PRIMARY KEY,
        captured_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capability_health_snapshots (
        id TEXT PRIMARY KEY,
        generated_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS capability_health_generated_at
        ON capability_health_snapshots(generated_at DESC);
      CREATE TABLE IF NOT EXISTS health_alert_states (
        capability TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS health_alert_events (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS health_alert_events_created_at
        ON health_alert_events(created_at DESC);
      CREATE TABLE IF NOT EXISTS health_alert_deliveries (
        alert_id TEXT NOT NULL,
        destination_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'failed')),
        next_attempt_at TEXT NOT NULL,
        delivery_json TEXT NOT NULL,
        PRIMARY KEY(alert_id, destination_id),
        FOREIGN KEY(alert_id) REFERENCES health_alert_events(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS health_alert_deliveries_pending
        ON health_alert_deliveries(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS active_tunnels (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        access_grant_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        tunnel_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS active_tunnels_deployment_expiry
        ON active_tunnels(deployment_id, expires_at);
      CREATE TABLE IF NOT EXISTS capacity_circuits (
        provider TEXT NOT NULL,
        candidate_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        circuit_json TEXT NOT NULL,
        PRIMARY KEY(provider, candidate_key)
      );
      CREATE INDEX IF NOT EXISTS capacity_circuits_expiry ON capacity_circuits(expires_at);
      CREATE TABLE IF NOT EXISTS deployment_drains (
        deployment_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_records_completed_at
        ON usage_records(completed_at);
      CREATE TABLE IF NOT EXISTS usage_rollups (
        id TEXT PRIMARY KEY,
        interval TEXT NOT NULL CHECK(interval IN ('hour', 'day', 'week', 'month')),
        period_started_at TEXT NOT NULL,
        rollup_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_rollups_period
        ON usage_rollups(interval, period_started_at);
      CREATE TABLE IF NOT EXISTS usage_reconciliations (
        id TEXT PRIMARY KEY,
        period_started_at TEXT NOT NULL,
        reconciliation_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_reconciliations_period
        ON usage_reconciliations(period_started_at);
      CREATE TABLE IF NOT EXISTS usage_alert_events (
        id TEXT PRIMARY KEY,
        period_started_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_alert_events_period
        ON usage_alert_events(period_started_at);
    `);
  }

  async create(id: string, profile: RouteProfile, provider: StoredRoute["provider"], endpointId?: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `
      INSERT INTO routes (
        id, name, targeting_json, rotation_json, policy_json,
        provider, endpoint_id, status, last_rotation_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
    `,
      )
      .run(
        id,
        profile.customerId,
        JSON.stringify(profile.targeting),
        JSON.stringify(profile.rotation),
        JSON.stringify({
          allowedProtocols: profile.allowedProtocols,
          session: profile.session,
          customerId: profile.customerId,
          ...(profile.geography === undefined ? {} : { geography: profile.geography }),
          ...(profile.carrier === undefined ? {} : { carrier: profile.carrier }),
          ...(profile.providerOverride === undefined ? {} : { providerOverride: profile.providerOverride }),
          isTargetAuthenticated: profile.isTargetAuthenticated,
          allowConnectionRetry: profile.allowConnectionRetry,
          userId: profile.userId,
          isAuthenticated: profile.isAuthenticated,
          shouldRetry: profile.shouldRetry,
          retryPolicy: profile.retryPolicy,
        }),
        provider,
        endpointId ?? null,
        now,
        now,
        now,
      );
    return this.get(id);
  }

  async update(id: string, profile: RouteProfile, provider: StoredRoute["provider"]): Promise<StoredRoute> {
    await this.get(id);
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `
      UPDATE routes
      SET name = ?, targeting_json = ?, rotation_json = ?, policy_json = ?, provider = ?,
          endpoint_id = NULL, status = 'ready', last_error = NULL, updated_at = ?
      WHERE id = ? AND status != 'revoked'
    `,
      )
      .run(
        profile.customerId,
        JSON.stringify(profile.targeting),
        JSON.stringify(profile.rotation),
        JSON.stringify({
          allowedProtocols: profile.allowedProtocols,
          session: profile.session,
          customerId: profile.customerId,
          ...(profile.geography === undefined ? {} : { geography: profile.geography }),
          ...(profile.carrier === undefined ? {} : { carrier: profile.carrier }),
          ...(profile.providerOverride === undefined ? {} : { providerOverride: profile.providerOverride }),
          isTargetAuthenticated: profile.isTargetAuthenticated,
          allowConnectionRetry: profile.allowConnectionRetry,
          userId: profile.userId,
          isAuthenticated: profile.isAuthenticated,
          shouldRetry: profile.shouldRetry,
          retryPolicy: profile.retryPolicy,
        }),
        provider,
        now,
        id,
      );
    return this.get(id);
  }

  async get(id: string, includeRevoked = false): Promise<StoredRoute> {
    const sql = includeRevoked ? "SELECT * FROM routes WHERE id = ?" : "SELECT * FROM routes WHERE id = ? AND status != 'revoked'";
    const row = this.#database.prepare(sql).get(id);
    if (row === undefined) throw new NotFoundError();
    return routeFromRow(row);
  }

  async list(): Promise<StoredRoute[]> {
    const rows = this.#database.prepare("SELECT * FROM routes WHERE status != 'revoked' ORDER BY created_at ASC").all();
    return rows.map(routeFromRow);
  }

  async createAccessGrant(
    id: string,
    routeId: string,
    principalId: string,
    credentialId: string,
    token: string,
  ): Promise<StoredAccessGrant> {
    await this.get(routeId);
    const now = new Date().toISOString();
    const credential = createStoredCredential(credentialId, token, now);
    this.#database
      .prepare(
        `
      INSERT INTO access_grants(
        id, route_id, principal_id, credentials_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'ready', ?, ?)
    `,
      )
      .run(id, routeId, principalId, JSON.stringify([credential]), now, now);
    return this.getAccessGrant(id);
  }

  async getAccessGrant(id: string, includeRevoked = false): Promise<StoredAccessGrant> {
    const sql = includeRevoked
      ? "SELECT * FROM access_grants WHERE id = ?"
      : "SELECT * FROM access_grants WHERE id = ? AND status != 'revoked'";
    const row = this.#database.prepare(sql).get(id);
    if (row === undefined) throw new NotFoundError();
    return accessGrantFromRow(row);
  }

  async listAccessGrants(routeId: string, principalId?: string): Promise<StoredAccessGrant[]> {
    await this.get(routeId);
    const rows =
      principalId === undefined
        ? this.#database.prepare("SELECT * FROM access_grants WHERE route_id = ? ORDER BY created_at").all(routeId)
        : this.#database
            .prepare("SELECT * FROM access_grants WHERE route_id = ? AND principal_id = ? ORDER BY created_at")
            .all(routeId, principalId);
    return rows.map(accessGrantFromRow);
  }

  async authenticateAccessGrant(username: string, token: string): Promise<StoredAccessGrant | undefined> {
    const rows = this.#database.prepare("SELECT * FROM access_grants WHERE status != 'revoked'").all();
    const grant = rows
      .map(accessGrantFromRow)
      .find((candidate) => candidate.credentials.some((credential) => credentialUsername(credential.id) === username));
    if (grant === undefined) return undefined;
    try {
      await this.get(grant.routeId);
    } catch {
      return undefined;
    }
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const credential = grant.credentials.find((candidateCredential) => {
      if (credentialUsername(candidateCredential.id) !== username) return false;
      if (!credentialUsable(candidateCredential, nowMs)) return false;
      const candidate = scryptSync(token, candidateCredential.tokenSalt, 32);
      const expected = Buffer.from(candidateCredential.tokenHash, "hex");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
    if (credential === undefined) return undefined;
    credential.lastUsedAt = now;
    this.#database
      .prepare(
        `
      UPDATE access_grants SET credentials_json = ?, updated_at = ? WHERE id = ? AND status != 'revoked'
    `,
      )
      .run(JSON.stringify(grant.credentials), now, grant.id);
    return { ...grant, credentials: grant.credentials, updatedAt: now };
  }

  async rotateAccessGrantCredential(
    id: string,
    credentialId: string,
    token: string,
    suspectedCompromise = false,
  ): Promise<StoredAccessGrant> {
    const grant = await this.getAccessGrant(id);
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const overlapLimit = nowMs + ACCESS_GRANT_CREDENTIAL_OVERLAP_MS;
    const credentials = grant.credentials.map((credential) => {
      if (!credentialUsable(credential, nowMs)) return credential;
      if (suspectedCompromise) return { ...credential, status: "revoked" as const, revokeAt: now };
      return {
        ...credential,
        status: "overlap" as const,
        revokeAt: new Date(Math.min(Date.parse(credential.expiresAt), overlapLimit)).toISOString(),
      };
    });
    credentials.push(createStoredCredential(credentialId, token, now));
    const result = this.#database
      .prepare(
        `
      UPDATE access_grants SET credentials_json = ?, updated_at = ?
      WHERE id = ? AND status != 'revoked'
    `,
      )
      .run(JSON.stringify(credentials), now, id);
    if (result.changes === 0) throw new NotFoundError();
    return this.getAccessGrant(id);
  }

  async revokeAccessGrantCredential(id: string, credentialId: string): Promise<void> {
    const grant = await this.getAccessGrant(id, true);
    const credential = grant.credentials.find((candidate) => candidate.id === credentialId);
    if (credential === undefined) throw new NotFoundError();
    if (credential.status === "revoked") return;
    const now = new Date().toISOString();
    credential.status = "revoked";
    credential.revokeAt = now;
    this.#database
      .prepare("UPDATE access_grants SET credentials_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(grant.credentials), now, id);
  }

  async revokeAccessGrant(id: string, terminateActive = false): Promise<void> {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        terminateActive
          ? "UPDATE access_grants SET status = 'revoked', terminate_active = 1, updated_at = ? WHERE id = ?"
          : "UPDATE access_grants SET status = 'revoked', updated_at = ? WHERE id = ?",
      )
      .run(now, id);
    if (result.changes === 0) throw new NotFoundError();
  }

  async revoke(id: string, terminateActive = false): Promise<void> {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        terminateActive
          ? "UPDATE routes SET status = 'revoked', terminate_active = 1, updated_at = ? WHERE id = ?"
          : "UPDATE routes SET status = 'revoked', terminate_active = 0, updated_at = ? WHERE id = ? AND status != 'revoked'",
      )
      .run(now, id);
    if (result.changes === 0) throw new NotFoundError();
  }

  async shouldTerminateActive(id: string, accessGrantId?: string): Promise<boolean> {
    const row = this.#database.prepare("SELECT terminate_active FROM routes WHERE id = ?").get(id) as
      { terminate_active: number } | undefined;
    if (row?.terminate_active === 1) return true;
    if (accessGrantId === undefined) return false;
    const grant = this.#database.prepare("SELECT terminate_active FROM access_grants WHERE id = ?").get(accessGrantId) as
      { terminate_active: number } | undefined;
    return grant?.terminate_active === 1;
  }

  async registerActiveTunnel(tunnel: ActiveTunnel): Promise<void> {
    this.#database
      .prepare(
        `
      INSERT INTO active_tunnels(id, deployment_id, route_id, access_grant_id, expires_at, tunnel_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(tunnel.id, tunnel.deploymentId, tunnel.routeId, tunnel.accessGrantId, tunnel.expiresAt, JSON.stringify(tunnel));
  }

  async claimActiveTunnelSlot(
    candidateEndpointIds: readonly string[],
    selectEndpoint: (loads: ReadonlyMap<string, number>) => string,
    createTunnel: (endpointId: string) => ActiveTunnel,
  ): Promise<{ tunnel: ActiveTunnel; activeConnections: number }> {
    if (candidateEndpointIds.length === 0) throw new Error("no_slot_candidates");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const candidates = new Set(candidateEndpointIds);
      const loads = new Map<string, number>();
      const rows = this.#database.prepare("SELECT tunnel_json FROM active_tunnels WHERE expires_at > ?").all(now);
      for (const row of rows) {
        const tunnel = decodeActiveTunnel(jsonColumn(row, "tunnel_json", "SQLite active-tunnel row"));
        if (tunnel.provider !== "proxidize" || tunnel.endpointId === undefined || !candidates.has(tunnel.endpointId)) continue;
        loads.set(tunnel.endpointId, (loads.get(tunnel.endpointId) ?? 0) + 1);
      }
      const endpointId = selectEndpoint(loads);
      if (!candidates.has(endpointId)) throw new Error("invalid_slot_selection");
      const tunnel = createTunnel(endpointId);
      this.#database
        .prepare(
          `INSERT INTO active_tunnels(id, deployment_id, route_id, access_grant_id, expires_at, tunnel_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(tunnel.id, tunnel.deploymentId, tunnel.routeId, tunnel.accessGrantId, tunnel.expiresAt, JSON.stringify(tunnel));
      this.#database.exec("COMMIT");
      return { tunnel, activeConnections: (loads.get(endpointId) ?? 0) + 1 };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async heartbeatActiveTunnel(id: string, lastHeartbeatAt: string, expiresAt: string): Promise<void> {
    const row = this.#database.prepare("SELECT tunnel_json FROM active_tunnels WHERE id = ?").get(id);
    if (row === undefined) return;
    const tunnel = {
      ...decodeActiveTunnel(jsonColumn(row, "tunnel_json", "SQLite active-tunnel row")),
      lastHeartbeatAt,
      expiresAt,
    };
    this.#database
      .prepare("UPDATE active_tunnels SET expires_at = ?, tunnel_json = ? WHERE id = ?")
      .run(expiresAt, JSON.stringify(tunnel), id);
  }

  async removeActiveTunnel(id: string): Promise<void> {
    this.#database.prepare("DELETE FROM active_tunnels WHERE id = ?").run(id);
  }

  async getCapacityCircuit(
    provider: StoredRoute["provider"],
    candidateKey: string,
    now = new Date().toISOString(),
  ): Promise<CapacityCircuitState | undefined> {
    this.#database.prepare("DELETE FROM capacity_circuits WHERE expires_at <= ?").run(now);
    const row = this.#database
      .prepare("SELECT circuit_json FROM capacity_circuits WHERE provider = ? AND candidate_key = ?")
      .get(provider, candidateKey);
    return row === undefined ? undefined : decodeCapacityCircuitState(jsonColumn(row, "circuit_json", "SQLite capacity-circuit row"));
  }

  async claimCapacityCircuit(
    provider: StoredRoute["provider"],
    candidateKey: string,
    now: string,
  ): Promise<{ allowed: boolean; state?: CapacityCircuitState }> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("DELETE FROM capacity_circuits WHERE expires_at <= ?").run(now);
      const row = this.#database
        .prepare("SELECT circuit_json FROM capacity_circuits WHERE provider = ? AND candidate_key = ?")
        .get(provider, candidateKey);
      const previous =
        row === undefined ? undefined : decodeCapacityCircuitState(jsonColumn(row, "circuit_json", "SQLite capacity-circuit row"));
      const claim = claimCapacityCircuitProbe(previous, Date.parse(now));
      if (claim.allowed && claim.state !== undefined && claim.state !== previous) {
        this.#database
          .prepare(
            `INSERT INTO capacity_circuits(provider, candidate_key, expires_at, circuit_json) VALUES (?, ?, ?, ?)
             ON CONFLICT(provider, candidate_key) DO UPDATE SET expires_at = excluded.expires_at, circuit_json = excluded.circuit_json`,
          )
          .run(provider, candidateKey, claim.state.expiresAt, JSON.stringify(claim.state));
      }
      this.#database.exec("COMMIT");
      return claim;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async recordCapacityCircuitFailure(
    provider: StoredRoute["provider"],
    candidateKey: string,
    reason: CapacityCircuitReason,
    now: string,
  ): Promise<CapacityCircuitState> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare("SELECT circuit_json FROM capacity_circuits WHERE provider = ? AND candidate_key = ?")
        .get(provider, candidateKey);
      const previous =
        row === undefined ? undefined : decodeCapacityCircuitState(jsonColumn(row, "circuit_json", "SQLite capacity-circuit row"));
      const state = recordCapacityCircuitFailure(previous, provider, candidateKey, reason, Date.parse(now));
      this.#database
        .prepare(
          `INSERT INTO capacity_circuits(provider, candidate_key, expires_at, circuit_json) VALUES (?, ?, ?, ?)
           ON CONFLICT(provider, candidate_key) DO UPDATE SET expires_at = excluded.expires_at, circuit_json = excluded.circuit_json`,
        )
        .run(provider, candidateKey, state.expiresAt, JSON.stringify(state));
      this.#database.exec("COMMIT");
      return state;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async resetCapacityCircuit(provider: StoredRoute["provider"], candidateKey: string): Promise<void> {
    this.#database.prepare("DELETE FROM capacity_circuits WHERE provider = ? AND candidate_key = ?").run(provider, candidateKey);
  }

  async listCapacityCircuits(now = new Date().toISOString()): Promise<CapacityCircuitState[]> {
    this.#database.prepare("DELETE FROM capacity_circuits WHERE expires_at <= ?").run(now);
    const rows = this.#database.prepare("SELECT circuit_json FROM capacity_circuits ORDER BY provider, candidate_key").all();
    return rows.map((row) => decodeCapacityCircuitState(jsonColumn(row, "circuit_json", "SQLite capacity-circuit row")));
  }

  async listActiveTunnels(deploymentId: string, now = new Date().toISOString()): Promise<ActiveTunnel[]> {
    const rows = this.#database
      .prepare(
        `
      SELECT tunnel_json FROM active_tunnels WHERE deployment_id = ? AND expires_at > ? ORDER BY id
    `,
      )
      .all(deploymentId, now);
    return rows.map((row) => decodeActiveTunnel(jsonColumn(row, "tunnel_json", "SQLite active-tunnel row")));
  }

  async listAllActiveTunnels(now = new Date().toISOString()): Promise<ActiveTunnel[]> {
    const rows = this.#database
      .prepare(
        `
      SELECT tunnel_json FROM active_tunnels WHERE expires_at > ? ORDER BY id
    `,
      )
      .all(now);
    return rows.map((row) => decodeActiveTunnel(jsonColumn(row, "tunnel_json", "SQLite active-tunnel row")));
  }

  async getDeploymentDrain(deploymentId: string): Promise<DeploymentDrainState | undefined> {
    const row = this.#database.prepare("SELECT state_json FROM deployment_drains WHERE deployment_id = ?").get(deploymentId);
    return row === undefined ? undefined : decodeDeploymentDrainState(jsonColumn(row, "state_json", "SQLite deployment-drain row"));
  }

  async saveDeploymentDrain(state: DeploymentDrainState): Promise<void> {
    this.#database
      .prepare(
        `
      INSERT INTO deployment_drains(deployment_id, state_json) VALUES (?, ?)
      ON CONFLICT(deployment_id) DO UPDATE SET state_json = excluded.state_json
    `,
      )
      .run(state.deploymentId, JSON.stringify(state));
  }

  async shouldTerminateDeployment(deploymentId: string): Promise<boolean> {
    return (await this.getDeploymentDrain(deploymentId))?.terminateRemaining === true;
  }

  async setEndpoint(id: string, endpointId?: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `
      UPDATE routes SET endpoint_id = ?, updated_at = ? WHERE id = ? AND status != 'revoked'
    `,
      )
      .run(endpointId ?? null, now, id);
    if (result.changes === 0) throw new NotFoundError();
    return this.get(id);
  }

  async setStatus(id: string, status: RouteStatus, lastError?: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare("UPDATE routes SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND status != 'revoked'")
      .run(status, lastError ?? null, now, id);
    if (result.changes === 0) throw new NotFoundError();
    return this.get(id);
  }

  async claimScheduledRotation(id: string, dueBefore: string): Promise<StoredRoute | undefined> {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `
      UPDATE routes
      SET status = 'rotating', last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'ready' AND last_rotation_at <= ?
    `,
      )
      .run(now, id, dueBefore);
    return result.changes === 0 ? undefined : this.get(id);
  }

  async completeRotation(id: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `
      UPDATE routes
      SET status = 'ready', last_error = NULL, last_rotation_at = ?, updated_at = ?
      WHERE id = ? AND status = 'rotating'
    `,
      )
      .run(now, now, id);
    if (result.changes === 0) throw new NotFoundError();
    return this.get(id);
  }

  async incrementRotationEpoch(id: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `
        UPDATE routes
        SET rotation_epoch = rotation_epoch + 1, updated_at = ?
        WHERE id = ? AND status != 'revoked'
      `,
      )
      .run(now, id);
    if (result.changes === 0) throw new NotFoundError();
    return this.get(id);
  }

  async saveHealth(health: ProviderHealth): Promise<void> {
    this.#database
      .prepare(
        `
      INSERT INTO provider_health(provider, state, checked_at, message)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        state = excluded.state,
        checked_at = excluded.checked_at,
        message = excluded.message
    `,
      )
      .run(health.provider, health.state, health.checkedAt, health.message ?? null);
  }

  async listHealth(): Promise<ProviderHealth[]> {
    const rows = this.#database.prepare("SELECT * FROM provider_health ORDER BY provider").all();
    return rows.map((rowValue) => {
      const context = "SQLite provider-health row";
      const row = expectRecord(rowValue, context);
      const message = nullableString(rowField(row, "message", context), `${context}.message`);
      return decodeProviderHealth({
        provider: rowField(row, "provider", context),
        state: rowField(row, "state", context),
        checkedAt: rowField(row, "checked_at", context),
        ...(message === undefined ? {} : { message }),
      });
    });
  }

  async saveProviderInventory(snapshot: ProviderInventorySnapshot): Promise<void> {
    this.#database
      .prepare(
        `
      INSERT INTO provider_inventory(provider, captured_at, snapshot_json)
      VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        captured_at = excluded.captured_at,
        snapshot_json = excluded.snapshot_json
    `,
      )
      .run(snapshot.provider, snapshot.capturedAt, JSON.stringify(snapshot));
  }

  async latestProviderInventory(provider: ProviderInventorySnapshot["provider"]): Promise<ProviderInventorySnapshot | undefined> {
    const row = this.#database.prepare("SELECT snapshot_json FROM provider_inventory WHERE provider = ?").get(provider);
    return row === undefined
      ? undefined
      : decodeProviderInventorySnapshot(jsonColumn(row, "snapshot_json", "SQLite provider-inventory row"));
  }

  async saveCapabilityHealth(snapshot: CapabilityHealthSnapshot): Promise<void> {
    this.#database
      .prepare(
        `
      INSERT INTO capability_health_snapshots(id, generated_at, snapshot_json)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        generated_at = excluded.generated_at,
        snapshot_json = excluded.snapshot_json
    `,
      )
      .run(snapshot.id, snapshot.generatedAt, JSON.stringify(snapshot));
  }

  async latestCapabilityHealth(): Promise<CapabilityHealthSnapshot | undefined> {
    const row = this.#database.prepare("SELECT snapshot_json FROM capability_health_snapshots ORDER BY generated_at DESC LIMIT 1").get();
    return row === undefined ? undefined : decodeCapabilityHealthSnapshot(jsonColumn(row, "snapshot_json", "SQLite capability-health row"));
  }

  async capabilityHealthHistory(limit: number): Promise<CapabilityHealthSnapshot[]> {
    const rows = this.#database
      .prepare("SELECT snapshot_json FROM capability_health_snapshots ORDER BY generated_at DESC LIMIT ?")
      .all(limit);
    return rows.map((row) => decodeCapabilityHealthSnapshot(jsonColumn(row, "snapshot_json", "SQLite capability-health row")));
  }

  async getHealthAlertState(capability: CapabilityName): Promise<HealthAlertState | undefined> {
    const row = this.#database.prepare("SELECT state_json FROM health_alert_states WHERE capability = ?").get(capability);
    return row === undefined ? undefined : decodeHealthAlertState(jsonColumn(row, "state_json", "SQLite health-alert state row"));
  }

  async saveHealthAlertState(state: HealthAlertState): Promise<void> {
    this.#database
      .prepare(
        `
      INSERT INTO health_alert_states(capability, state_json) VALUES (?, ?)
      ON CONFLICT(capability) DO UPDATE SET state_json = excluded.state_json
    `,
      )
      .run(state.capability, JSON.stringify(state));
  }

  async createHealthAlertEvent(event: HealthAlertEvent, destinationIds: readonly string[]): Promise<boolean> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.#database
        .prepare(
          `
        INSERT OR IGNORE INTO health_alert_events(id, dedupe_key, created_at, event_json)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(event.id, event.dedupeKey, event.createdAt, JSON.stringify(event));
      const existingEvent =
        inserted.changes > 0
          ? undefined
          : this.#database
              .prepare(
                `
            SELECT event_json FROM health_alert_events WHERE dedupe_key = ?
          `,
              )
              .get(event.dedupeKey);
      if (inserted.changes === 0 && existingEvent === undefined) throw new Error("Persisted SQLite health-alert event is missing");
      const persistedEvent =
        existingEvent === undefined
          ? event
          : decodeHealthAlertEvent(jsonColumn(existingEvent, "event_json", "SQLite health-alert event row"));
      const delivery = this.#database.prepare(`
        INSERT OR IGNORE INTO health_alert_deliveries(
          alert_id, destination_id, status, next_attempt_at, delivery_json
        ) VALUES (?, ?, 'pending', ?, ?)
      `);
      for (const destinationId of destinationIds) {
        const value: HealthAlertDelivery = {
          alertId: persistedEvent.id,
          destinationId,
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: persistedEvent.createdAt,
          event: persistedEvent,
        };
        delivery.run(persistedEvent.id, destinationId, persistedEvent.createdAt, JSON.stringify(value));
      }
      this.#database.exec("COMMIT");
      return inserted.changes > 0;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async pendingHealthAlertDeliveries(dueBefore: string, limit: number): Promise<HealthAlertDelivery[]> {
    const rows = this.#database
      .prepare(
        `
      SELECT delivery_json FROM health_alert_deliveries
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC LIMIT ?
    `,
      )
      .all(dueBefore, limit);
    return rows.map((row) => decodeHealthAlertDelivery(jsonColumn(row, "delivery_json", "SQLite health-alert delivery row")));
  }

  async saveHealthAlertDelivery(delivery: HealthAlertDelivery): Promise<void> {
    this.#database
      .prepare(
        `
      UPDATE health_alert_deliveries
      SET status = ?, next_attempt_at = ?, delivery_json = ?
      WHERE alert_id = ? AND destination_id = ?
    `,
      )
      .run(delivery.status, delivery.nextAttemptAt, JSON.stringify(delivery), delivery.alertId, delivery.destinationId);
  }

  async healthAlertHistory(limit: number): Promise<HealthAlertEvent[]> {
    const rows = this.#database
      .prepare(
        `
      SELECT event_json FROM health_alert_events ORDER BY created_at DESC LIMIT ?
    `,
      )
      .all(limit);
    return rows.map((row) => decodeHealthAlertEvent(jsonColumn(row, "event_json", "SQLite health-alert event row")));
  }

  async recordUsage(record: UsageRecord): Promise<boolean> {
    const result = this.#database
      .prepare("INSERT OR IGNORE INTO usage_records(id, completed_at, record_json) VALUES (?, ?, ?)")
      .run(record.id, record.completedAt, JSON.stringify(record));
    return result.changes > 0;
  }

  async listUsageRecords(from: string, to: string): Promise<UsageRecord[]> {
    const rows = this.#database
      .prepare("SELECT record_json FROM usage_records WHERE completed_at >= ? AND completed_at < ? ORDER BY completed_at")
      .all(from, to);
    return rows.map((row) => decodeUsageRecord(jsonColumn(row, "record_json", "SQLite usage-record row")));
  }

  async saveUsageRollup(rollup: UsageRollup): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO usage_rollups(id, interval, period_started_at, rollup_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET rollup_json = excluded.rollup_json`,
      )
      .run(rollup.id, rollup.interval, rollup.periodStartedAt, JSON.stringify(rollup));
  }

  async listUsageRollups(from: string, to: string, interval: UsageRollup["interval"]): Promise<UsageRollup[]> {
    const rows = this.#database
      .prepare(
        "SELECT rollup_json FROM usage_rollups WHERE interval = ? AND period_started_at >= ? AND period_started_at < ? ORDER BY period_started_at",
      )
      .all(interval, from, to);
    return rows.map((row) => decodeUsageRollup(jsonColumn(row, "rollup_json", "SQLite usage-rollup row")));
  }

  async saveUsageReconciliation(reconciliation: UsageReconciliation): Promise<boolean> {
    const result = this.#database
      .prepare("INSERT OR IGNORE INTO usage_reconciliations(id, period_started_at, reconciliation_json) VALUES (?, ?, ?)")
      .run(reconciliation.id, reconciliation.periodStartedAt, JSON.stringify(reconciliation));
    return result.changes > 0;
  }

  async listUsageReconciliations(from: string, to: string): Promise<UsageReconciliation[]> {
    const rows = this.#database
      .prepare(
        "SELECT reconciliation_json FROM usage_reconciliations WHERE period_started_at >= ? AND period_started_at < ? ORDER BY period_started_at",
      )
      .all(from, to);
    return rows.map((row) => decodeUsageReconciliation(jsonColumn(row, "reconciliation_json", "SQLite usage-reconciliation row")));
  }

  async saveUsageAlertEvent(event: UsageAlertEvent): Promise<boolean> {
    const result = this.#database
      .prepare("INSERT OR IGNORE INTO usage_alert_events(id, period_started_at, event_json) VALUES (?, ?, ?)")
      .run(event.id, event.periodStartedAt, JSON.stringify(event));
    return result.changes > 0;
  }

  async listUsageAlertEvents(from: string, to: string): Promise<UsageAlertEvent[]> {
    const rows = this.#database
      .prepare(
        "SELECT event_json FROM usage_alert_events WHERE period_started_at >= ? AND period_started_at < ? ORDER BY period_started_at",
      )
      .all(from, to);
    return rows.map((row) => decodeUsageAlertEvent(jsonColumn(row, "event_json", "SQLite usage-alert event row")));
  }

  async close(): Promise<void> {
    this.#database.close();
  }
}
