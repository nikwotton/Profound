import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { entityShards, shardedEntity } from "../src/dynamo-records.js";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";

test("hot-path persistence is sharded and mobile placement has no global selection lock", () => {
  const dynamo = readFileSync("src/dynamo-store.ts", "utf8");
  const store = readFileSync("src/store.ts", "utf8");
  const tracker = readFileSync("src/active-connection-tracker.ts", "utf8");
  assert.doesNotMatch(dynamo, /PROXY_SLOT_SELECTION#GLOBAL/);
  assert.doesNotMatch(store, /scryptSync/);
  assert.equal(new Set(entityShards("active_tunnel")).size, 16);
  assert.ok(new Set(Array.from({ length: 100 }, (_, index) => shardedEntity("usage_record", `usage-${index}`))).size > 8);
  assert.equal((tracker.match(/setInterval\(/g) ?? []).length, 1, "the task owns one shared authorization poller");
});

test("routing evidence reads can be bounded newest-first", async () => {
  const store = new InMemoryRouteStore();
  for (let index = 0; index < 10; index += 1) {
    await store.recordUsage({
      id: `usage-${index}`,
      kind: "attempt",
      logicalOperationId: `operation-${index}`,
      customerId: "customer",
      accessGrantId: "grant",
      routeId: "route",
      userId: "user",
      provider: "bright_data",
      protocol: "http",
      outcome: "success",
      retryIndex: 0,
      failover: false,
      startedAt: `2026-07-18T00:00:${String(index).padStart(2, "0")}.000Z`,
      completedAt: `2026-07-18T00:00:${String(index).padStart(2, "0")}.500Z`,
      bytesSent: 1,
      bytesReceived: 1,
      latencyMs: 500,
      pricingVersion: "2026-07-18",
      pricingModel: "per_gib",
      priceUsd: 1,
    });
  }
  const records = await store.listUsageRecords("2026-07-18T00:00:00.000Z", "2026-07-19T00:00:00.000Z", {
    limit: 3,
    newestFirst: true,
  });
  assert.deepEqual(
    records.map(({ id }) => id),
    ["usage-9", "usage-8", "usage-7"],
  );
});
