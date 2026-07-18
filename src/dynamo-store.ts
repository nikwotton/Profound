import { scryptSync, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { NotFoundError } from "./errors.js";
import { claimCapacityCircuitProbe, recordCapacityCircuitFailure } from "./capacity-circuit.js";
import { expectRecord } from "./decoding.js";
import {
  decodeActiveTunnel,
  decodeCapacityPressureEvidence,
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
import { ACCESS_GRANT_CREDENTIAL_OVERLAP_MS, createStoredCredential, credentialUsername, type RouteStore } from "./store.js";
import type {
  CapabilityHealthSnapshot,
  CapabilityName,
  CapacityPressureEvidence,
  CapacityCircuitReason,
  CapacityCircuitState,
  ActiveTunnel,
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
  StoredRoute,
  UsageRecord,
  UsageAlertEvent,
  UsageReconciliation,
  UsageRollup,
} from "./types.js";

const ENTITY_INDEX = "EntityCreatedAt";
const ASSIGNMENT_INDEX = "EndpointAssignments";

function itemField(item: unknown, field: string, context: string): unknown {
  return expectRecord(item, context)[field];
}

interface RouteItem {
  pk: string;
  sk: string;
  entity: "route";
  createdAt: string;
  status: RouteStatus;
  route: StoredRoute;
  gsi1pk?: string;
  gsi1sk?: string;
}

interface AccessGrantItem {
  pk: string;
  sk: "STATE";
  entity: "access_grant";
  createdAt: string;
  status: StoredAccessGrant["status"];
  routeId: string;
  principalId: string;
  grant: StoredAccessGrant;
  gsi1pk?: string;
  gsi1sk?: string;
}

interface HealthItem {
  pk: string;
  sk: string;
  entity: "health";
  createdAt: string;
  health: ProviderHealth;
}

interface ProviderInventoryItem {
  pk: string;
  sk: "LATEST";
  entity: "provider_inventory";
  createdAt: string;
  snapshot: ProviderInventorySnapshot;
}

interface CapabilityHealthItem {
  pk: "CAPABILITY_HEALTH#GLOBAL";
  sk: string;
  entity: "capability_health";
  createdAt: string;
  snapshot: CapabilityHealthSnapshot;
}

interface HealthAlertStateItem {
  pk: "HEALTH_ALERT_STATE#GLOBAL";
  sk: CapabilityName;
  entity: "health_alert_state";
  createdAt: string;
  state: HealthAlertState;
}

interface HealthAlertEventItem {
  pk: string;
  sk: "EVENT";
  entity: "health_alert_event";
  createdAt: string;
  event: HealthAlertEvent;
}

interface HealthAlertDeliveryItem {
  pk: string;
  sk: string;
  entity: "health_alert_delivery_pending" | "health_alert_delivery_delivered" | "health_alert_delivery_failed";
  createdAt: string;
  delivery: HealthAlertDelivery;
}

interface ActiveTunnelItem {
  pk: string;
  sk: "STATE";
  entity: "active_tunnel";
  createdAt: string;
  gsi1pk: string;
  gsi1sk: string;
  expiresAtSeconds: number;
  tunnel: ActiveTunnel;
}

interface CapacityCircuitItem {
  pk: string;
  sk: "STATE";
  entity: "capacity_circuit";
  createdAt: string;
  expiresAtSeconds: number;
  state: CapacityCircuitState;
}

interface DeploymentDrainItem {
  pk: string;
  sk: "DRAIN";
  entity: "deployment_drain";
  createdAt: string;
  state: DeploymentDrainState;
}

interface UsageRecordItem {
  pk: string;
  sk: "RECORD";
  entity: "usage_record";
  createdAt: string;
  record: UsageRecord;
}

interface UsageRollupItem {
  pk: string;
  sk: string;
  entity: "usage_rollup";
  createdAt: string;
  rollup: UsageRollup;
}

interface UsageReconciliationItem {
  pk: string;
  sk: "RECORD";
  entity: "usage_reconciliation";
  createdAt: string;
  reconciliation: UsageReconciliation;
}

interface UsageAlertEventItem {
  pk: string;
  sk: "EVENT";
  entity: "usage_alert_event";
  createdAt: string;
  event: UsageAlertEvent;
}

interface CapacityPressureEvidenceItem {
  pk: string;
  sk: "EVIDENCE";
  entity: "capacity_pressure_evidence";
  createdAt: string;
  evidence: CapacityPressureEvidence;
}

function routeKey(id: string): { pk: string; sk: string } {
  return { pk: `ROUTE#${id}`, sk: "STATE" };
}

function accessGrantKey(id: string): { pk: string; sk: "STATE" } {
  return { pk: `ACCESS_GRANT#${id}`, sk: "STATE" };
}

function capacityCircuitKey(provider: StoredRoute["provider"], candidateKey: string): { pk: string; sk: "STATE" } {
  return { pk: `CAPACITY_CIRCUIT#${provider}#${candidateKey}`, sk: "STATE" };
}

function conditionalNotFound(error: unknown): never {
  if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw new NotFoundError();
  throw error;
}

function credentialUsable(credential: StoredAccessGrantCredential, nowMs: number): boolean {
  return (
    credential.status !== "revoked" &&
    Date.parse(credential.expiresAt) > nowMs &&
    (credential.revokeAt === undefined || Date.parse(credential.revokeAt) > nowMs)
  );
}

function grantItem(grant: StoredAccessGrant): AccessGrantItem {
  return {
    ...accessGrantKey(grant.id),
    entity: "access_grant",
    createdAt: grant.createdAt,
    status: grant.status,
    routeId: grant.routeId,
    principalId: grant.principalId,
    grant,
  };
}

export class DynamoRouteStore implements RouteStore {
  readonly #client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
  ) {
    this.#client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  async #withCapacityCircuitLock<T>(provider: StoredRoute["provider"], candidateKey: string, action: () => Promise<T>): Promise<T> {
    const key = capacityCircuitKey(provider, candidateKey);
    const lockKey = { pk: key.pk, sk: "LOCK" };
    const owner = `${Date.now()}-${Math.random()}`;
    const deadline = Date.now() + 5_000;
    for (;;) {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      try {
        await this.#client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: { ...lockKey, owner, expiresAtSeconds: nowSeconds + 10 },
            ConditionExpression: "attribute_not_exists(pk) OR expiresAtSeconds < :now",
            ExpressionAttributeValues: { ":now": nowSeconds },
          }),
        );
        break;
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException") || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await action();
    } finally {
      await this.#client
        .send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: lockKey,
            ConditionExpression: "#owner = :owner",
            ExpressionAttributeNames: { "#owner": "owner" },
            ExpressionAttributeValues: { ":owner": owner },
          }),
        )
        .catch(() => undefined);
    }
  }

  async create(id: string, profile: RouteProfile, provider: StoredRoute["provider"], endpointId?: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const route: StoredRoute = {
      id,
      name: profile.name,
      targeting: profile.targeting,
      rotation: profile.rotation,
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
      provider,
      ...(endpointId === undefined ? {} : { endpointId }),
      status: "ready",
      terminateActive: false,
      rotationEpoch: 0,
      lastRotationAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const item: RouteItem = {
      ...routeKey(id),
      entity: "route",
      createdAt: now,
      status: route.status,
      route,
      ...(endpointId === undefined ? {} : { gsi1pk: `ENDPOINT#${endpointId}`, gsi1sk: `${now}#${id}` }),
    };
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return route;
  }

  async update(id: string, profile: RouteProfile, provider: StoredRoute["provider"]): Promise<StoredRoute> {
    const previous = await this.get(id);
    const now = new Date().toISOString();
    const {
      endpointId: _endpointId,
      lastError: _lastError,
      geography: _geography,
      carrier: _carrier,
      providerOverride: _providerOverride,
      ...retained
    } = previous;
    void _endpointId;
    void _lastError;
    void _geography;
    void _carrier;
    void _providerOverride;
    const route: StoredRoute = {
      ...retained,
      ...profile,
      provider,
      status: "ready",
      updatedAt: now,
    };
    const item: RouteItem = {
      ...routeKey(id),
      entity: "route",
      createdAt: route.createdAt,
      status: route.status,
      route,
    };
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
    return route;
  }

  async get(id: string, includeRevoked = false): Promise<StoredRoute> {
    const result = await this.#client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: routeKey(id),
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) throw new NotFoundError();
    const route = decodeStoredRoute(itemField(result.Item, "route", "DynamoDB route item"));
    if (!includeRevoked && route.status === "revoked") throw new NotFoundError();
    return route;
  }

  async #queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(
        new QueryCommand({
          ...input,
          ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  async list(): Promise<StoredRoute[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity",
      FilterExpression: "#status <> :revoked",
      ExpressionAttributeNames: { "#entity": "entity", "#status": "status" },
      ExpressionAttributeValues: { ":entity": "route", ":revoked": "revoked" },
    });
    return items.map((item) => decodeStoredRoute(itemField(item, "route", "DynamoDB route item")));
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
    const grant: StoredAccessGrant = {
      id,
      routeId,
      principalId,
      credentials: [createStoredCredential(credentialId, token, now)],
      status: "ready",
      terminateActive: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: grantItem(grant),
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return grant;
  }

  async getAccessGrant(id: string, includeRevoked = false): Promise<StoredAccessGrant> {
    const result = await this.#client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: accessGrantKey(id),
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) throw new NotFoundError();
    const grant = decodeStoredAccessGrant(itemField(result.Item, "grant", "DynamoDB access-grant item"));
    if (!includeRevoked && grant.status === "revoked") throw new NotFoundError();
    return grant;
  }

  async listAccessGrants(routeId: string, principalId?: string): Promise<StoredAccessGrant[]> {
    await this.get(routeId);
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity",
      FilterExpression: "routeId = :routeId" + (principalId === undefined ? "" : " AND principalId = :principalId"),
      ExpressionAttributeNames: { "#entity": "entity" },
      ExpressionAttributeValues: {
        ":entity": "access_grant",
        ":routeId": routeId,
        ...(principalId === undefined ? {} : { ":principalId": principalId }),
      },
    });
    return items.map((item) => decodeStoredAccessGrant(itemField(item, "grant", "DynamoDB access-grant item")));
  }

  async authenticateAccessGrant(username: string, token: string): Promise<StoredAccessGrant | undefined> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity",
      ExpressionAttributeNames: { "#entity": "entity" },
      ExpressionAttributeValues: { ":entity": "access_grant" },
    });
    const grant = items
      .map((item) => decodeStoredAccessGrant(itemField(item, "grant", "DynamoDB access-grant item")))
      .find(
        (candidate) =>
          candidate.status !== "revoked" && candidate.credentials.some((credential) => credentialUsername(credential.id) === username),
      );
    if (grant === undefined) return undefined;
    try {
      await this.get(grant.routeId);
    } catch {
      return undefined;
    }
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const credentialIndex = grant.credentials.findIndex((candidateCredential) => {
      if (credentialUsername(candidateCredential.id) !== username) return false;
      if (!credentialUsable(candidateCredential, nowMs)) return false;
      const candidate = scryptSync(token, candidateCredential.tokenSalt, 32);
      const expected = Buffer.from(candidateCredential.tokenHash, "hex");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
    if (credentialIndex < 0) return undefined;
    const credential = grant.credentials[credentialIndex];
    if (credential === undefined) throw new Error("Matched access-grant credential disappeared");
    credential.lastUsedAt = now;
    grant.updatedAt = now;
    await this.#client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: accessGrantKey(grant.id),
        UpdateExpression: `SET #grant.#credentials[${credentialIndex}].#lastUsedAt = :now, #grant.updatedAt = :now`,
        ConditionExpression: `attribute_exists(pk) AND #status <> :revoked AND #grant.#credentials[${credentialIndex}].#tokenHash = :tokenHash`,
        ExpressionAttributeNames: {
          "#grant": "grant",
          "#credentials": "credentials",
          "#lastUsedAt": "lastUsedAt",
          "#tokenHash": "tokenHash",
          "#status": "status",
        },
        ExpressionAttributeValues: { ":now": now, ":revoked": "revoked", ":tokenHash": credential.tokenHash },
      }),
    );
    return grant;
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
    grant.credentials = grant.credentials.map((credential) => {
      if (!credentialUsable(credential, nowMs)) return credential;
      if (suspectedCompromise) return { ...credential, status: "revoked" as const, revokeAt: now };
      return {
        ...credential,
        status: "overlap" as const,
        revokeAt: new Date(Math.min(Date.parse(credential.expiresAt), overlapLimit)).toISOString(),
      };
    });
    grant.credentials.push(createStoredCredential(credentialId, token, now));
    grant.updatedAt = now;
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: grantItem(grant),
          ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":revoked": "revoked" },
        }),
      );
      return grant;
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async revokeAccessGrantCredential(id: string, credentialId: string): Promise<void> {
    const grant = await this.getAccessGrant(id, true);
    const credential = grant.credentials.find((candidate) => candidate.id === credentialId);
    if (credential === undefined) throw new NotFoundError();
    if (credential.status === "revoked") return;
    const now = new Date().toISOString();
    credential.status = "revoked";
    credential.revokeAt = now;
    grant.updatedAt = now;
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: grantItem(grant),
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
  }

  async revokeAccessGrant(id: string, terminateActive = false): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.#client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: accessGrantKey(id),
          UpdateExpression:
            "SET #status = :revoked, #grant.#status = :revoked, #grant.terminateActive = :terminate, #grant.updatedAt = :now REMOVE gsi1pk, gsi1sk",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#status": "status", "#grant": "grant" },
          ExpressionAttributeValues: { ":revoked": "revoked", ":terminate": terminateActive, ":now": now },
        }),
      );
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async revoke(id: string, terminateActive = false): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.#client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: routeKey(id),
          UpdateExpression:
            "SET #status = :status, #route.#status = :status, #route.terminateActive = :terminate, #route.updatedAt = :now REMOVE gsi1pk, gsi1sk",
          ConditionExpression: terminateActive ? "attribute_exists(pk)" : "attribute_exists(pk) AND #status <> :status",
          ExpressionAttributeNames: { "#status": "status", "#route": "route" },
          ExpressionAttributeValues: { ":status": "revoked", ":terminate": terminateActive, ":now": now },
        }),
      );
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async shouldTerminateActive(id: string, accessGrantId?: string): Promise<boolean> {
    try {
      if ((await this.get(id, true)).terminateActive) return true;
      return accessGrantId === undefined ? false : (await this.getAccessGrant(accessGrantId, true)).terminateActive;
    } catch {
      return false;
    }
  }

  async registerActiveTunnel(tunnel: ActiveTunnel): Promise<void> {
    const item: ActiveTunnelItem = {
      pk: `ACTIVE_TUNNEL#${tunnel.id}`,
      sk: "STATE",
      entity: "active_tunnel",
      createdAt: tunnel.startedAt,
      gsi1pk: `DEPLOYMENT#${tunnel.deploymentId}`,
      gsi1sk: `${tunnel.startedAt}#${tunnel.id}`,
      expiresAtSeconds: Math.ceil(Date.parse(tunnel.expiresAt) / 1_000),
      tunnel,
    };
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  async claimActiveTunnelSlot(
    candidateEndpointIds: readonly string[],
    selectEndpoint: (loads: ReadonlyMap<string, number>) => string,
    createTunnel: (endpointId: string) => ActiveTunnel,
  ): Promise<{ tunnel: ActiveTunnel; activeConnections: number }> {
    if (candidateEndpointIds.length === 0) throw new Error("no_slot_candidates");
    const owner = `${Date.now()}-${Math.random()}`;
    const lockKey = { pk: "PROXY_SLOT_SELECTION#GLOBAL", sk: "LOCK" };
    const deadline = Date.now() + 5_000;
    for (;;) {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      try {
        await this.#client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: { ...lockKey, owner, expiresAtSeconds: nowSeconds + 10 },
            ConditionExpression: "attribute_not_exists(pk) OR expiresAtSeconds < :now",
            ExpressionAttributeValues: { ":now": nowSeconds },
          }),
        );
        break;
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException") || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      const candidates = new Set(candidateEndpointIds);
      const loads = new Map<string, number>();
      for (const tunnel of await this.listAllActiveTunnels()) {
        if (tunnel.provider !== "proxidize" || tunnel.endpointId === undefined || !candidates.has(tunnel.endpointId)) continue;
        loads.set(tunnel.endpointId, (loads.get(tunnel.endpointId) ?? 0) + 1);
      }
      const endpointId = selectEndpoint(loads);
      if (!candidates.has(endpointId)) throw new Error("invalid_slot_selection");
      const tunnel = createTunnel(endpointId);
      await this.registerActiveTunnel(tunnel);
      return { tunnel, activeConnections: (loads.get(endpointId) ?? 0) + 1 };
    } finally {
      await this.#client
        .send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: lockKey,
            ConditionExpression: "#owner = :owner",
            ExpressionAttributeNames: { "#owner": "owner" },
            ExpressionAttributeValues: { ":owner": owner },
          }),
        )
        .catch(() => undefined);
    }
  }

  async heartbeatActiveTunnel(id: string, lastHeartbeatAt: string, expiresAt: string): Promise<void> {
    try {
      await this.#client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `ACTIVE_TUNNEL#${id}`, sk: "STATE" },
          UpdateExpression: "SET #tunnel.lastHeartbeatAt = :heartbeat, #tunnel.expiresAt = :expiresAt, expiresAtSeconds = :ttl",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#tunnel": "tunnel" },
          ExpressionAttributeValues: {
            ":heartbeat": lastHeartbeatAt,
            ":expiresAt": expiresAt,
            ":ttl": Math.ceil(Date.parse(expiresAt) / 1_000),
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
    }
  }

  async removeActiveTunnel(id: string): Promise<void> {
    await this.#client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: `ACTIVE_TUNNEL#${id}`, sk: "STATE" },
        UpdateExpression: "REMOVE gsi1pk, gsi1sk SET expiresAtSeconds = :expired",
        ExpressionAttributeValues: { ":expired": Math.floor(Date.now() / 1_000) - 1 },
      }),
    );
  }

  async getCapacityCircuit(
    provider: StoredRoute["provider"],
    candidateKey: string,
    now = new Date().toISOString(),
  ): Promise<CapacityCircuitState | undefined> {
    const key = capacityCircuitKey(provider, candidateKey);
    const result = await this.#client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }));
    if (result.Item === undefined) return undefined;
    const state = decodeCapacityCircuitState(itemField(result.Item, "state", "DynamoDB capacity-circuit item"));
    if (state.expiresAt > now) return state;
    await this.#client.send(new DeleteCommand({ TableName: this.tableName, Key: key })).catch(() => undefined);
    return undefined;
  }

  async claimCapacityCircuit(
    provider: StoredRoute["provider"],
    candidateKey: string,
    now: string,
  ): Promise<{ allowed: boolean; state?: CapacityCircuitState }> {
    return this.#withCapacityCircuitLock(provider, candidateKey, async () => {
      const previous = await this.getCapacityCircuit(provider, candidateKey, now);
      const claim = claimCapacityCircuitProbe(previous, Date.parse(now));
      if (claim.allowed && claim.state !== undefined && claim.state !== previous) {
        await this.#saveCapacityCircuit(claim.state);
      }
      return claim;
    });
  }

  async recordCapacityCircuitFailure(
    provider: StoredRoute["provider"],
    candidateKey: string,
    reason: CapacityCircuitReason,
    now: string,
  ): Promise<CapacityCircuitState> {
    return this.#withCapacityCircuitLock(provider, candidateKey, async () => {
      const previous = await this.getCapacityCircuit(provider, candidateKey, now);
      const state = recordCapacityCircuitFailure(previous, provider, candidateKey, reason, Date.parse(now));
      await this.#saveCapacityCircuit(state);
      return state;
    });
  }

  async #saveCapacityCircuit(state: CapacityCircuitState): Promise<void> {
    const item: CapacityCircuitItem = {
      ...capacityCircuitKey(state.provider, state.candidateKey),
      entity: "capacity_circuit",
      createdAt: state.updatedAt,
      expiresAtSeconds: Math.ceil(Date.parse(state.expiresAt) / 1_000),
      state,
    };
    await this.#client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async resetCapacityCircuit(provider: StoredRoute["provider"], candidateKey: string): Promise<void> {
    await this.#client.send(new DeleteCommand({ TableName: this.tableName, Key: capacityCircuitKey(provider, candidateKey) }));
  }

  async listCapacityCircuits(now = new Date().toISOString()): Promise<CapacityCircuitState[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity",
      ExpressionAttributeNames: { "#entity": "entity" },
      ExpressionAttributeValues: { ":entity": "capacity_circuit" },
    });
    return items
      .map((item) => decodeCapacityCircuitState(itemField(item, "state", "DynamoDB capacity-circuit item")))
      .filter((state) => state.expiresAt > now);
  }

  async listActiveTunnels(deploymentId: string, now = new Date().toISOString()): Promise<ActiveTunnel[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ASSIGNMENT_INDEX,
      KeyConditionExpression: "gsi1pk = :deployment",
      ExpressionAttributeValues: { ":deployment": `DEPLOYMENT#${deploymentId}` },
    });
    return items
      .map((item) => decodeActiveTunnel(itemField(item, "tunnel", "DynamoDB active-tunnel item")))
      .filter((tunnel) => tunnel.expiresAt > now);
  }

  async listAllActiveTunnels(now = new Date().toISOString()): Promise<ActiveTunnel[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity",
      ExpressionAttributeNames: { "#entity": "entity" },
      ExpressionAttributeValues: { ":entity": "active_tunnel" },
    });
    return items
      .map((item) => decodeActiveTunnel(itemField(item, "tunnel", "DynamoDB active-tunnel item")))
      .filter((tunnel) => tunnel.expiresAt > now);
  }

  async getDeploymentDrain(deploymentId: string): Promise<DeploymentDrainState | undefined> {
    const result = await this.#client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `DEPLOYMENT#${deploymentId}`, sk: "DRAIN" },
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined
      ? undefined
      : decodeDeploymentDrainState(itemField(result.Item, "state", "DynamoDB deployment-drain item"));
  }

  async saveDeploymentDrain(state: DeploymentDrainState): Promise<void> {
    const item: DeploymentDrainItem = {
      pk: `DEPLOYMENT#${state.deploymentId}`,
      sk: "DRAIN",
      entity: "deployment_drain",
      createdAt: state.startedAt,
      state,
    };
    await this.#client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async shouldTerminateDeployment(deploymentId: string): Promise<boolean> {
    return (await this.getDeploymentDrain(deploymentId))?.terminateRemaining === true;
  }

  async setEndpoint(id: string, endpointId?: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const update =
      endpointId === undefined
        ? "SET #route.updatedAt = :now REMOVE #route.endpointId, gsi1pk, gsi1sk"
        : "SET #route.endpointId = :endpointId, #route.updatedAt = :now, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk";
    try {
      const result = await this.#client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: routeKey(id),
          UpdateExpression: update,
          ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
          ExpressionAttributeNames: { "#status": "status", "#route": "route" },
          ExpressionAttributeValues: {
            ":now": now,
            ":revoked": "revoked",
            ...(endpointId === undefined
              ? {}
              : {
                  ":endpointId": endpointId,
                  ":gsi1pk": `ENDPOINT#${endpointId}`,
                  ":gsi1sk": `${now}#${id}`,
                }),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return decodeStoredRoute(itemField(result.Attributes, "route", "DynamoDB updated route item"));
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async setStatus(id: string, status: RouteStatus, lastError?: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const update =
      lastError === undefined
        ? "SET #status = :status, #route.#status = :status, #route.updatedAt = :now REMOVE #route.lastError"
        : "SET #status = :status, #route.#status = :status, #route.updatedAt = :now, #route.lastError = :lastError";
    try {
      const result = await this.#client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: routeKey(id),
          UpdateExpression: update,
          ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
          ExpressionAttributeNames: { "#status": "status", "#route": "route" },
          ExpressionAttributeValues: {
            ":status": status,
            ":now": now,
            ":revoked": "revoked",
            ...(lastError === undefined ? {} : { ":lastError": lastError }),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return decodeStoredRoute(itemField(result.Attributes, "route", "DynamoDB updated route item"));
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async claimScheduledRotation(id: string, dueBefore: string): Promise<StoredRoute | undefined> {
    const now = new Date().toISOString();
    try {
      const result = await this.#client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: routeKey(id),
          UpdateExpression: "SET #status = :rotating, #route.#status = :rotating, #route.updatedAt = :now REMOVE #route.lastError",
          ConditionExpression:
            "attribute_exists(pk) AND #status = :ready AND (attribute_not_exists(#route.lastRotationAt) OR #route.lastRotationAt <= :dueBefore)",
          ExpressionAttributeNames: { "#status": "status", "#route": "route" },
          ExpressionAttributeValues: {
            ":rotating": "rotating",
            ":ready": "ready",
            ":now": now,
            ":dueBefore": dueBefore,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return decodeStoredRoute(itemField(result.Attributes, "route", "DynamoDB updated route item"));
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return undefined;
      throw error;
    }
  }

  async completeRotation(id: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    try {
      const result = await this.#client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: routeKey(id),
          UpdateExpression:
            "SET #status = :ready, #route.#status = :ready, #route.lastRotationAt = :now, #route.updatedAt = :now REMOVE #route.lastError",
          ConditionExpression: "attribute_exists(pk) AND #status = :rotating",
          ExpressionAttributeNames: { "#status": "status", "#route": "route" },
          ExpressionAttributeValues: { ":ready": "ready", ":rotating": "rotating", ":now": now },
          ReturnValues: "ALL_NEW",
        }),
      );
      return decodeStoredRoute(itemField(result.Attributes, "route", "DynamoDB updated route item"));
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async incrementRotationEpoch(id: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    try {
      const result = await this.#client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: routeKey(id),
          UpdateExpression: "SET #route.rotationEpoch = #route.rotationEpoch + :one, #route.updatedAt = :now",
          ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
          ExpressionAttributeNames: { "#status": "status", "#route": "route" },
          ExpressionAttributeValues: { ":one": 1, ":now": now, ":revoked": "revoked" },
          ReturnValues: "ALL_NEW",
        }),
      );
      return decodeStoredRoute(itemField(result.Attributes, "route", "DynamoDB updated route item"));
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async saveHealth(health: ProviderHealth): Promise<void> {
    const item: HealthItem = {
      pk: `HEALTH#${health.provider}`,
      sk: "STATE",
      entity: "health",
      createdAt: health.provider,
      health,
    };
    await this.#client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async listHealth(): Promise<ProviderHealth[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity",
      ExpressionAttributeNames: { "#entity": "entity" },
      ExpressionAttributeValues: { ":entity": "health" },
    });
    return items.map((item) => decodeProviderHealth(itemField(item, "health", "DynamoDB provider-health item")));
  }

  async saveProviderInventory(snapshot: ProviderInventorySnapshot): Promise<void> {
    const item: ProviderInventoryItem = {
      pk: `PROVIDER_INVENTORY#${snapshot.provider}`,
      sk: "LATEST",
      entity: "provider_inventory",
      createdAt: snapshot.capturedAt,
      snapshot,
    };
    await this.#client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async latestProviderInventory(provider: ProviderInventorySnapshot["provider"]): Promise<ProviderInventorySnapshot | undefined> {
    const result = await this.#client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `PROVIDER_INVENTORY#${provider}`, sk: "LATEST" },
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined
      ? undefined
      : decodeProviderInventorySnapshot(itemField(result.Item, "snapshot", "DynamoDB provider-inventory item"));
  }

  async saveCapabilityHealth(snapshot: CapabilityHealthSnapshot): Promise<void> {
    const item: CapabilityHealthItem = {
      pk: "CAPABILITY_HEALTH#GLOBAL",
      sk: snapshot.generatedAt,
      entity: "capability_health",
      createdAt: snapshot.generatedAt,
      snapshot,
    };
    await this.#client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async latestCapabilityHealth(): Promise<CapabilityHealthSnapshot | undefined> {
    const result = await this.#client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "CAPABILITY_HEALTH#GLOBAL" },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    const item = result.Items?.[0];
    return item === undefined ? undefined : decodeCapabilityHealthSnapshot(itemField(item, "snapshot", "DynamoDB capability-health item"));
  }

  async capabilityHealthHistory(limit: number): Promise<CapabilityHealthSnapshot[]> {
    const result = await this.#client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "CAPABILITY_HEALTH#GLOBAL" },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((item) =>
      decodeCapabilityHealthSnapshot(itemField(item, "snapshot", "DynamoDB capability-health item")),
    );
  }

  async getHealthAlertState(capability: CapabilityName): Promise<HealthAlertState | undefined> {
    const result = await this.#client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: "HEALTH_ALERT_STATE#GLOBAL", sk: capability },
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined
      ? undefined
      : decodeHealthAlertState(itemField(result.Item, "state", "DynamoDB health-alert state item"));
  }

  async saveHealthAlertState(state: HealthAlertState): Promise<void> {
    const item: HealthAlertStateItem = {
      pk: "HEALTH_ALERT_STATE#GLOBAL",
      sk: state.capability,
      entity: "health_alert_state",
      createdAt: state.updatedAt,
      state,
    };
    await this.#client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async createHealthAlertEvent(event: HealthAlertEvent, destinationIds: readonly string[]): Promise<boolean> {
    const item: HealthAlertEventItem = {
      pk: `HEALTH_ALERT_EVENT#${event.dedupeKey}`,
      sk: "EVENT",
      entity: "health_alert_event",
      createdAt: event.createdAt,
      event,
    };
    let created = true;
    let persistedEvent = event;
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
        created = false;
        const existing = await this.#client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk: item.pk, sk: item.sk },
            ConsistentRead: true,
          }),
        );
        if (existing.Item === undefined) throw new Error("Health alert deduplication state is missing");
        persistedEvent = decodeHealthAlertEvent(itemField(existing.Item, "event", "DynamoDB health-alert event item"));
      } else throw error;
    }
    for (const destinationId of destinationIds) {
      const delivery: HealthAlertDelivery = {
        alertId: persistedEvent.id,
        destinationId,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: persistedEvent.createdAt,
        event: persistedEvent,
      };
      try {
        await this.#client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: {
              pk: `HEALTH_ALERT_DELIVERY#${delivery.alertId}`,
              sk: delivery.destinationId,
              entity: "health_alert_delivery_pending",
              createdAt: delivery.nextAttemptAt,
              delivery,
            } satisfies HealthAlertDeliveryItem,
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
    }
    return created;
  }

  async pendingHealthAlertDeliveries(dueBefore: string, limit: number): Promise<HealthAlertDelivery[]> {
    const result = await this.#client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: ENTITY_INDEX,
        KeyConditionExpression: "#entity = :entity AND #createdAt <= :dueBefore",
        ExpressionAttributeNames: { "#entity": "entity", "#createdAt": "createdAt" },
        ExpressionAttributeValues: {
          ":entity": "health_alert_delivery_pending",
          ":dueBefore": dueBefore,
        },
        ScanIndexForward: true,
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((entry) =>
      decodeHealthAlertDelivery(itemField(entry, "delivery", "DynamoDB health-alert delivery item")),
    );
  }

  async saveHealthAlertDelivery(delivery: HealthAlertDelivery): Promise<void> {
    const item: HealthAlertDeliveryItem = {
      pk: `HEALTH_ALERT_DELIVERY#${delivery.alertId}`,
      sk: delivery.destinationId,
      entity: `health_alert_delivery_${delivery.status}`,
      createdAt: delivery.nextAttemptAt,
      delivery,
    };
    await this.#client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async healthAlertHistory(limit: number): Promise<HealthAlertEvent[]> {
    const result = await this.#client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: ENTITY_INDEX,
        KeyConditionExpression: "#entity = :entity",
        ExpressionAttributeNames: { "#entity": "entity" },
        ExpressionAttributeValues: { ":entity": "health_alert_event" },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((entry) => decodeHealthAlertEvent(itemField(entry, "event", "DynamoDB health-alert event item")));
  }

  async recordUsage(record: UsageRecord): Promise<boolean> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `USAGE#${record.id}`,
            sk: "RECORD",
            entity: "usage_record",
            createdAt: record.completedAt,
            record,
          } satisfies UsageRecordItem,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async listUsageRecords(from: string, to: string): Promise<UsageRecord[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity AND #createdAt BETWEEN :from AND :to",
      ExpressionAttributeNames: { "#entity": "entity", "#createdAt": "createdAt" },
      ExpressionAttributeValues: { ":entity": "usage_record", ":from": from, ":to": to },
      ScanIndexForward: true,
    });
    return items
      .map((item) => decodeUsageRecord(itemField(item, "record", "DynamoDB usage-record item")))
      .filter((record) => record.completedAt >= from && record.completedAt < to);
  }

  async saveUsageRollup(rollup: UsageRollup): Promise<void> {
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `USAGE_ROLLUP#${rollup.interval}`,
          sk: rollup.id,
          entity: "usage_rollup",
          createdAt: rollup.periodStartedAt,
          rollup,
        } satisfies UsageRollupItem,
      }),
    );
  }

  async listUsageRollups(from: string, to: string, interval: UsageRollup["interval"]): Promise<UsageRollup[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": `USAGE_ROLLUP#${interval}`, ":from": from, ":to": `${to}~` },
      ScanIndexForward: true,
    });
    return items.map((item) => decodeUsageRollup(itemField(item, "rollup", "DynamoDB usage-rollup item")));
  }

  async saveUsageReconciliation(reconciliation: UsageReconciliation): Promise<boolean> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `USAGE_RECONCILIATION#${reconciliation.id}`,
            sk: "RECORD",
            entity: "usage_reconciliation",
            createdAt: reconciliation.periodStartedAt,
            reconciliation,
          } satisfies UsageReconciliationItem,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async listUsageReconciliations(from: string, to: string): Promise<UsageReconciliation[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity AND #createdAt BETWEEN :from AND :to",
      ExpressionAttributeNames: { "#entity": "entity", "#createdAt": "createdAt" },
      ExpressionAttributeValues: { ":entity": "usage_reconciliation", ":from": from, ":to": to },
      ScanIndexForward: true,
    });
    return items
      .map((item) => decodeUsageReconciliation(itemField(item, "reconciliation", "DynamoDB usage-reconciliation item")))
      .filter((record) => record.periodStartedAt >= from && record.periodStartedAt < to);
  }

  async saveUsageAlertEvent(event: UsageAlertEvent): Promise<boolean> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `USAGE_ALERT#${event.id}`,
            sk: "EVENT",
            entity: "usage_alert_event",
            createdAt: event.periodStartedAt,
            event,
          } satisfies UsageAlertEventItem,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async listUsageAlertEvents(from: string, to: string): Promise<UsageAlertEvent[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity AND #createdAt BETWEEN :from AND :to",
      ExpressionAttributeNames: { "#entity": "entity", "#createdAt": "createdAt" },
      ExpressionAttributeValues: { ":entity": "usage_alert_event", ":from": from, ":to": to },
      ScanIndexForward: true,
    });
    return items
      .map((item) => decodeUsageAlertEvent(itemField(item, "event", "DynamoDB usage-alert event item")))
      .filter((event) => event.periodStartedAt >= from && event.periodStartedAt < to);
  }

  async saveCapacityPressureEvidence(evidence: CapacityPressureEvidence): Promise<void> {
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `CAPACITY_PRESSURE#${evidence.id}`,
          sk: "EVIDENCE",
          entity: "capacity_pressure_evidence",
          createdAt: evidence.observedAt,
          evidence,
        } satisfies CapacityPressureEvidenceItem,
      }),
    );
  }

  async listCapacityPressureEvidence(observedAfter: string): Promise<CapacityPressureEvidence[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity AND #createdAt >= :observedAfter",
      ExpressionAttributeNames: { "#entity": "entity", "#createdAt": "createdAt" },
      ExpressionAttributeValues: { ":entity": "capacity_pressure_evidence", ":observedAfter": observedAfter },
      ScanIndexForward: true,
    });
    return items.map((item) => decodeCapacityPressureEvidence(itemField(item, "evidence", "DynamoDB capacity-pressure evidence item")));
  }

  async close(): Promise<void> {
    this.#client.destroy();
  }
}
