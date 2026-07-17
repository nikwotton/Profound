import assert from "node:assert/strict";
import { test } from "node:test";
import { silentLogger } from "../src/logger.js";
import { SqliteRouteStore } from "../src/store.js";
import { StatusApplicationServer } from "../src/status-app.js";
import type { UsageRecord } from "../src/types.js";
import { summarizeUsage, unallocatedDeviceCapacityRecord, UsageAccountingWorker } from "../src/usage-accounting.js";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    kind: "attempt",
    id: "attempt-1",
    logicalOperationId: "operation-1",
    accessGrantId: "grant-1",
    routeId: "route-1",
    userId: "user-1",
    customerId: "customer-1",
    provider: "bright_data",
    protocol: "https",
    outcome: "success",
    retryIndex: 0,
    failover: false,
    bytesSent: 256 * 1024 ** 2,
    bytesReceived: 768 * 1024 ** 2,
    country: "US",
    city: "New York",
    pricingVersion: "bright-2026-07",
    pricingModel: "per_gib",
    priceUsd: 8,
    startedAt: "2026-07-15T10:00:00.000Z",
    completedAt: "2026-07-15T10:01:00.000Z",
    ...overrides,
  };
}

test("usage records are immutable and idempotent", async () => {
  const store = new SqliteRouteStore(":memory:");
  try {
    assert.equal(await store.recordUsage(record()), true);
    assert.equal(await store.recordUsage(record({ bytesReceived: 0 })), false);
    const stored = await store.listUsageRecords("2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.bytesReceived, 768 * 1024 ** 2);
  } finally {
    await store.close();
  }
});

test("usage-priced traffic is estimated from billable bytes and historical price", () => {
  const [rollup] = summarizeUsage([record()], {
    from: "2026-07-15T00:00:00.000Z",
    to: "2026-07-16T00:00:00.000Z",
    interval: "day",
  });
  assert.equal(rollup?.requestCount, 1);
  assert.equal(rollup?.bytesSent + (rollup?.bytesReceived ?? 0), 1024 ** 3);
  assert.equal(rollup?.estimatedCostUsd, 8);
  assert.equal(rollup?.costStatus, "estimated");
});

test("device-priced traffic unions overlapping leases including idle time", () => {
  const records = [
    record({
      id: "mobile-1",
      provider: "proxidize",
      pricingVersion: "prox-2026-07",
      pricingModel: "per_device_month",
      priceUsd: 59,
      deviceLeaseKey: "device-1",
      leaseWindowStartedAt: "2026-07-15T10:00:00.000Z",
      leaseWindowEndsAt: "2026-07-15T10:20:00.000Z",
    }),
    record({
      id: "mobile-2",
      logicalOperationId: "operation-2",
      provider: "proxidize",
      pricingVersion: "prox-2026-07",
      pricingModel: "per_device_month",
      priceUsd: 59,
      deviceLeaseKey: "device-1",
      leaseWindowStartedAt: "2026-07-15T10:10:00.000Z",
      leaseWindowEndsAt: "2026-07-15T10:30:00.000Z",
      completedAt: "2026-07-15T10:15:00.000Z",
    }),
  ];
  const [rollup] = summarizeUsage(records, {
    from: "2026-07-15T00:00:00.000Z",
    to: "2026-07-16T00:00:00.000Z",
    interval: "day",
  });
  assert.equal(rollup?.deviceLeaseMs, 30 * 60_000);
  assert.ok((rollup?.estimatedCostUsd ?? 0) > 0);
});

test("preallocated capacity reports time-weighted and current utilization with unhealthy capacity separated", () => {
  const allocated = record({
    id: "allocated",
    provider: "proxidize",
    pricingModel: "per_device_month",
    priceUsd: 59,
    deviceLeaseKey: "device-1",
    leaseWindowStartedAt: "2026-07-15T10:00:00.000Z",
    leaseWindowEndsAt: "2026-07-15T10:30:00.000Z",
  });
  const healthyIdle = unallocatedDeviceCapacityRecord({
    id: "idle",
    endpointId: "device-1",
    periodStartedAt: "2026-07-15T10:30:00.000Z",
    periodEndsAt: "2026-07-15T10:45:00.000Z",
    priceUsd: 59,
    pricingVersion: "prox-2026-07",
  });
  const unhealthy = unallocatedDeviceCapacityRecord({
    id: "unhealthy",
    endpointId: "device-1",
    periodStartedAt: "2026-07-15T10:45:00.000Z",
    periodEndsAt: "2026-07-15T11:00:00.000Z",
    priceUsd: 59,
    pricingVersion: "prox-2026-07",
    health: "unhealthy",
  });
  const [rollup] = summarizeUsage([allocated, healthyIdle, unhealthy], {
    from: "2026-07-15T10:00:00.000Z",
    to: "2026-07-15T11:00:00.000Z",
    interval: "hour",
  });
  assert.equal(rollup?.deviceLeaseMs, 30 * 60_000);
  assert.equal(rollup?.provisionedDeviceMs, 60 * 60_000);
  assert.equal(rollup?.healthyIdleDeviceMs, 15 * 60_000);
  assert.equal(rollup?.unhealthyDeviceMs, 15 * 60_000);
  assert.equal(rollup?.allocationUtilization, 0.5);
  assert.equal(rollup?.currentAllocationUtilization, 0);
});

test("provider totals reconcile authoritative spend while grouped attribution stays estimated", () => {
  const query = { from: "2026-07-15T00:00:00.000Z", to: "2026-07-16T00:00:00.000Z", interval: "day" as const };
  const total = {
    provider: "bright_data" as const,
    periodStartedAt: query.from,
    periodEndsAt: query.to,
    amountUsd: 7.5,
    sourceVersion: "invoice-42",
  };
  const [rollup] = summarizeUsage([record()], query, [total]);
  assert.equal(rollup?.providerSpendUsd, 7.5);
  assert.equal(rollup?.attributedCostUsd, 7.5);
  assert.equal(rollup?.costStatus, "reconciled");
});

test("unassigned device capacity is attributed to the synthetic Unallocated customer", () => {
  const capacity = unallocatedDeviceCapacityRecord({
    id: "device-1-2026-07-15",
    endpointId: "device-1",
    periodStartedAt: "2026-07-15T00:00:00.000Z",
    periodEndsAt: "2026-07-15T01:00:00.000Z",
    priceUsd: 59,
    pricingVersion: "prox-2026-07",
  });
  const [rollup] = summarizeUsage([capacity], {
    from: "2026-07-15T00:00:00.000Z",
    to: "2026-07-16T00:00:00.000Z",
    interval: "day",
    groupBy: "customer",
  });
  assert.equal(rollup?.group.customer, "Unallocated");
  assert.equal(rollup?.requestCount, 0);
  assert.equal(rollup?.deviceLeaseMs, 0);
  assert.equal(rollup?.provisionedDeviceMs, 60 * 60_000);
  assert.equal(rollup?.healthyIdleDeviceMs, 60 * 60_000);
});

test("accounting worker persists hourly, daily, and customer rollups", async () => {
  const store = new SqliteRouteStore(":memory:");
  try {
    await store.recordUsage(record());
    const worker = new UsageAccountingWorker(store);
    assert.equal(await worker.run("2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z"), 4);
    assert.equal((await store.listUsageRollups("2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z", "hour")).length, 2);
    assert.equal((await store.listUsageRollups("2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z", "day")).length, 2);
  } finally {
    await store.close();
  }
});

test("reconciliation persists variance evidence and posts unexplained differences to Unallocated", async () => {
  const store = new SqliteRouteStore(":memory:");
  try {
    await store.recordUsage(record());
    const worker = new UsageAccountingWorker(store, () => [
      {
        provider: "bright_data",
        periodStartedAt: "2026-07-15T00:00:00.000Z",
        periodEndsAt: "2026-07-16T00:00:00.000Z",
        amountUsd: 9,
        sourceVersion: "provider-total-1",
      },
    ]);
    await worker.run("2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z");
    const [reconciliation] = await store.listUsageReconciliations("2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z");
    assert.equal(reconciliation?.estimatedTotalUsd, 8);
    assert.equal(reconciliation?.reportedTotalUsd, 9);
    assert.equal(reconciliation?.varianceUsd, 1);
    assert.equal(reconciliation?.varianceAttribution, "Unallocated");
    assert.equal(reconciliation?.severity, "warning");
    const daily = await store.listUsageRollups("2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z", "day");
    const customer = daily.find((rollup) => rollup.group.customer === "customer-1");
    const unallocated = daily.find((rollup) => rollup.group.customer === "Unallocated");
    assert.equal(customer?.attributedCostUsd, 8);
    assert.equal(customer?.costStatus, "reconciled");
    assert.equal(unallocated?.attributedCostUsd, 1);

    const dashboard = new StatusApplicationServer(
      store,
      {
        host: "127.0.0.1",
        port: 0,
        staleAfterMs: 300_000,
        historyLimit: 10,
        now: () => Date.parse("2026-07-16T00:00:00.000Z"),
      },
      silentLogger,
    );
    const address = await dashboard.start();
    try {
      const usage = (await (
        await fetch(
          `http://127.0.0.1:${address.port}/api/usage?from=2026-07-15T00:00:00.000Z&to=2026-07-16T00:00:00.000Z&interval=day&groupBy=customer`,
        )
      ).json()) as { data: Array<{ group: { customer?: string }; costStatus: string }> };
      assert.equal(usage.data.find((rollup) => rollup.group.customer === "Unallocated")?.costStatus, "reconciled");
      const evidence = (await (
        await fetch(`http://127.0.0.1:${address.port}/api/usage/reconciliations?from=2026-07-15T00:00:00.000Z&to=2026-07-16T00:00:00.000Z`)
      ).json()) as { data: Array<{ varianceAttribution: string }> };
      assert.equal(evidence.data[0]?.varianceAttribution, "Unallocated");
    } finally {
      await dashboard.stop();
    }
  } finally {
    await store.close();
  }
});

test("variance thresholds enforce the absolute floor, 5% warning, 15% error, and repeated-warning escalation", async () => {
  const store = new SqliteRouteStore(":memory:");
  const periodStartedAt = "2026-07-15T00:00:00.000Z";
  const periodEndsAt = "2026-07-16T00:00:00.000Z";
  try {
    await store.recordUsage(record());
    const reconcile = async (amountUsd: number, sourceVersion: string): Promise<void> => {
      await new UsageAccountingWorker(store, () => [
        { provider: "bright_data", periodStartedAt, periodEndsAt, amountUsd, sourceVersion },
      ]).run(periodStartedAt, periodEndsAt);
    };
    await reconcile(8.8, "below-floor");
    await reconcile(9, "warning");
    await reconcile(9, "repeated-warning");
    await reconcile(9.6, "above-error-threshold");
    const evidence = await store.listUsageReconciliations(periodStartedAt, periodEndsAt);
    const severity = (sourceVersion: string) => evidence.find((entry) => entry.sourceVersion === sourceVersion)?.severity;
    assert.equal(severity("below-floor"), "normal");
    assert.equal(severity("warning"), "warning");
    assert.equal(severity("repeated-warning"), "error");
    assert.equal(severity("above-error-threshold"), "error");
  } finally {
    await store.close();
  }
});

test("internal dashboard usage API supports time presets, grouping, and filters", async (t) => {
  const store = new SqliteRouteStore(":memory:");
  await store.recordUsage(record());
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  const server = new StatusApplicationServer(
    store,
    { host: "127.0.0.1", port: 0, staleAfterMs: 300_000, historyLimit: 10, now: () => now },
    silentLogger,
  );
  const address = await server.start();
  t.after(async () => {
    await server.stop();
    await store.close();
  });
  const response = await fetch(`http://127.0.0.1:${address.port}/api/usage?preset=day&interval=hour&groupBy=provider&provider=bright_data`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ group: { provider: string }; requestCount: number }> };
  assert.equal(body.data[0]?.group.provider, "bright_data");
  assert.equal(body.data[0]?.requestCount, 1);
  const html = await (await fetch(`http://127.0.0.1:${address.port}/`)).text();
  assert.match(html, /Proxy routing dashboard/);
  assert.match(html, /Usage and cost/);
});
