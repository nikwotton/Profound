import assert from "node:assert/strict";
import { test } from "node:test";
import { silentLogger } from "../src/logger.js";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";
import { StatusApplicationServer } from "../src/status-app.js";
import { CAPACITY_POLICY, recommendCapacity } from "../src/capacity-policy.js";
import { ROUTING_POLICY } from "../src/routing-policy.js";
import type { UsageRecord } from "../src/types.js";
import { provisionedProxySlotCapacityRecord, summarizeUsage, UsageAccountingWorker } from "../src/usage-accounting.js";

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
    latencyMs: 120,
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
  const store = new InMemoryRouteStore();
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
  assert.equal(rollup?.averageLatencyMs, 120);
  assert.equal(rollup?.p95LatencyMs, 120);
  assert.equal(rollup?.costStatus, "estimated");
});

test("device-priced slot cost is allocated by customer connection-seconds", () => {
  const capacity = provisionedProxySlotCapacityRecord({
    id: "slot-1-day",
    proxySlotId: "slot-1",
    periodStartedAt: "2026-07-15T10:00:00.000Z",
    periodEndsAt: "2026-07-15T11:00:00.000Z",
    priceUsd: 59,
    pricingVersion: "prox-2026-07",
  });
  const records = [
    record({
      id: "mobile-1",
      customerId: "customer-a",
      provider: "proxidize",
      pricingVersion: "prox-2026-07",
      pricingModel: "per_device_month",
      priceUsd: 59,
      proxySlotId: "slot-1",
      connectionStartedAt: "2026-07-15T10:00:00.000Z",
      connectionEndedAt: "2026-07-15T10:20:00.000Z",
    }),
    record({
      id: "mobile-2",
      logicalOperationId: "operation-2",
      customerId: "customer-b",
      provider: "proxidize",
      pricingVersion: "prox-2026-07",
      pricingModel: "per_device_month",
      priceUsd: 59,
      proxySlotId: "slot-1",
      connectionStartedAt: "2026-07-15T10:10:00.000Z",
      connectionEndedAt: "2026-07-15T10:30:00.000Z",
      completedAt: "2026-07-15T10:15:00.000Z",
    }),
    capacity,
  ];
  const rollups = summarizeUsage(records, {
    from: "2026-07-15T00:00:00.000Z",
    to: "2026-07-16T00:00:00.000Z",
    interval: "day",
    groupBy: "customer",
  });
  const customerA = rollups.find((rollup) => rollup.group.customer === "customer-a");
  const customerB = rollups.find((rollup) => rollup.group.customer === "customer-b");
  assert.equal(customerA?.activeConnectionMs, 20 * 60_000);
  assert.equal(customerB?.activeConnectionMs, 20 * 60_000);
  assert.equal(customerA?.estimatedCostUsd, customerB?.estimatedCostUsd);
  assert.equal(
    (customerA?.estimatedCostUsd ?? 0) + (customerB?.estimatedCostUsd ?? 0),
    summarizeUsage(records, {
      from: "2026-07-15T00:00:00.000Z",
      to: "2026-07-16T00:00:00.000Z",
      interval: "day",
    })[0]?.estimatedCostUsd,
  );
});

test("preallocated capacity reports time-weighted and current utilization with unhealthy capacity separated", () => {
  const allocated = record({
    id: "allocated",
    provider: "proxidize",
    pricingModel: "per_device_month",
    priceUsd: 59,
    proxySlotId: "slot-1",
    connectionStartedAt: "2026-07-15T10:00:00.000Z",
    connectionEndedAt: "2026-07-15T10:30:00.000Z",
  });
  const healthy = provisionedProxySlotCapacityRecord({
    id: "idle",
    proxySlotId: "slot-1",
    periodStartedAt: "2026-07-15T10:00:00.000Z",
    periodEndsAt: "2026-07-15T11:00:00.000Z",
    priceUsd: 59,
    pricingVersion: "prox-2026-07",
  });
  const unhealthy = provisionedProxySlotCapacityRecord({
    id: "unhealthy",
    proxySlotId: "slot-2",
    periodStartedAt: "2026-07-15T10:00:00.000Z",
    periodEndsAt: "2026-07-15T11:00:00.000Z",
    priceUsd: 59,
    pricingVersion: "prox-2026-07",
    health: "unhealthy",
  });
  const [rollup] = summarizeUsage([allocated, healthy, unhealthy], {
    from: "2026-07-15T10:00:00.000Z",
    to: "2026-07-15T11:00:00.000Z",
    interval: "hour",
  });
  assert.equal(rollup?.activeConnectionMs, 30 * 60_000);
  assert.equal(rollup?.provisionedSlotMs, 2 * 60 * 60_000);
  assert.equal(rollup?.healthyIdleSlotMs, 30 * 60_000);
  assert.equal(rollup?.unhealthySlotMs, 60 * 60_000);
  assert.equal(rollup?.slotOccupancy, 0.25);
  assert.equal(rollup?.currentSlotOccupancy, 0);
  assert.equal(rollup?.capacityPolicyVersion, CAPACITY_POLICY.version);
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

test("idle proxy-slot capacity is attributed to the synthetic Unallocated customer", () => {
  const capacity = provisionedProxySlotCapacityRecord({
    id: "slot-1-2026-07-15",
    proxySlotId: "slot-1",
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
  assert.equal(rollup?.activeConnectionMs, 0);
  assert.equal(rollup?.provisionedSlotMs, 60 * 60_000);
  assert.equal(rollup?.healthyIdleSlotMs, 60 * 60_000);
});

test("capacity recommendations use the versioned roadmap policy and suppress location-limited changes", () => {
  const recommendation = recommendCapacity(
    {
      provisionedSlots: 2,
      peakConcurrentConnections: 40,
      observedMbps: 10,
      prioritizedGbForecast: 70,
      monthlyPricePerSlotUsd: 59,
    },
    CAPACITY_POLICY,
    () => Date.parse("2026-07-17T00:00:00.000Z"),
  );
  assert.equal(recommendation.policyVersion, CAPACITY_POLICY.version);
  assert.equal(recommendation.recommendedSlots, 3);
  assert.equal(recommendation.slotDelta, 1);
  assert.equal(recommendation.estimatedMonthlyCostDeltaUsd, 59);
  assert.equal(
    recommendCapacity({
      provisionedSlots: 2,
      peakConcurrentConnections: 40,
      observedMbps: 10,
      prioritizedGbForecast: 70,
      limitingConstraint: "geography",
      monthlyPricePerSlotUsd: 59,
    }).slotDelta,
    0,
  );
});

test("accounting worker persists hourly, daily, and customer rollups", async () => {
  const store = new InMemoryRouteStore();
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
  const store = new InMemoryRouteStore();
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
    const [alert] = await store.listUsageAlertEvents("2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z");
    assert.equal(alert?.kind, "reconciliation_variance");
    assert.equal(alert?.severity, "warning");
    assert.equal(alert?.relatedRecordId, reconciliation?.id);
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
          `http://127.0.0.1:${address.port}/v1/usage?from=2026-07-15T00:00:00.000Z&to=2026-07-16T00:00:00.000Z&interval=day&groupBy=customer`,
        )
      ).json()) as { data: Array<{ group: { customer?: string }; costStatus: string }> };
      assert.equal(usage.data.find((rollup) => rollup.group.customer === "Unallocated")?.costStatus, "reconciled");
      const evidence = (await (
        await fetch(`http://127.0.0.1:${address.port}/v1/usage/reconciliations?from=2026-07-15T00:00:00.000Z&to=2026-07-16T00:00:00.000Z`)
      ).json()) as { data: Array<{ varianceAttribution: string }> };
      assert.equal(evidence.data[0]?.varianceAttribution, "Unallocated");
      const alerts = (await (
        await fetch(`http://127.0.0.1:${address.port}/v1/usage/events?from=2026-07-15T00:00:00.000Z&to=2026-07-16T00:00:00.000Z`)
      ).json()) as { data: Array<{ kind: string }> };
      assert.equal(alerts.data[0]?.kind, "reconciliation_variance");
    } finally {
      await dashboard.stop();
    }
  } finally {
    await store.close();
  }
});

test("capacity pressure publishes provider-attributed health evidence and one idempotent planning recommendation per period", async () => {
  const store = new InMemoryRouteStore();
  const from = "2026-07-15T10:00:00.000Z";
  const to = "2026-07-15T12:00:00.000Z";
  try {
    await store.recordUsage(
      provisionedProxySlotCapacityRecord({
        id: "pressure-slot",
        proxySlotId: "slot-pressure",
        periodStartedAt: from,
        periodEndsAt: "2026-07-15T11:00:00.000Z",
        priceUsd: 59,
        pricingVersion: "prox-2026-07",
      }),
    );
    for (let index = 0; index < 17; index += 1) {
      await store.recordUsage(
        record({
          id: `pressure-${index}`,
          logicalOperationId: `pressure-operation-${index}`,
          provider: "proxidize",
          proxySlotId: "slot-pressure",
          connectionStartedAt: "2026-07-15T10:00:00.000Z",
          connectionEndedAt: "2026-07-15T11:00:00.000Z",
          completedAt: `2026-07-15T10:${String(index).padStart(2, "0")}:00.000Z`,
          capacityPressure: true,
          capacityPolicyVersion: CAPACITY_POLICY.version,
        }),
      );
    }
    await store.recordUsage(
      record({
        id: "residential-pressure-fallback",
        logicalOperationId: "residential-pressure-fallback-operation",
        provider: "proxidize",
        proxySlotId: "slot-pressure",
        failover: true,
        capacityPressure: true,
        capacityPressureProvider: "bright_data",
        connectionStartedAt: "2026-07-15T10:30:00.000Z",
        connectionEndedAt: "2026-07-15T10:31:00.000Z",
        completedAt: "2026-07-15T10:31:00.000Z",
        capacityPolicyVersion: CAPACITY_POLICY.version,
      }),
    );
    const worker = new UsageAccountingWorker(store);
    await worker.run(from, to);
    const first = await store.listUsageAlertEvents(from, to);
    assert.ok(first.some((event) => event.kind === "capacity_recommendation" && event.provider === "proxidize"));
    assert.ok(first.some((event) => event.kind === "capacity_recommendation" && event.provider === "bright_data"));
    const firstEvidence = await store.listCapacityPressureEvidence("2000-01-01T00:00:00.000Z");
    assert.ok(
      firstEvidence.some(
        (evidence) =>
          evidence.provider === "proxidize" &&
          (evidence.capacityDrivenFallbackCount > 0 || evidence.concurrencyUtilization > 1 || evidence.throughputUtilization > 1),
      ),
    );
    assert.ok(firstEvidence.some((evidence) => evidence.provider === "bright_data" && evidence.capacityDrivenFallbackCount > 0));
    await worker.run(from, to);
    assert.equal((await store.listUsageAlertEvents(from, to)).length, first.length);
    assert.equal((await store.listCapacityPressureEvidence("2000-01-01T00:00:00.000Z")).length, firstEvidence.length);
  } finally {
    await store.close();
  }
});

test("variance thresholds enforce the absolute floor, 5% warning, 15% error, and repeated-warning escalation", async () => {
  const store = new InMemoryRouteStore();
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

test("company-facing dashboard supports usage filters and provider-neutral credential and session lifecycle views", async (t) => {
  const store = new InMemoryRouteStore();
  await store.create("overridden-profile", {
    name: "overridden-profile",
    customerId: "customer-override",
    providerOverride: "bright_data",
    allowConnectionRetry: false,
    userId: "user-override",
    allowedProtocols: ["http", "https", "socks5"],
    targeting: { country: "US" },
    rotation: { mode: "per_request" },
    shouldRetry: false,
    retryPolicy: { maxAttempts: 1 },
  });
  await store.createAccessGrant(
    "dashboard-grant",
    "overridden-profile",
    "dashboard-principal",
    "dashboard-managed-credential",
    "dashboard-token",
    "managed",
    "dashboard-session",
    "dashboard-job",
  );
  await store.addAccessGrantCredential("dashboard-grant", "dashboard-stateless-credential", "dashboard-stateless-token", "stateless");
  const sessionTimestamp = "2026-07-15T11:00:00.000Z";
  await store.createLogicalSession({
    id: "dashboard-session",
    grantId: "dashboard-grant",
    routeId: "overridden-profile",
    status: "open",
    terminateActive: false,
    bindingVersion: 0,
    createdAt: sessionTimestamp,
    updatedAt: sessionTimestamp,
  });
  await store.recordCapacityCircuitFailure("bright_data", "bright_data", "provider_hard_limit", "2026-07-15T11:59:30.000Z");
  await store.recordUsage(
    record({
      provider: "proxidize",
      jobId: "dashboard-job",
      sessionMode: "stateless",
      destinationDomain: "example.com",
      destinationHost: "api.example.com",
      destinationPort: 443,
      destinationPathTemplate: "/items/:id",
      proxySlotId: "slot-a",
      routingPolicyVersion: ROUTING_POLICY.version,
      routingScore: 72.5,
      routingScoreComponents: { reliability: 0.8, headroom: 0.75, performance: 0.7, costEfficiency: 0.5, stability: 0.9 },
    }),
  );
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
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/usage?preset=day&interval=hour&groupBy=provider&provider=proxidize`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ group: { provider: string }; requestCount: number }> };
  assert.equal(body.data[0]?.group.provider, "proxidize");
  assert.equal(body.data[0]?.requestCount, 1);
  const sessions = (await (
    await fetch(`http://127.0.0.1:${address.port}/v1/usage?preset=day&interval=hour&groupBy=session_mode&sessionMode=stateless`)
  ).json()) as { data: Array<{ group: { session_mode: string }; requestCount: number }> };
  assert.equal(sessions.data[0]?.group.session_mode, "stateless");
  assert.equal(sessions.data[0]?.requestCount, 1);
  const jobs = (await (
    await fetch(`http://127.0.0.1:${address.port}/v1/usage?preset=day&interval=hour&groupBy=job&jobId=dashboard-job`)
  ).json()) as { data: Array<{ group: { job: string }; requestCount: number }> };
  assert.equal(jobs.data[0]?.group.job, "dashboard-job");
  assert.equal(jobs.data[0]?.requestCount, 1);
  const destinations = (await (
    await fetch(
      `http://127.0.0.1:${address.port}/v1/usage?preset=day&interval=hour&groupBy=destination_host&destinationDomain=example.com&destinationHost=api.example.com&destinationPathTemplate=%2Fitems%2F%3Aid`,
    )
  ).json()) as { data: Array<{ group: { destination_host: string }; requestCount: number }> };
  assert.equal(destinations.data[0]?.group.destination_host, "api.example.com");
  assert.equal(destinations.data[0]?.requestCount, 1);
  const mixedTimeRange = await fetch(`http://127.0.0.1:${address.port}/v1/usage?preset=day&from=2026-07-14T00%3A00%3A00.000Z`);
  assert.equal(mixedTimeRange.status, 400);
  assert.deepEqual(await mixedTimeRange.json(), { error: "invalid_usage_time_range" });
  const irrelevantParameter = await fetch(`http://127.0.0.1:${address.port}/v1/usage/reconciliations?groupBy=provider`);
  assert.equal(irrelevantParameter.status, 400);
  assert.deepEqual(await irrelevantParameter.json(), { error: "invalid_usage_query_parameter" });
  const capacity = (await (await fetch(`http://127.0.0.1:${address.port}/v1/capacity`)).json()) as {
    routingPolicy: { version: string };
    recentCandidateScores: Array<{ routingScore: number; routingScoreComponents: { headroom: number } }>;
    capacityCircuits: Array<{ provider: string; status: string; reason: string }>;
  };
  assert.equal(capacity.routingPolicy.version, ROUTING_POLICY.version);
  assert.equal(capacity.recentCandidateScores[0]?.routingScore, 72.5);
  assert.equal(capacity.recentCandidateScores[0]?.routingScoreComponents.headroom, 0.75);
  assert.deepEqual(capacity.capacityCircuits[0], {
    provider: "bright_data",
    candidateKey: "bright_data",
    status: "open",
    consecutiveFailures: 1,
    openCount: 1,
    reason: "provider_hard_limit",
    cooldownUntil: "2026-07-15T12:00:30.000Z",
    updatedAt: "2026-07-15T11:59:30.000Z",
    expiresAt: "2026-07-16T11:59:30.000Z",
  });
  const html = await (await fetch(`http://127.0.0.1:${address.port}/`)).text();
  assert.match(html, /Proxy routing dashboard/);
  assert.match(html, /Usage and cost/);
  assert.match(html, /overridden-profile/);
  assert.match(html, /bright_data/);
  assert.match(html, /provider_hard_limit/);
  assert.match(html, /Credential and session lifecycle/);
  assert.match(html, /dashboard-managed-credential/);
  assert.match(html, /dashboard-stateless-credential/);
  assert.match(html, /dashboard-session/);
  assert.doesNotMatch(html, /dashboard-token|dashboard-stateless-token/);
});
