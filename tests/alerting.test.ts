import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  HealthAlertCoordinator,
  parseHealthAlertDestinationConfig,
  WebhookNotificationAdapter,
} from "../src/alerting.js";
import { silentLogger } from "../src/logger.js";
import { requireServiceOwnedCapabilityAlerts } from "../src/runtime-services.js";
import { SqliteRouteStore } from "../src/store.js";
import type { CapabilityHealthSnapshot, HealthAlertEvent } from "../src/types.js";

function snapshot(
  id: string,
  generatedAt: string,
  status: "operational" | "degraded" | "unavailable",
): CapabilityHealthSnapshot {
  return {
    id,
    generatedAt,
    capabilities: [{ capability: "all_traffic", status }],
    providers: [],
    geographies: status === "operational" ? [] : [{
      country: "US",
      city: "New York",
      status: "degraded",
      validatedAt: generatedAt,
      source: "passive",
    }],
  };
}

function coordinator(store: SqliteRouteStore, degradedDelayMs = 300_000): HealthAlertCoordinator {
  const notifier = new WebhookNotificationAdapter(store, [], {
    timeoutMs: 100,
    maxAttempts: 3,
    initialBackoffMs: 10,
  }, silentLogger);
  return new HealthAlertCoordinator(store, {
    configurationVersion: "ops-v1",
    destinationIds: [],
    degradedDelayMs,
    notifier,
  }, silentLogger);
}

test("alert episodes persist, delay degraded alerts, alert unavailable immediately, and recover", async (t) => {
  const store = new SqliteRouteStore(":memory:");
  t.after(() => store.close());
  const first = coordinator(store);
  await first.evaluate(snapshot("s1", "2026-07-15T00:00:00.000Z", "degraded"), {
    conflicting: false,
    staleCapabilities: [],
  });
  await first.evaluate(snapshot("s2", "2026-07-15T00:04:59.999Z", "degraded"), {
    conflicting: false,
    staleCapabilities: [],
  });
  assert.deepEqual(await store.healthAlertHistory(10), []);

  const restarted = coordinator(store);
  await restarted.evaluate(snapshot("s3", "2026-07-15T00:05:00.000Z", "degraded"), {
    conflicting: false,
    staleCapabilities: [],
  });
  await restarted.evaluate(snapshot("s4", "2026-07-15T00:05:01.000Z", "degraded"), {
    conflicting: false,
    staleCapabilities: [],
  });
  let events = await store.healthAlertHistory(10);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "alert");
  assert.equal(events[0]?.severity, "warning");
  assert.equal(events[0]?.configurationVersion, "ops-v1");
  assert.equal(events[0]?.geographies[0]?.city, "New York");

  await restarted.evaluate(snapshot("s5", "2026-07-15T00:06:00.000Z", "operational"), {
    conflicting: false,
    staleCapabilities: [],
  });
  events = await store.healthAlertHistory(10);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "recovery");
  assert.equal(events[0]?.status, "operational");
  assert.equal(events[0]?.previousStatus, "degraded");

  const unavailableStore = new SqliteRouteStore(":memory:");
  t.after(() => unavailableStore.close());
  await coordinator(unavailableStore).evaluate(snapshot("u1", "2026-07-15T00:00:00.000Z", "unavailable"), {
    conflicting: false,
    staleCapabilities: [],
  });
  assert.equal((await unavailableStore.healthAlertHistory(10))[0]?.severity, "critical");
});

test("webhook delivery is signed, retried, deduplicated, and tracked", async (t) => {
  const store = new SqliteRouteStore(":memory:");
  t.after(() => store.close());
  const secret = "a-long-webhook-secret";
  let now = Date.parse("2026-07-15T00:00:00.000Z");
  const requests: Array<{ body: string; headers: Record<string, string> }> = [];
  const request: typeof fetch = async (_input, init) => {
    requests.push({
      body: String(init?.body),
      headers: init?.headers as Record<string, string>,
    });
    return new Response("", { status: requests.length === 1 ? 500 : 204 });
  };
  const event: HealthAlertEvent = {
    id: "alert-1",
    dedupeKey: "all_traffic:alert:unavailable:episode-1",
    kind: "alert",
    capability: "all_traffic",
    status: "unavailable",
    severity: "critical",
    createdAt: new Date(now).toISOString(),
    snapshotId: "snapshot-1",
    configurationVersion: "ops-v1",
    geographies: [],
  };
  assert.equal(await store.createHealthAlertEvent(event, ["ops"]), true);
  assert.equal(await store.createHealthAlertEvent({ ...event, id: "duplicate" }, ["ops"]), false);
  const notifier = new WebhookNotificationAdapter(store, [{
    id: "ops",
    url: "https://alerts.example.test/health",
    secret,
  }], {
    timeoutMs: 100,
    maxAttempts: 3,
    initialBackoffMs: 100,
    now: () => now,
    fetch: request,
  }, silentLogger);
  await notifier.flush();
  assert.equal(requests.length, 1);
  assert.equal((await store.pendingHealthAlertDeliveries(new Date(now + 99).toISOString(), 10)).length, 0);
  now += 100;
  await notifier.flush();
  assert.equal(requests.length, 2);
  assert.equal((await store.pendingHealthAlertDeliveries(new Date(now).toISOString(), 10)).length, 0);
  const timestamp = requests[1]?.headers["x-profound-timestamp"] ?? "";
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${requests[1]?.body ?? ""}`)
    .digest("hex");
  assert.equal(requests[1]?.headers["x-profound-signature"], `sha256=${expected}`);
  assert.equal(requests[1]?.headers["x-profound-event-id"], "alert-1");
});

test("alert destination configuration is versioned and requires secure operator endpoints", () => {
  assert.deepEqual(parseHealthAlertDestinationConfig(undefined), {
    version: "unconfigured",
    destinations: [],
  });
  assert.equal(parseHealthAlertDestinationConfig(JSON.stringify({
    version: "2026-07-15",
    destinations: [{ id: "primary-ops", url: "https://alerts.example.test/hook", secret: "long-enough-secret" }],
  })).destinations[0]?.id, "primary-ops");
  assert.throws(() => parseHealthAlertDestinationConfig(JSON.stringify({
    version: "bad",
    destinations: [{ id: "ops", url: "http://alerts.example.test/hook", secret: "long-enough-secret" }],
  })), /must use HTTPS/);
});

test("capability health and recovery alert ownership remains with the service in v0", () => {
  assert.doesNotThrow(() => requireServiceOwnedCapabilityAlerts({}));
  assert.doesNotThrow(() => requireServiceOwnedCapabilityAlerts({ HEALTH_ALERT_RULE_OWNER: "service" }));
  assert.throws(
    () => requireServiceOwnedCapabilityAlerts({ HEALTH_ALERT_RULE_OWNER: "platform" }),
    /must remain service/,
  );
});
