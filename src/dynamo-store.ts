import { timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { DynamoHealthRepository } from "./dynamo-health-repository.js";
import { DynamoRuntimeStateRepository } from "./dynamo-runtime-state-repository.js";
import { DynamoUsageRepository } from "./dynamo-usage-repository.js";
import {
  ACCESS_GRANT_LAST_USED_WRITE_INTERVAL_MS,
  ASSIGNMENT_INDEX,
  ENTITY_INDEX,
  accessGrantKey,
  conditionalNotFound,
  credentialLookupItem,
  credentialLookupKey,
  credentialUsable,
  decodeCredentialLookup,
  grantItem,
  itemField,
  logicalSessionItem,
  logicalSessionKey,
  routeKey,
  type RouteItem,
} from "./dynamo-records.js";
import { NotFoundError } from "./errors.js";
import { decodeStoredAccessGrant, decodeStoredLogicalSession, decodeStoredRoute } from "./storage-decoding.js";
import {
  ACCESS_GRANT_CREDENTIAL_OVERLAP_MS,
  createStoredCredential,
  credentialUsername,
  hashAccessGrantToken,
  type RouteStore,
} from "./store.js";
import type {
  CapabilityHealthSnapshot,
  CapabilityName,
  HealthAlertDelivery,
  HealthAlertEvent,
  HealthAlertState,
  ProviderHealth,
} from "./domain/health.js";
import type { CapacityPressureEvidence, UsageRecord, UsageAlertEvent, UsageReconciliation, UsageRollup } from "./domain/usage.js";
import type {
  CapacityCircuitReason,
  CapacityCircuitState,
  ActiveTunnel,
  AuthenticatedAccessGrant,
  DeploymentDrainState,
  ProviderId,
  ProviderInventorySnapshot,
  RouteProfile,
  StoredAccessGrant,
  StoredAccessGrantCredential,
  StoredLogicalSession,
  StoredRoute,
} from "./domain/routing.js";

export class DynamoRouteStore implements RouteStore {
  readonly #client: DynamoDBDocumentClient;
  readonly #health: DynamoHealthRepository;
  readonly #runtimeState: DynamoRuntimeStateRepository;
  readonly #usage: DynamoUsageRepository;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
  ) {
    this.#client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
    this.#health = new DynamoHealthRepository(this.tableName, this.#client);
    this.#runtimeState = new DynamoRuntimeStateRepository(this.tableName, this.#client);
    this.#usage = new DynamoUsageRepository(this.tableName, this.#client);
  }

  async getAuthorizationEpoch(): Promise<number> {
    const result = await this.#client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: "AUTHORIZATION#GLOBAL", sk: "EPOCH" }, ConsistentRead: true }),
    );
    const version = result.Item === undefined ? undefined : itemField(result.Item, "version", "authorization epoch");
    return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : 0;
  }

  async #bumpAuthorizationEpoch(): Promise<void> {
    await this.#client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: "AUTHORIZATION#GLOBAL", sk: "EPOCH" },
        UpdateExpression: "ADD #version :one",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":one": 1 },
      }),
    );
  }

  async create(id: string, profile: RouteProfile): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const route: StoredRoute = {
      id,
      name: profile.name,
      targeting: profile.targeting,
      rotation: profile.rotation,
      allowedProtocols: profile.allowedProtocols,
      customerId: profile.customerId,
      ...(profile.geography === undefined ? {} : { geography: profile.geography }),
      ...(profile.carrier === undefined ? {} : { carrier: profile.carrier }),
      ...(profile.providerOverride === undefined ? {} : { providerOverride: profile.providerOverride }),
      allowConnectionRetry: profile.allowConnectionRetry,
      userId: profile.userId,
      shouldRetry: profile.shouldRetry,
      retryPolicy: profile.retryPolicy,
      status: "ready",
      terminateActive: false,
      createdAt: now,
      updatedAt: now,
    };
    const item: RouteItem = {
      ...routeKey(id),
      entity: "route",
      createdAt: now,
      status: route.status,
      route,
      gsi1pk: `USER#${route.userId}`,
      gsi1sk: `${route.createdAt}#${route.id}`,
    };
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    await this.#bumpAuthorizationEpoch();
    return route;
  }

  async update(id: string, profile: RouteProfile): Promise<StoredRoute> {
    const previous = await this.get(id);
    const now = new Date().toISOString();
    const { geography: _geography, carrier: _carrier, providerOverride: _providerOverride, ...retained } = previous;
    void _geography;
    void _carrier;
    void _providerOverride;
    const route: StoredRoute = {
      ...retained,
      ...profile,
      status: "ready",
      updatedAt: now,
    };
    const item: RouteItem = {
      ...routeKey(id),
      entity: "route",
      createdAt: route.createdAt,
      status: route.status,
      route,
      gsi1pk: `USER#${route.userId}`,
      gsi1sk: `${route.createdAt}#${route.id}`,
    };
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
    await this.#bumpAuthorizationEpoch();
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

  async list(userId?: string): Promise<StoredRoute[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: userId === undefined ? ENTITY_INDEX : ASSIGNMENT_INDEX,
      KeyConditionExpression: userId === undefined ? "#entity = :entity" : "gsi1pk = :user",
      FilterExpression: "#status <> :revoked",
      ExpressionAttributeNames: { ...(userId === undefined ? { "#entity": "entity" } : {}), "#status": "status" },
      ExpressionAttributeValues: {
        ...(userId === undefined ? { ":entity": "route" } : { ":user": `USER#${userId}` }),
        ":revoked": "revoked",
      },
    });
    return items.map((item) => decodeStoredRoute(itemField(item, "route", "DynamoDB route item")));
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
    const now = new Date().toISOString();
    const credential = createStoredCredential(credentialId, token, sessionMode, now, sessionId);
    const grant: StoredAccessGrant = {
      id,
      routeId,
      principalId,
      ...(jobId === undefined ? {} : { jobId }),
      credentials: [credential],
      status: "ready",
      terminateActive: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.#client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: grantItem(grant),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: credentialLookupItem(grant.id, credential),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
    return grant;
  }

  async addAccessGrantCredential(
    id: string,
    credentialId: string,
    token: string,
    sessionMode: StoredAccessGrantCredential["sessionMode"],
    sessionId?: string,
  ): Promise<StoredAccessGrant> {
    const grant = await this.getAccessGrant(id);
    const now = new Date().toISOString();
    const credential = createStoredCredential(credentialId, token, sessionMode, now, sessionId);
    grant.credentials.push(credential);
    grant.updatedAt = now;
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: grantItem(grant),
                ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":revoked": "revoked" },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: credentialLookupItem(grant.id, credential),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
      await this.#bumpAuthorizationEpoch();
      return grant;
    } catch (error) {
      conditionalNotFound(error);
    }
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
      IndexName: ASSIGNMENT_INDEX,
      KeyConditionExpression: "gsi1pk = :route",
      FilterExpression: principalId === undefined ? undefined : "principalId = :principalId",
      ExpressionAttributeValues: {
        ":route": `ROUTE#${routeId}`,
        ...(principalId === undefined ? {} : { ":principalId": principalId }),
      },
    });
    return items.map((item) => decodeStoredAccessGrant(itemField(item, "grant", "DynamoDB access-grant item")));
  }

  async authenticateAccessGrant(username: string, token: string): Promise<AuthenticatedAccessGrant | undefined> {
    const lookupResult = await this.#client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: credentialLookupKey(username),
        ConsistentRead: true,
      }),
    );
    if (lookupResult.Item === undefined) return undefined;
    const lookup = decodeCredentialLookup(lookupResult.Item);
    let grant: StoredAccessGrant;
    let route: StoredRoute;
    try {
      grant = await this.getAccessGrant(lookup.grantId);
      route = await this.get(grant.routeId);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const credentialIndex = grant.credentials.findIndex((candidateCredential) => {
      if (candidateCredential.id !== lookup.credentialId || credentialUsername(candidateCredential.id) !== username) return false;
      if (!credentialUsable(candidateCredential, nowMs)) return false;
      const candidate = hashAccessGrantToken(token, candidateCredential.tokenSalt);
      const expected = Buffer.from(candidateCredential.tokenHash, "hex");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
    if (credentialIndex < 0) return undefined;
    const credential = grant.credentials[credentialIndex];
    if (credential === undefined) throw new Error("Matched access-grant credential disappeared");
    const lastUsedAtMs = credential.lastUsedAt === undefined ? undefined : Date.parse(credential.lastUsedAt);
    if (lastUsedAtMs !== undefined && nowMs - lastUsedAtMs < ACCESS_GRANT_LAST_USED_WRITE_INTERVAL_MS) {
      return { grant, credential, route };
    }
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
    return { grant, credential, route };
  }

  async rotateAccessGrantCredential(
    id: string,
    previousCredentialId: string,
    credentialId: string,
    token: string,
    suspectedCompromise = false,
  ): Promise<StoredAccessGrant> {
    const grant = await this.getAccessGrant(id);
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const overlapLimit = nowMs + ACCESS_GRANT_CREDENTIAL_OVERLAP_MS;
    const previous = grant.credentials.find((credential) => credential.id === previousCredentialId);
    if (previous === undefined) throw new NotFoundError();
    grant.credentials = grant.credentials.map((credential) => {
      if (credential.id !== previousCredentialId) return credential;
      if (!credentialUsable(credential, nowMs)) return credential;
      if (suspectedCompromise) return { ...credential, status: "revoked" as const, revokeAt: now };
      return {
        ...credential,
        status: "overlap" as const,
        revokeAt: new Date(Math.min(Date.parse(credential.expiresAt), overlapLimit)).toISOString(),
      };
    });
    const newCredential = createStoredCredential(credentialId, token, previous.sessionMode, now, previous.sessionId);
    grant.credentials.push(newCredential);
    grant.updatedAt = now;
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: grantItem(grant),
                ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":revoked": "revoked" },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: credentialLookupItem(grant.id, newCredential),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
      await this.#bumpAuthorizationEpoch();
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
    await this.#bumpAuthorizationEpoch();
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
    await this.closeLogicalSessions(id, terminateActive);
    await this.#bumpAuthorizationEpoch();
  }

  async createLogicalSession(session: StoredLogicalSession): Promise<void> {
    await this.#client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: logicalSessionItem(session),
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  async getLogicalSession(id: string, includeClosed = false): Promise<StoredLogicalSession> {
    const result = await this.#client.send(new GetCommand({ TableName: this.tableName, Key: logicalSessionKey(id), ConsistentRead: true }));
    if (result.Item === undefined) throw new NotFoundError();
    const session = decodeStoredLogicalSession(itemField(result.Item, "session", "DynamoDB logical-session item"));
    if (!includeClosed && session.status === "closed") throw new NotFoundError();
    return session;
  }

  async listLogicalSessions(grantId: string): Promise<StoredLogicalSession[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ASSIGNMENT_INDEX,
      KeyConditionExpression: "gsi1pk = :grant",
      ExpressionAttributeValues: { ":grant": `GRANT#${grantId}` },
    });
    return items.map((item) => decodeStoredLogicalSession(itemField(item, "session", "DynamoDB logical-session item")));
  }

  async saveLogicalSession(session: StoredLogicalSession, expectedBindingVersion: number): Promise<boolean> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: logicalSessionItem(session),
          ConditionExpression: "attribute_exists(pk) AND #status = :open AND #session.bindingVersion = :expected",
          ExpressionAttributeNames: { "#status": "status", "#session": "session" },
          ExpressionAttributeValues: { ":open": "open", ":expected": expectedBindingVersion },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async closeLogicalSession(id: string, terminateActive = false): Promise<void> {
    const session = await this.getLogicalSession(id, true);
    if (session.status === "closed" && (!terminateActive || session.terminateActive)) return;
    const now = new Date().toISOString();
    const closed: StoredLogicalSession = {
      ...session,
      status: "closed",
      terminateActive: session.terminateActive || terminateActive,
      closedAt: session.closedAt ?? now,
      updatedAt: now,
    };
    await this.#client.send(
      new PutCommand({ TableName: this.tableName, Item: logicalSessionItem(closed), ConditionExpression: "attribute_exists(pk)" }),
    );
    await this.#bumpAuthorizationEpoch();
  }

  async closeLogicalSessions(grantId: string, terminateActive = false): Promise<void> {
    for (const session of await this.listLogicalSessions(grantId)) await this.closeLogicalSession(session.id, terminateActive);
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
    await this.#bumpAuthorizationEpoch();
  }

  async shouldTerminateActive(id: string, accessGrantId?: string, sessionId?: string): Promise<boolean> {
    try {
      if ((await this.get(id, true)).terminateActive) return true;
      if (accessGrantId !== undefined && (await this.getAccessGrant(accessGrantId, true)).terminateActive) return true;
      return sessionId === undefined ? false : (await this.getLogicalSession(sessionId, true)).terminateActive;
    } catch {
      return false;
    }
  }

  registerActiveTunnel(tunnel: ActiveTunnel): Promise<void> {
    return this.#runtimeState.registerActiveTunnel(tunnel);
  }

  claimActiveTunnelSlot(
    candidateEndpointIds: readonly string[],
    selectEndpoint: (loads: ReadonlyMap<string, number>) => string,
    createTunnel: (endpointId: string) => ActiveTunnel,
  ): Promise<{ tunnel: ActiveTunnel; activeConnections: number }> {
    return this.#runtimeState.claimActiveTunnelSlot(candidateEndpointIds, selectEndpoint, createTunnel);
  }

  heartbeatActiveTunnel(id: string, lastHeartbeatAt: string, expiresAt: string): Promise<void> {
    return this.#runtimeState.heartbeatActiveTunnel(id, lastHeartbeatAt, expiresAt);
  }

  removeActiveTunnel(id: string): Promise<void> {
    return this.#runtimeState.removeActiveTunnel(id);
  }

  getActiveConnectionCounts(
    providers: readonly ProviderId[],
    endpointIds: readonly string[],
    sessionIds: readonly string[],
    now?: string,
  ): Promise<{
    providers: ReadonlyMap<ProviderId, number>;
    endpoints: ReadonlyMap<string, number>;
    sessions: ReadonlyMap<string, number>;
  }> {
    return this.#runtimeState.getActiveConnectionCounts(providers, endpointIds, sessionIds, now);
  }

  getCapacityCircuit(provider: ProviderId, candidateKey: string, now?: string): Promise<CapacityCircuitState | undefined> {
    return this.#runtimeState.getCapacityCircuit(provider, candidateKey, now);
  }

  claimCapacityCircuit(
    provider: ProviderId,
    candidateKey: string,
    now: string,
  ): Promise<{ allowed: boolean; state?: CapacityCircuitState }> {
    return this.#runtimeState.claimCapacityCircuit(provider, candidateKey, now);
  }

  recordCapacityCircuitFailure(
    provider: ProviderId,
    candidateKey: string,
    reason: CapacityCircuitReason,
    now: string,
  ): Promise<CapacityCircuitState> {
    return this.#runtimeState.recordCapacityCircuitFailure(provider, candidateKey, reason, now);
  }

  resetCapacityCircuit(provider: ProviderId, candidateKey: string): Promise<void> {
    return this.#runtimeState.resetCapacityCircuit(provider, candidateKey);
  }

  listCapacityCircuits(now?: string): Promise<CapacityCircuitState[]> {
    return this.#runtimeState.listCapacityCircuits(now);
  }

  listActiveTunnels(deploymentId: string, now?: string): Promise<ActiveTunnel[]> {
    return this.#runtimeState.listActiveTunnels(deploymentId, now);
  }

  listAllActiveTunnels(now?: string): Promise<ActiveTunnel[]> {
    return this.#runtimeState.listAllActiveTunnels(now);
  }

  getDeploymentDrain(deploymentId: string): Promise<DeploymentDrainState | undefined> {
    return this.#runtimeState.getDeploymentDrain(deploymentId);
  }

  saveDeploymentDrain(state: DeploymentDrainState): Promise<void> {
    return this.#runtimeState.saveDeploymentDrain(state);
  }

  shouldTerminateDeployment(deploymentId: string): Promise<boolean> {
    return this.#runtimeState.shouldTerminateDeployment(deploymentId);
  }

  saveHealth(health: ProviderHealth): Promise<void> {
    return this.#health.saveHealth(health);
  }
  listHealth(): Promise<ProviderHealth[]> {
    return this.#health.listHealth();
  }
  saveProviderInventory(snapshot: ProviderInventorySnapshot): Promise<void> {
    return this.#health.saveProviderInventory(snapshot);
  }
  latestProviderInventory(provider: ProviderInventorySnapshot["provider"]): Promise<ProviderInventorySnapshot | undefined> {
    return this.#health.latestProviderInventory(provider);
  }
  saveCapabilityHealth(snapshot: CapabilityHealthSnapshot): Promise<void> {
    return this.#health.saveCapabilityHealth(snapshot);
  }
  latestCapabilityHealth(): Promise<CapabilityHealthSnapshot | undefined> {
    return this.#health.latestCapabilityHealth();
  }
  capabilityHealthHistory(limit: number): Promise<CapabilityHealthSnapshot[]> {
    return this.#health.capabilityHealthHistory(limit);
  }
  getHealthAlertState(capability: CapabilityName): Promise<HealthAlertState | undefined> {
    return this.#health.getHealthAlertState(capability);
  }
  saveHealthAlertState(state: HealthAlertState): Promise<void> {
    return this.#health.saveHealthAlertState(state);
  }
  createHealthAlertEvent(event: HealthAlertEvent, destinationIds: readonly string[]): Promise<boolean> {
    return this.#health.createHealthAlertEvent(event, destinationIds);
  }
  pendingHealthAlertDeliveries(dueBefore: string, limit: number): Promise<HealthAlertDelivery[]> {
    return this.#health.pendingHealthAlertDeliveries(dueBefore, limit);
  }
  saveHealthAlertDelivery(delivery: HealthAlertDelivery): Promise<void> {
    return this.#health.saveHealthAlertDelivery(delivery);
  }
  healthAlertHistory(limit: number): Promise<HealthAlertEvent[]> {
    return this.#health.healthAlertHistory(limit);
  }

  recordUsage(record: UsageRecord): Promise<boolean> {
    return this.#usage.recordUsage(record);
  }

  listUsageRecords(from: string, to: string, options?: { limit?: number; newestFirst?: boolean }): Promise<UsageRecord[]> {
    return this.#usage.listUsageRecords(from, to, options);
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
    this.#client.destroy();
  }
}
