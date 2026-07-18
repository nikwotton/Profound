import { timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { claimCapacityCircuitProbe, recordCapacityCircuitFailure } from "./capacity-circuit.js";
import { DynamoUsageRepository } from "./dynamo-usage-repository.js";
import {
  ACCESS_GRANT_LAST_USED_WRITE_INTERVAL_MS,
  ASSIGNMENT_INDEX,
  ENTITY_INDEX,
  accessGrantKey,
  capacityCircuitKey,
  conditionalNotFound,
  credentialLookupItem,
  credentialLookupKey,
  credentialUsable,
  decodeCredentialLookup,
  entityShards,
  grantItem,
  itemField,
  logicalSessionItem,
  logicalSessionKey,
  routeKey,
  shardedEntity,
  type ActiveTunnelItem,
  type CapabilityHealthItem,
  type CapacityCircuitItem,
  type DeploymentDrainItem,
  type HealthAlertDeliveryItem,
  type HealthAlertEventItem,
  type HealthAlertStateItem,
  type HealthItem,
  type ProviderInventoryItem,
  type RouteItem,
} from "./dynamo-records.js";
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
  decodeStoredLogicalSession,
  decodeStoredRoute,
} from "./storage-decoding.js";
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
  CapacityPressureEvidence,
  CapacityCircuitReason,
  CapacityCircuitState,
  ActiveTunnel,
  AuthenticatedAccessGrant,
  DeploymentDrainState,
  HealthAlertDelivery,
  HealthAlertEvent,
  HealthAlertState,
  ProviderHealth,
  ProviderId,
  ProviderInventorySnapshot,
  RouteProfile,
  StoredAccessGrant,
  StoredAccessGrantCredential,
  StoredLogicalSession,
  StoredRoute,
  UsageRecord,
  UsageAlertEvent,
  UsageReconciliation,
  UsageRollup,
} from "./types.js";

export class DynamoRouteStore implements RouteStore {
  readonly #client: DynamoDBDocumentClient;
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

  async #withCapacityCircuitLock<T>(provider: ProviderId, candidateKey: string, action: () => Promise<T>): Promise<T> {
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

  async registerActiveTunnel(tunnel: ActiveTunnel): Promise<void> {
    const item: ActiveTunnelItem = {
      pk: `ACTIVE_TUNNEL#${tunnel.id}`,
      sk: "STATE",
      entity: shardedEntity("active_tunnel", tunnel.id),
      createdAt: tunnel.startedAt,
      gsi1pk: `DEPLOYMENT#${tunnel.deploymentId}`,
      gsi1sk: `${tunnel.startedAt}#${tunnel.id}`,
      expiresAtSeconds: Math.ceil(Date.parse(tunnel.expiresAt) / 1_000),
      tunnel,
    };
    const leases = this.#activeLoadLeaseKeys(tunnel).map((key) => ({
      ...key,
      entity: "active_load_lease",
      createdAt: tunnel.startedAt,
      expiresAtSeconds: item.expiresAtSeconds,
    }));
    await this.#client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } },
          ...leases.map((lease) => ({
            Put: { TableName: this.tableName, Item: lease, ConditionExpression: "attribute_not_exists(pk)" },
          })),
        ],
      }),
    );
  }

  async claimActiveTunnelSlot(
    candidateEndpointIds: readonly string[],
    selectEndpoint: (loads: ReadonlyMap<string, number>) => string,
    createTunnel: (endpointId: string) => ActiveTunnel,
  ): Promise<{ tunnel: ActiveTunnel; activeConnections: number }> {
    if (candidateEndpointIds.length === 0) throw new Error("no_slot_candidates");
    const candidates = new Set(candidateEndpointIds);
    const loads = (await this.getActiveConnectionCounts([], candidateEndpointIds, [])).endpoints;
    const endpointId = selectEndpoint(loads);
    if (!candidates.has(endpointId)) throw new Error("invalid_slot_selection");
    const tunnel = createTunnel(endpointId);
    await this.registerActiveTunnel(tunnel);
    return { tunnel, activeConnections: (loads.get(endpointId) ?? 0) + 1 };
  }

  async heartbeatActiveTunnel(id: string, lastHeartbeatAt: string, expiresAt: string): Promise<void> {
    const existing = await this.#client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: `ACTIVE_TUNNEL#${id}`, sk: "STATE" }, ConsistentRead: true }),
    );
    if (existing.Item === undefined) return;
    const tunnel = decodeActiveTunnel(itemField(existing.Item, "tunnel", "DynamoDB active-tunnel item"));
    const ttl = Math.ceil(Date.parse(expiresAt) / 1_000);
    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: `ACTIVE_TUNNEL#${id}`, sk: "STATE" },
                UpdateExpression: "SET #tunnel.lastHeartbeatAt = :heartbeat, #tunnel.expiresAt = :expiresAt, expiresAtSeconds = :ttl",
                ConditionExpression: "attribute_exists(pk)",
                ExpressionAttributeNames: { "#tunnel": "tunnel" },
                ExpressionAttributeValues: { ":heartbeat": lastHeartbeatAt, ":expiresAt": expiresAt, ":ttl": ttl },
              },
            },
            ...this.#activeLoadLeaseKeys(tunnel).map((key) => ({
              Update: {
                TableName: this.tableName,
                Key: key,
                UpdateExpression: "SET expiresAtSeconds = :ttl",
                ConditionExpression: "attribute_exists(pk)",
                ExpressionAttributeValues: { ":ttl": ttl },
              },
            })),
          ],
        }),
      );
    } catch (error) {
      if (!(error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException")))
        throw error;
    }
  }

  async removeActiveTunnel(id: string): Promise<void> {
    const existing = await this.#client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: `ACTIVE_TUNNEL#${id}`, sk: "STATE" }, ConsistentRead: true }),
    );
    if (existing.Item === undefined) return;
    const tunnel = decodeActiveTunnel(itemField(existing.Item, "tunnel", "DynamoDB active-tunnel item"));
    await this.#client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { pk: `ACTIVE_TUNNEL#${id}`, sk: "STATE" },
              UpdateExpression: "REMOVE gsi1pk, gsi1sk SET expiresAtSeconds = :expired",
              ExpressionAttributeValues: { ":expired": Math.floor(Date.now() / 1_000) - 1 },
            },
          },
          ...this.#activeLoadLeaseKeys(tunnel).map((key) => ({ Delete: { TableName: this.tableName, Key: key } })),
        ],
      }),
    );
  }

  #activeLoadLeaseKeys(tunnel: ActiveTunnel): Array<{ pk: string; sk: string }> {
    return [
      { pk: `ACTIVE_LOAD#PROVIDER#${tunnel.provider}`, sk: tunnel.id },
      ...(tunnel.endpointId === undefined ? [] : [{ pk: `ACTIVE_LOAD#ENDPOINT#${tunnel.endpointId}`, sk: tunnel.id }]),
      ...(tunnel.sessionId === undefined ? [] : [{ pk: `ACTIVE_LOAD#SESSION#${tunnel.sessionId}`, sk: tunnel.id }]),
    ];
  }

  async #countActiveLoad(pk: string, now: string): Promise<number> {
    let count = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          FilterExpression: "expiresAtSeconds > :now",
          ExpressionAttributeValues: { ":pk": pk, ":now": Math.floor(Date.parse(now) / 1_000) },
          Select: "COUNT",
          ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );
      count += result.Count ?? 0;
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return count;
  }

  async getActiveConnectionCounts(
    providers: readonly ProviderId[],
    endpointIds: readonly string[],
    sessionIds: readonly string[],
    now = new Date().toISOString(),
  ): Promise<{
    providers: ReadonlyMap<ProviderId, number>;
    endpoints: ReadonlyMap<string, number>;
    sessions: ReadonlyMap<string, number>;
  }> {
    const providerCounts = await Promise.all(
      providers.map(async (provider) => [provider, await this.#countActiveLoad(`ACTIVE_LOAD#PROVIDER#${provider}`, now)] as const),
    );
    const endpointCounts = await Promise.all(
      endpointIds.map(async (endpointId) => [endpointId, await this.#countActiveLoad(`ACTIVE_LOAD#ENDPOINT#${endpointId}`, now)] as const),
    );
    const sessionCounts = await Promise.all(
      sessionIds.map(async (sessionId) => [sessionId, await this.#countActiveLoad(`ACTIVE_LOAD#SESSION#${sessionId}`, now)] as const),
    );
    return { providers: new Map(providerCounts), endpoints: new Map(endpointCounts), sessions: new Map(sessionCounts) };
  }

  async getCapacityCircuit(
    provider: ProviderId,
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
    provider: ProviderId,
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
    provider: ProviderId,
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

  async resetCapacityCircuit(provider: ProviderId, candidateKey: string): Promise<void> {
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
    const items = (
      await Promise.all(
        entityShards("active_tunnel").map((entity) =>
          this.#queryAll({
            TableName: this.tableName,
            IndexName: ENTITY_INDEX,
            KeyConditionExpression: "#entity = :entity",
            ExpressionAttributeNames: { "#entity": "entity" },
            ExpressionAttributeValues: { ":entity": entity },
          }),
        ),
      )
    ).flat();
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
