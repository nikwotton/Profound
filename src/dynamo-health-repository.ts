import { GetCommand, PutCommand, QueryCommand, type QueryCommandInput, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ENTITY_INDEX,
  itemField,
  type CapabilityHealthItem,
  type HealthAlertDeliveryItem,
  type HealthAlertEventItem,
  type HealthAlertStateItem,
  type HealthItem,
  type ProviderInventoryItem,
} from "./dynamo-records.js";
import {
  decodeCapabilityHealthSnapshot,
  decodeHealthAlertDelivery,
  decodeHealthAlertEvent,
  decodeHealthAlertState,
  decodeProviderHealth,
  decodeProviderInventorySnapshot,
} from "./storage-decoding.js";
import type { CapabilityHealthRepository, HealthAlertRepository, ProviderHealthRepository } from "./store.js";
import type {
  CapabilityHealthSnapshot,
  CapabilityName,
  HealthAlertDelivery,
  HealthAlertEvent,
  HealthAlertState,
  ProviderHealth,
} from "./domain/health.js";
import type { ProviderInventorySnapshot } from "./domain/routing.js";

export class DynamoHealthRepository implements ProviderHealthRepository, CapabilityHealthRepository, HealthAlertRepository {
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

  async listProviderInventories(): Promise<ProviderInventorySnapshot[]> {
    const items = await this.#queryAll({
      TableName: this.tableName,
      IndexName: ENTITY_INDEX,
      KeyConditionExpression: "#entity = :entity",
      ExpressionAttributeNames: { "#entity": "entity" },
      ExpressionAttributeValues: { ":entity": "provider_inventory" },
    });
    return items
      .map((item) => decodeProviderInventorySnapshot(itemField(item, "snapshot", "DynamoDB provider-inventory item")))
      .toSorted((left, right) => left.provider.localeCompare(right.provider));
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
}
