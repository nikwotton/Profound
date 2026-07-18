import assert from "node:assert/strict";
import test from "node:test";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoRouteStore } from "../src/dynamo-store.js";
import type {
  CapabilityHealthSnapshot,
  CapacityPressureEvidence,
  HealthAlertEvent,
  HealthAlertState,
  ProviderHealth,
  RouteProfile,
  UsageAlertEvent,
} from "../src/types.js";

interface CapturedCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

test("DynamoDB persistence survives store replacement and excludes caller-facing secrets", async () => {
  const commands: CapturedCommand[] = [];
  let routeItem: Record<string, unknown> | undefined;
  let accessGrantItem: Record<string, unknown> | undefined;
  let healthItem: Record<string, unknown> | undefined;
  let inventoryItem: Record<string, unknown> | undefined;
  const capabilityItems: Record<string, unknown>[] = [];
  let destroyed = false;
  const client = {
    send: async (raw: unknown): Promise<Record<string, unknown>> => {
      const command = raw as CapturedCommand;
      commands.push(command);
      if (command.constructor.name === "PutCommand") {
        const item = command.input["Item"] as Record<string, unknown>;
        if (item["entity"] === "route") routeItem = item;
        if (item["entity"] === "access_grant") accessGrantItem = item;
        if (item["entity"] === "health") healthItem = item;
        if (item["entity"] === "provider_inventory") inventoryItem = item;
        if (item["entity"] === "capability_health") capabilityItems.unshift(item);
        return {};
      }
      if (command.constructor.name === "GetCommand") {
        const key = command.input["Key"] as { pk?: string };
        const item = key.pk?.startsWith("ACCESS_GRANT#")
          ? accessGrantItem
          : key.pk?.startsWith("PROVIDER_INVENTORY#")
            ? inventoryItem
            : routeItem;
        return item === undefined ? {} : { Item: item };
      }
      if (command.constructor.name === "QueryCommand") {
        const values = command.input["ExpressionAttributeValues"] as Record<string, unknown>;
        if (values[":pk"] === "CAPABILITY_HEALTH#GLOBAL") {
          const limit = Number(command.input["Limit"] ?? capabilityItems.length);
          return { Items: capabilityItems.slice(0, limit) };
        }
        return values[":entity"] === "health"
          ? { Items: healthItem === undefined ? [] : [healthItem] }
          : values[":entity"] === "access_grant"
            ? { Items: accessGrantItem === undefined ? [] : [accessGrantItem] }
            : { Items: routeItem === undefined ? [] : [routeItem] };
      }
      return {};
    },
    destroy: () => {
      destroyed = true;
    },
  } as DynamoDBDocumentClient;
  const store = new DynamoRouteStore("route-state", client);
  const profile: RouteProfile = {
    name: "aws-route",
    allowedProtocols: ["http", "https", "socks5"],
    targeting: { country: "US", region: "NY", city: "New York", carrier: "T-Mobile" },
    rotation: { mode: "manual" },
    session: { mode: "sticky", id: "session-1", requireGeographicContinuity: true },
    customerId: "customer-a",
    userId: "user-a",
    isTargetAuthenticated: true,
    allowConnectionRetry: false,
    isAuthenticated: true,
    shouldRetry: false,
    retryPolicy: { maxAttempts: 1 },
  };
  const token = "route-token-that-must-not-be-stored";

  await store.create("route-1", profile, "proxidize");
  assert.doesNotMatch(JSON.stringify(routeItem), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(routeItem), /tokenHash|tokenSalt/);
  const grant = await store.createAccessGrant("grant-1", "route-1", "user-a", "credential-1", token);
  assert.notEqual(grant.credentials[0]?.tokenHash, token);
  assert.doesNotMatch(JSON.stringify(accessGrantItem), new RegExp(token));
  assert.equal((await store.authenticateAccessGrant("pxy_credential-1", token))?.id, "grant-1");
  assert.equal(await store.authenticateAccessGrant("pxy_credential-1", "incorrect"), undefined);
  assert.deepEqual(
    (await store.list()).map((route) => route.id),
    ["route-1"],
  );
  const replacement = new DynamoRouteStore("route-state", client);
  assert.equal((await replacement.get("route-1")).customerId, "customer-a");
  assert.equal((await replacement.authenticateAccessGrant("pxy_credential-1", token))?.id, "grant-1");

  const health: ProviderHealth = {
    provider: "proxidize",
    state: "healthy",
    checkedAt: "2026-07-13T00:00:00.000Z",
  };
  await store.saveHealth(health);
  assert.deepEqual(await store.listHealth(), [health]);
  const inventory = {
    provider: "proxidize" as const,
    providerAccountId: "proxidize-primary",
    slots: [
      {
        proxySlotId: "slot-1",
        deviceId: "device-1",
        country: "US",
        region: "NY",
        city: "New York",
        carrier: "T-Mobile",
        healthy: true,
      },
    ],
    capturedAt: "2026-07-13T00:00:30.000Z",
  };
  await store.saveProviderInventory(inventory);
  assert.deepEqual(await store.latestProviderInventory("proxidize"), inventory);
  const snapshot: CapabilityHealthSnapshot = {
    id: "snapshot-1",
    generatedAt: "2026-07-13T00:01:00.000Z",
    capabilities: [{ capability: "all_traffic", status: "operational" }],
    providers: [health],
    geographies: [],
  };
  await store.saveCapabilityHealth(snapshot);
  assert.deepEqual(await store.latestCapabilityHealth(), snapshot);
  assert.deepEqual(await store.capabilityHealthHistory(10), [snapshot]);
  await store.revoke("route-1");
  const revoke = commands.find(
    (command) => command.constructor.name === "UpdateCommand" && String(command.input["UpdateExpression"]).includes("REMOVE gsi1pk"),
  );
  assert.match(String(revoke?.input["UpdateExpression"]), /REMOVE gsi1pk, gsi1sk/);
  await store.close();
  assert.equal(destroyed, true);
});

test("DynamoDB persists alert episodes and delivery state", async () => {
  const items = new Map<string, Record<string, unknown>>();
  const client = {
    send: async (raw: unknown): Promise<Record<string, unknown>> => {
      const command = raw as CapturedCommand;
      if (command.constructor.name === "PutCommand") {
        const item = command.input["Item"] as Record<string, unknown>;
        const key = `${String(item["pk"])}|${String(item["sk"])}`;
        if (command.input["ConditionExpression"] !== undefined && items.has(key)) {
          const error = new Error("duplicate");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
        items.set(key, item);
        return {};
      }
      if (command.constructor.name === "GetCommand") {
        const key = command.input["Key"] as Record<string, unknown>;
        return { Item: items.get(`${String(key["pk"])}|${String(key["sk"])}`) };
      }
      if (command.constructor.name === "QueryCommand") {
        const values = command.input["ExpressionAttributeValues"] as Record<string, unknown>;
        const entity = values[":entity"];
        const dueBefore = values[":dueBefore"];
        if (dueBefore !== undefined && typeof dueBefore !== "string") throw new TypeError(":dueBefore must be a string");
        const matched = [...items.values()]
          .filter((item) => entity === undefined || item["entity"] === entity)
          .filter((item) => dueBefore === undefined || String(item["createdAt"]) <= dueBefore)
          .sort((left, right) => String(left["createdAt"]).localeCompare(String(right["createdAt"])));
        if (command.input["ScanIndexForward"] === false) matched.reverse();
        return { Items: matched.slice(0, Number(command.input["Limit"] ?? matched.length)) };
      }
      return {};
    },
    destroy: () => undefined,
  } as DynamoDBDocumentClient;
  const store = new DynamoRouteStore("route-state", client);
  const state: HealthAlertState = {
    capability: "all_traffic",
    observedStatus: "unavailable",
    observedSince: "2026-07-15T00:00:00.000Z",
    alertedStatus: "unavailable",
    alertedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
  await store.saveHealthAlertState(state);
  assert.deepEqual(await store.getHealthAlertState("all_traffic"), state);
  const event: HealthAlertEvent = {
    id: "alert-1",
    dedupeKey: "all_traffic:alert:unavailable:episode-1",
    kind: "alert",
    capability: "all_traffic",
    status: "unavailable",
    severity: "critical",
    createdAt: "2026-07-15T00:00:00.000Z",
    snapshotId: "snapshot-1",
    configurationVersion: "ops-v1",
    geographies: [],
  };
  assert.equal(await store.createHealthAlertEvent(event, ["ops"]), true);
  assert.equal(await store.createHealthAlertEvent(event, ["ops"]), false);
  assert.deepEqual(await store.healthAlertHistory(10), [event]);
  const pending = await store.pendingHealthAlertDeliveries("2026-07-15T00:00:01.000Z", 10);
  assert.equal(pending.length, 1);
  const pendingDelivery = pending[0];
  assert.ok(pendingDelivery);
  await store.saveHealthAlertDelivery({
    ...pendingDelivery,
    status: "delivered",
    attemptCount: 1,
    deliveredAt: "2026-07-15T00:00:01.000Z",
  });
  assert.deepEqual(await store.pendingHealthAlertDeliveries("2026-07-15T00:00:02.000Z", 10), []);
  const usageAlert: UsageAlertEvent = {
    id: "capacity:period-1",
    kind: "capacity_recommendation",
    severity: "warning",
    provider: "proxidize",
    periodStartedAt: "2026-07-15T00:00:00.000Z",
    periodEndsAt: "2026-07-15T01:00:00.000Z",
    relatedRecordId: "period-1",
    capacityPolicyVersion: "policy-v1",
    capacityDrivenFallbackCount: 1,
    capacityFailureCount: 0,
    capacityWaitMs: 250,
    createdAt: "2026-07-15T01:00:00.000Z",
  };
  assert.equal(await store.saveUsageAlertEvent(usageAlert), true);
  assert.equal(await store.saveUsageAlertEvent(usageAlert), false);
  assert.deepEqual(await store.listUsageAlertEvents("2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z"), [usageAlert]);
  const capacityEvidence: CapacityPressureEvidence = {
    id: "capacity:period-1",
    provider: "proxidize",
    periodStartedAt: "2026-07-15T00:00:00.000Z",
    periodEndsAt: "2026-07-15T01:00:00.000Z",
    relatedRollupId: "period-1",
    capacityPolicyVersion: "policy-v1",
    capacityDrivenFallbackCount: 1,
    capacityFailureCount: 0,
    capacityWaitMs: 250,
    concurrencyUtilization: 1.1,
    throughputUtilization: 0.8,
    observedAt: "2026-07-15T01:00:00.000Z",
  };
  await store.saveCapacityPressureEvidence(capacityEvidence);
  assert.deepEqual(await store.listCapacityPressureEvidence("2026-07-15T00:59:00.000Z"), [capacityEvidence]);
});
