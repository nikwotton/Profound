import { scryptSync, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { NotFoundError } from "./errors.js";
import {
  ACCESS_GRANT_CREDENTIAL_OVERLAP_MS,
  createStoredCredential,
  type RouteStore,
} from "./store.js";
import { DEVICE_LEASE_IDLE_TIMEOUT_MS } from "./types.js";
import type {
  CapabilityHealthSnapshot,
  CapabilityName,
  DeviceLease,
  HealthAlertDelivery,
  HealthAlertEvent,
  HealthAlertState,
  ProviderHealth,
  RouteProfile,
  RouteStatus,
  StoredAccessGrant,
  StoredAccessGrantCredential,
  StoredRoute,
} from "./types.js";

const ENTITY_INDEX = "EntityCreatedAt";
const ASSIGNMENT_INDEX = "EndpointAssignments";

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

interface DeviceLeaseItem {
  pk: string;
  sk: "STATE";
  entity: "device_lease";
  createdAt: string;
  leaseKey: string;
  expiresAtMs: number;
  lease: DeviceLease;
}

interface DeviceLeaseLockItem {
  pk: string;
  sk: "LEASE";
  entity: "device_lease_lock";
  createdAt: string;
  leaseKey: string;
  endpointId: string;
  expiresAtMs: number;
}

function routeKey(id: string): { pk: string; sk: string } {
  return { pk: `ROUTE#${id}`, sk: "STATE" };
}

function accessGrantKey(id: string): { pk: string; sk: "STATE" } {
  return { pk: `ACCESS_GRANT#${id}`, sk: "STATE" };
}

function deviceLeaseKey(leaseKey: string): { pk: string; sk: "STATE" } {
  return { pk: `DEVICE_LEASE#${leaseKey}`, sk: "STATE" };
}

function deviceLockKey(endpointId: string): { pk: string; sk: "LEASE" } {
  return { pk: `DEVICE#${endpointId}`, sk: "LEASE" };
}

function leaseExpiry(lease: DeviceLease, idleTimeoutMs: number): number {
  return Math.max(Date.parse(lease.lastActivityAt) + idleTimeoutMs, Date.parse(lease.activeUntil));
}

function conditionalNotFound(error: unknown): never {
  if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw new NotFoundError();
  throw error;
}

function credentialUsable(credential: StoredAccessGrantCredential, nowMs: number): boolean {
  return credential.status !== "revoked" && Date.parse(credential.expiresAt) > nowMs &&
    (credential.revokeAt === undefined || Date.parse(credential.revokeAt) > nowMs);
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
    ...(grant.endpointId === undefined ? {} : {
      gsi1pk: `ENDPOINT#${grant.endpointId}`,
      gsi1sk: `${grant.createdAt}#${grant.id}`,
    }),
  };
}

export class DynamoRouteStore implements RouteStore {
  readonly #client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
  ) {
    this.#client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async create(
    id: string,
    profile: RouteProfile,
    provider: StoredRoute["provider"],
    endpointId?: string,
  ): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const route: StoredRoute = {
      id,
      name: profile.name,
      targeting: profile.targeting,
      rotation: profile.rotation,
      allowedProtocols: profile.allowedProtocols,
      session: profile.session,
      customerId: profile.customerId,
      userId: profile.userId,
      isAuthenticated: profile.isAuthenticated,
      shouldRetry: profile.shouldRetry,
      retryPolicy: profile.retryPolicy,
      ...(profile.forceProvider === undefined ? {} : { forceProvider: profile.forceProvider }),
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
      ...(endpointId === undefined
        ? {}
        : { gsi1pk: `ENDPOINT#${endpointId}`, gsi1sk: `${now}#${id}` }),
    };
    await this.#client.send(new PutCommand({
      TableName: this.tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return route;
  }

  async get(id: string, includeRevoked = false): Promise<StoredRoute> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.tableName,
      Key: routeKey(id),
      ConsistentRead: true,
    }));
    const item = result.Item as RouteItem | undefined;
    if (item === undefined || (!includeRevoked && item.route.status === "revoked")) throw new NotFoundError();
    return item.route;
  }

  async #queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(new QueryCommand({
        ...input,
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }));
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
    return items.map((item) => (item as unknown as RouteItem).route);
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
    await this.#client.send(new PutCommand({
      TableName: this.tableName,
      Item: grantItem(grant),
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return grant;
  }

  async getAccessGrant(id: string, includeRevoked = false): Promise<StoredAccessGrant> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.tableName,
      Key: accessGrantKey(id),
      ConsistentRead: true,
    }));
    const item = result.Item as AccessGrantItem | undefined;
    if (item === undefined || (!includeRevoked && item.grant.status === "revoked")) throw new NotFoundError();
    return item.grant;
  }

  async listAccessGrants(routeId: string, principalId?: string): Promise<StoredAccessGrant[]> {
    await this.get(routeId);
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity",
      FilterExpression: "routeId = :routeId" +
        (principalId === undefined ? "" : " AND principalId = :principalId"),
      ExpressionAttributeNames: { "#entity": "entity" },
      ExpressionAttributeValues: {
        ":entity": "access_grant",
        ":routeId": routeId,
        ...(principalId === undefined ? {} : { ":principalId": principalId }),
      },
    });
    return items.map((item) => (item as unknown as AccessGrantItem).grant);
  }

  async authenticateAccessGrant(id: string, token: string): Promise<StoredAccessGrant | undefined> {
    let grant: StoredAccessGrant;
    try {
      grant = await this.getAccessGrant(id);
      await this.get(grant.routeId);
    } catch {
      return undefined;
    }
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const credentialIndex = grant.credentials.findIndex((candidateCredential) => {
      if (!credentialUsable(candidateCredential, nowMs)) return false;
      const candidate = scryptSync(token, candidateCredential.tokenSalt, 32);
      const expected = Buffer.from(candidateCredential.tokenHash, "hex");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
    if (credentialIndex < 0) return undefined;
    const credential = grant.credentials[credentialIndex]!;
    credential.lastUsedAt = now;
    grant.updatedAt = now;
    await this.#client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: accessGrantKey(id),
      UpdateExpression: `SET #grant.#credentials[${credentialIndex}].#lastUsedAt = :now, #grant.updatedAt = :now`,
      ConditionExpression: "attribute_exists(pk) AND #status <> :revoked AND #grant.#credentials[" + credentialIndex + "].#tokenHash = :tokenHash",
      ExpressionAttributeNames: {
        "#grant": "grant",
        "#credentials": "credentials",
        "#lastUsedAt": "lastUsedAt",
        "#tokenHash": "tokenHash",
        "#status": "status",
      },
      ExpressionAttributeValues: { ":now": now, ":revoked": "revoked", ":tokenHash": credential.tokenHash },
    }));
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
      await this.#client.send(new PutCommand({
        TableName: this.tableName,
        Item: grantItem(grant),
        ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":revoked": "revoked" },
      }));
      return grant;
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async revokeAccessGrant(id: string, terminateActive = false): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: accessGrantKey(id),
        UpdateExpression: "SET #status = :revoked, #grant.#status = :revoked, #grant.terminateActive = :terminate, #grant.updatedAt = :now REMOVE gsi1pk, gsi1sk",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status", "#grant": "grant" },
        ExpressionAttributeValues: { ":revoked": "revoked", ":terminate": terminateActive, ":now": now },
      }));
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async setAccessGrantEndpoint(id: string, endpointId?: string): Promise<StoredAccessGrant> {
    const now = new Date().toISOString();
    const update = endpointId === undefined
      ? "SET #grant.updatedAt = :now REMOVE #grant.endpointId, gsi1pk, gsi1sk"
      : "SET #grant.endpointId = :endpointId, #grant.updatedAt = :now, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk";
    try {
      const result = await this.#client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: accessGrantKey(id),
        UpdateExpression: update,
        ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
        ExpressionAttributeNames: { "#status": "status", "#grant": "grant" },
        ExpressionAttributeValues: {
          ":now": now,
          ":revoked": "revoked",
          ...(endpointId === undefined ? {} : {
            ":endpointId": endpointId,
            ":gsi1pk": `ENDPOINT#${endpointId}`,
            ":gsi1sk": `${now}#${id}`,
          }),
        },
        ReturnValues: "ALL_NEW",
      }));
      return (result.Attributes as unknown as AccessGrantItem).grant;
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async revoke(id: string, terminateActive = false): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: routeKey(id),
        UpdateExpression: "SET #status = :status, #route.#status = :status, #route.terminateActive = :terminate, #route.updatedAt = :now REMOVE gsi1pk, gsi1sk",
        ConditionExpression: terminateActive
          ? "attribute_exists(pk)"
          : "attribute_exists(pk) AND #status <> :status",
        ExpressionAttributeNames: { "#status": "status", "#route": "route" },
        ExpressionAttributeValues: { ":status": "revoked", ":terminate": terminateActive, ":now": now },
      }));
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

  async setEndpoint(id: string, endpointId?: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const update = endpointId === undefined
      ? "SET #route.updatedAt = :now REMOVE #route.endpointId, gsi1pk, gsi1sk"
      : "SET #route.endpointId = :endpointId, #route.updatedAt = :now, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk";
    try {
      const result = await this.#client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: routeKey(id),
        UpdateExpression: update,
        ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
        ExpressionAttributeNames: { "#status": "status", "#route": "route" },
        ExpressionAttributeValues: {
          ":now": now,
          ":revoked": "revoked",
          ...(endpointId === undefined ? {} : {
            ":endpointId": endpointId,
            ":gsi1pk": `ENDPOINT#${endpointId}`,
            ":gsi1sk": `${now}#${id}`,
          }),
        },
        ReturnValues: "ALL_NEW",
      }));
      return (result.Attributes as unknown as RouteItem).route;
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async acquireDeviceLease(
    leaseKey: string,
    routeId: string,
    candidateEndpointIds: readonly string[],
    now: string,
    idleTimeoutMs: number,
  ): Promise<DeviceLease | undefined> {
    if (candidateEndpointIds.length === 0) return undefined;
    const nowMs = Date.parse(now);
    const existingResult = await this.#client.send(new GetCommand({
      TableName: this.tableName,
      Key: deviceLeaseKey(leaseKey),
      ConsistentRead: true,
    }));
    const existing = existingResult.Item as DeviceLeaseItem | undefined;
    if (existing !== undefined && existing.expiresAtMs > nowMs) {
      if (candidateEndpointIds.includes(existing.lease.endpointId)) {
        return this.renewDeviceLease(leaseKey, now, existing.lease.activeUntil, true);
      }
    }

    for (const endpointId of candidateEndpointIds) {
      const lease: DeviceLease = {
        leaseKey,
        routeId,
        endpointId,
        lastActivityAt: now,
        activeUntil: now,
        createdAt: existing?.lease.createdAt ?? now,
        updatedAt: now,
      };
      const expiresAtMs = leaseExpiry(lease, idleTimeoutMs);
      const leaseItem: DeviceLeaseItem = {
        ...deviceLeaseKey(leaseKey),
        entity: "device_lease",
        createdAt: lease.createdAt,
        leaseKey,
        expiresAtMs,
        lease,
      };
      const lockItem: DeviceLeaseLockItem = {
        ...deviceLockKey(endpointId),
        entity: "device_lease_lock",
        createdAt: now,
        leaseKey,
        endpointId,
        expiresAtMs,
      };
      try {
        await this.#client.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: leaseItem,
                ConditionExpression: "attribute_not_exists(pk) OR expiresAtMs <= :now OR leaseKey = :leaseKey",
                ExpressionAttributeValues: { ":now": nowMs, ":leaseKey": leaseKey },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: lockItem,
                ConditionExpression: "attribute_not_exists(pk) OR expiresAtMs <= :now OR leaseKey = :leaseKey",
                ExpressionAttributeValues: { ":now": nowMs, ":leaseKey": leaseKey },
              },
            },
            ...(existing === undefined || existing.lease.endpointId === endpointId ? [] : [{
              Delete: {
                TableName: this.tableName,
                Key: deviceLockKey(existing.lease.endpointId),
                ConditionExpression: "leaseKey = :leaseKey",
                ExpressionAttributeValues: { ":leaseKey": leaseKey },
              },
            }]),
          ],
        }));
        return lease;
      } catch (error) {
        if (!(error instanceof Error && error.name === "TransactionCanceledException")) throw error;
      }
    }
    return undefined;
  }

  async renewDeviceLease(
    leaseKey: string,
    now: string,
    activeUntil: string,
    recordActivity: boolean,
  ): Promise<DeviceLease | undefined> {
    const existing = await this.getDeviceLease(leaseKey);
    if (existing === undefined) return undefined;
    const lease: DeviceLease = {
      ...existing,
      ...(recordActivity ? { lastActivityAt: now } : {}),
      activeUntil,
      updatedAt: now,
    };
    const expiresAtMs = leaseExpiry(lease, DEVICE_LEASE_IDLE_TIMEOUT_MS);
    try {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: deviceLeaseKey(leaseKey),
              UpdateExpression: "SET #lease = :lease, expiresAtMs = :expiresAtMs",
              ConditionExpression: "leaseKey = :leaseKey",
              ExpressionAttributeNames: { "#lease": "lease" },
              ExpressionAttributeValues: { ":lease": lease, ":expiresAtMs": expiresAtMs, ":leaseKey": leaseKey },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: deviceLockKey(lease.endpointId),
              UpdateExpression: "SET expiresAtMs = :expiresAtMs",
              ConditionExpression: "leaseKey = :leaseKey",
              ExpressionAttributeValues: { ":expiresAtMs": expiresAtMs, ":leaseKey": leaseKey },
            },
          },
        ],
      }));
      return lease;
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionCanceledException") return undefined;
      throw error;
    }
  }

  async getDeviceLease(leaseKey: string): Promise<DeviceLease | undefined> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.tableName,
      Key: deviceLeaseKey(leaseKey),
      ConsistentRead: true,
    }));
    return (result.Item as DeviceLeaseItem | undefined)?.lease;
  }

  async releaseDeviceLease(leaseKey: string): Promise<void> {
    const existing = await this.getDeviceLease(leaseKey);
    if (existing === undefined) return;
    await this.#client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: this.tableName,
            Key: deviceLeaseKey(leaseKey),
            ConditionExpression: "leaseKey = :leaseKey",
            ExpressionAttributeValues: { ":leaseKey": leaseKey },
          },
        },
        {
          Delete: {
            TableName: this.tableName,
            Key: deviceLockKey(existing.endpointId),
            ConditionExpression: "leaseKey = :leaseKey",
            ExpressionAttributeValues: { ":leaseKey": leaseKey },
          },
        },
      ],
    })).catch((error: unknown) => {
      if (!(error instanceof Error && error.name === "TransactionCanceledException")) throw error;
    });
  }

  async setStatus(id: string, status: RouteStatus, lastError?: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    const update = lastError === undefined
      ? "SET #status = :status, #route.#status = :status, #route.updatedAt = :now REMOVE #route.lastError"
      : "SET #status = :status, #route.#status = :status, #route.updatedAt = :now, #route.lastError = :lastError";
    try {
      const result = await this.#client.send(new UpdateCommand({
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
      }));
      return (result.Attributes as unknown as RouteItem).route;
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async claimScheduledRotation(id: string, dueBefore: string): Promise<StoredRoute | undefined> {
    const now = new Date().toISOString();
    try {
      const result = await this.#client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: routeKey(id),
        UpdateExpression: "SET #status = :rotating, #route.#status = :rotating, #route.updatedAt = :now REMOVE #route.lastError",
        ConditionExpression: "attribute_exists(pk) AND #status = :ready AND (attribute_not_exists(#route.lastRotationAt) OR #route.lastRotationAt <= :dueBefore)",
        ExpressionAttributeNames: { "#status": "status", "#route": "route" },
        ExpressionAttributeValues: {
          ":rotating": "rotating",
          ":ready": "ready",
          ":now": now,
          ":dueBefore": dueBefore,
        },
        ReturnValues: "ALL_NEW",
      }));
      return (result.Attributes as unknown as RouteItem).route;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return undefined;
      throw error;
    }
  }

  async completeRotation(id: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    try {
      const result = await this.#client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: routeKey(id),
        UpdateExpression: "SET #status = :ready, #route.#status = :ready, #route.lastRotationAt = :now, #route.updatedAt = :now REMOVE #route.lastError",
        ConditionExpression: "attribute_exists(pk) AND #status = :rotating",
        ExpressionAttributeNames: { "#status": "status", "#route": "route" },
        ExpressionAttributeValues: { ":ready": "ready", ":rotating": "rotating", ":now": now },
        ReturnValues: "ALL_NEW",
      }));
      return (result.Attributes as unknown as RouteItem).route;
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async incrementRotationEpoch(id: string): Promise<StoredRoute> {
    const now = new Date().toISOString();
    try {
      const result = await this.#client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: routeKey(id),
        UpdateExpression: "SET #route.rotationEpoch = #route.rotationEpoch + :one, #route.updatedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #status <> :revoked",
        ExpressionAttributeNames: { "#status": "status", "#route": "route" },
        ExpressionAttributeValues: { ":one": 1, ":now": now, ":revoked": "revoked" },
        ReturnValues: "ALL_NEW",
      }));
      return (result.Attributes as unknown as RouteItem).route;
    } catch (error) {
      conditionalNotFound(error);
    }
  }

  async assignmentCount(endpointId: string): Promise<number> {
    let count = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: ASSIGNMENT_INDEX,
        KeyConditionExpression: "gsi1pk = :endpoint",
        ExpressionAttributeValues: { ":endpoint": `ENDPOINT#${endpointId}` },
        Select: "COUNT",
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }));
      count += result.Count ?? 0;
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return count;
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
    return items.map((item) => (item as unknown as HealthItem).health);
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
    const result = await this.#client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "CAPABILITY_HEALTH#GLOBAL" },
      ScanIndexForward: false,
      Limit: 1,
    }));
    const item = result.Items?.[0] as CapabilityHealthItem | undefined;
    return item?.snapshot;
  }

  async capabilityHealthHistory(limit: number): Promise<CapabilityHealthSnapshot[]> {
    const result = await this.#client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "CAPABILITY_HEALTH#GLOBAL" },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (result.Items ?? []).map((item) => (item as CapabilityHealthItem).snapshot);
  }

  async getHealthAlertState(capability: CapabilityName): Promise<HealthAlertState | undefined> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: "HEALTH_ALERT_STATE#GLOBAL", sk: capability },
      ConsistentRead: true,
    }));
    return (result.Item as HealthAlertStateItem | undefined)?.state;
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
      await this.#client.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
        created = false;
        const existing = await this.#client.send(new GetCommand({
          TableName: this.tableName,
          Key: { pk: item.pk, sk: item.sk },
          ConsistentRead: true,
        }));
        const existingItem = existing.Item as HealthAlertEventItem | undefined;
        if (existingItem === undefined) throw new Error("Health alert deduplication state is missing");
        persistedEvent = existingItem.event;
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
        await this.#client.send(new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `HEALTH_ALERT_DELIVERY#${delivery.alertId}`,
            sk: delivery.destinationId,
            entity: "health_alert_delivery_pending",
            createdAt: delivery.nextAttemptAt,
            delivery,
          } satisfies HealthAlertDeliveryItem,
          ConditionExpression: "attribute_not_exists(pk)",
        }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
    }
    return created;
  }

  async pendingHealthAlertDeliveries(dueBefore: string, limit: number): Promise<HealthAlertDelivery[]> {
    const result = await this.#client.send(new QueryCommand({
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
    }));
    return (result.Items ?? []).map((entry) => (entry as HealthAlertDeliveryItem).delivery);
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
    const result = await this.#client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity",
      ExpressionAttributeNames: { "#entity": "entity" },
      ExpressionAttributeValues: { ":entity": "health_alert_event" },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (result.Items ?? []).map((entry) => (entry as HealthAlertEventItem).event);
  }

  async close(): Promise<void> {
    this.#client.destroy();
  }
}
