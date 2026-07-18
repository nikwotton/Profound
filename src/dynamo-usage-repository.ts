import { DynamoDBDocumentClient, PutCommand, QueryCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  ENTITY_INDEX,
  itemField,
  type CapacityPressureEvidenceItem,
  type UsageAlertEventItem,
  type UsageReconciliationItem,
  type UsageRecordItem,
  type UsageRollupItem,
} from "./dynamo-records.js";
import {
  decodeCapacityPressureEvidence,
  decodeUsageAlertEvent,
  decodeUsageReconciliation,
  decodeUsageRecord,
  decodeUsageRollup,
} from "./storage-decoding.js";
import type { UsageRepository } from "./store.js";
import type { CapacityPressureEvidence, UsageAlertEvent, UsageReconciliation, UsageRecord, UsageRollup } from "./types.js";

export class DynamoUsageRepository implements UsageRepository {
  constructor(
    private readonly tableName: string,
    private readonly client: DynamoDBDocumentClient,
  ) {}

  async #queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
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

  async recordUsage(record: UsageRecord): Promise<boolean> {
    try {
      await this.client.send(
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
    await this.client.send(
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
      await this.client.send(
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
      await this.client.send(
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
    await this.client.send(
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
}
