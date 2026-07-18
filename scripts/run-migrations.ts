import { readFile } from "node:fs/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { expectArray, expectRecord, expectString, parseJson } from "../src/decoding.js";
import { runUnappliedMigrations, type Migration } from "../src/migration-runner.js";

function isMigrationApply(value: unknown): value is () => unknown {
  return typeof value === "function";
}

const manifest = expectArray(
  parseJson(await readFile(new URL("../migrations/manifest.json", import.meta.url), "utf8"), "migrations/manifest.json"),
  "migrations/manifest.json",
).map((entry, index) => expectString(entry, `migrations/manifest.json[${index}]`));
if (manifest.length === 0) {
  process.stdout.write("No registered migrations.\n");
  process.exit(0);
}
const tableName = process.env.ROUTE_TABLE_NAME?.trim();
if (!tableName) throw new Error("ROUTE_TABLE_NAME is required when migrations are registered");
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const migrations = await Promise.all(
  manifest.map(async (entry): Promise<Migration> => {
    const module = expectRecord(await import(new URL(`../migrations/${entry}`, import.meta.url).href), entry);
    const migration = expectRecord(module.migration, `${entry}.migration`);
    const id = expectString(migration.id, `${entry}.migration.id`);
    const apply = migration.apply;
    if (!isMigrationApply(apply)) throw new TypeError(`${entry}.migration.apply must be a function`);
    return {
      id,
      async apply(): Promise<void> {
        await apply();
      },
    };
  }),
);
const ledger = {
  async listApplied() {
    const response = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "MIGRATION#GLOBAL" },
        ConsistentRead: true,
      }),
    );
    return new Set((response.Items ?? []).map((item, index) => expectString(item.id, `migration ledger item ${index}.id`)));
  },
  async markApplied(id: string): Promise<void> {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: { pk: "MIGRATION#GLOBAL", sk: id, id, appliedAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  },
};
try {
  const completed = await runUnappliedMigrations(migrations, ledger);
  process.stdout.write(`${JSON.stringify({ completed })}\n`);
} finally {
  client.destroy();
}
