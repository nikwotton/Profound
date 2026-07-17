import { readFile } from "node:fs/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { runUnappliedMigrations } from "../dist/src/migration-runner.js";

const manifest = JSON.parse(await readFile(new URL("../migrations/manifest.json", import.meta.url), "utf8"));
if (!Array.isArray(manifest)) throw new Error("migrations/manifest.json must be an array");
if (manifest.length === 0) {
  process.stdout.write("No registered migrations.\n");
  process.exit(0);
}
const tableName = process.env.ROUTE_TABLE_NAME?.trim();
if (!tableName) throw new Error("ROUTE_TABLE_NAME is required when migrations are registered");
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const migrations = await Promise.all(
  manifest.map(async (entry) => {
    if (typeof entry !== "string") throw new Error("Migration manifest entries must be module paths");
    const module = await import(new URL(`../migrations/${entry}`, import.meta.url).href);
    return module.migration;
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
    return new Set((response.Items ?? []).map((item) => String(item.id)));
  },
  async markApplied(id) {
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
