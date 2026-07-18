import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { claimCapacityCircuitProbe, recordCapacityCircuitFailure } from "./capacity-circuit.js";
import {
  ASSIGNMENT_INDEX,
  ENTITY_INDEX,
  capacityCircuitKey,
  entityShards,
  itemField,
  shardedEntity,
  type ActiveTunnelItem,
  type CapacityCircuitItem,
  type DeploymentDrainItem,
} from "./dynamo-records.js";
import { decodeActiveTunnel, decodeCapacityCircuitState, decodeDeploymentDrainState } from "./storage-decoding.js";
import type { ActiveTunnelRepository, CapacityCircuitRepository, DeploymentRepository } from "./store.js";
import type { ActiveTunnel, CapacityCircuitReason, CapacityCircuitState, DeploymentDrainState, ProviderId } from "./domain/routing.js";

export class DynamoRuntimeStateRepository implements ActiveTunnelRepository, CapacityCircuitRepository, DeploymentRepository {
  readonly #client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBDocumentClient,
  ) {
    this.#client = client;
  }

  async #queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }));
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
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
    provider: ProviderId,
    candidateEndpointIds: readonly string[],
    selectEndpoint: (loads: ReadonlyMap<string, number>) => string,
    createTunnel: (endpointId: string) => ActiveTunnel,
  ): Promise<{ tunnel: ActiveTunnel; activeConnections: number }> {
    if (candidateEndpointIds.length === 0) throw new Error("no_slot_candidates");
    const candidates = new Set(candidateEndpointIds);
    const loads = (await this.getActiveConnectionCounts([provider], candidateEndpointIds, [])).endpoints;
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
      ...(tunnel.endpointId === undefined ? [] : [{ pk: `ACTIVE_LOAD#ENDPOINT#${tunnel.provider}#${tunnel.endpointId}`, sk: tunnel.id }]),
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
    const endpointProvider = providers.length === 1 ? providers[0] : undefined;
    const endpointCounts = await Promise.all(
      endpointIds.map(
        async (endpointId) =>
          [
            endpointId,
            await this.#countActiveLoad(
              endpointProvider === undefined
                ? `ACTIVE_LOAD#ENDPOINT#${endpointId}`
                : `ACTIVE_LOAD#ENDPOINT#${endpointProvider}#${endpointId}`,
              now,
            ),
          ] as const,
      ),
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
}
