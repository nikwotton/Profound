import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CapabilityHealthAggregator,
  CooldownSyntheticValidator,
  HealthAggregatorServer,
  passiveSignalsFromOtlpJson,
} from "../src/health-aggregator.js";
import { silentLogger } from "../src/logger.js";
import type { ProviderAdapter } from "../src/providers/provider.js";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";
import { StatusApplicationServer } from "../src/status-app.js";
import type { CapabilityHealthSnapshot, ProviderDescriptor, ProviderHealth, ProviderId, UpstreamEndpoint } from "../src/types.js";

function descriptor(id: ProviderId): ProviderDescriptor {
  return {
    id,
    providerClass: id === "bright_data" ? "residential" : "device_backed",
    capabilities: {
      clientProtocols: new Set(["http", "https", "socks5"]),
      upstreamProtocols: new Set(["http"]),
      geography: new Set(["country", "city"]),
      sessions: true,
      exactCity: "provider_guaranteed",
      assignmentControl: {
        providerManagedReassignment: "disabled",
        providerManagedRotation: "disabled",
      },
      rotation: new Set(["manual"]),
      targetPorts: "any_public",
      dnsResolution: { http: "provider_configurable", socks5: "provider_configurable" },
      destinationSafety: { http: "provider_trusted", socks5: "provider_trusted", providerNetworkScope: "external_public_only" },
      health: { source: "provider_api_or_probe" },
      capacity: {
        observation: "provider_api_or_evidence",
        hardLimit: "provider_signal_or_proxy_failure",
        provisioning: "unsupported",
      },
    },
    pricing: { source: "versioned_config", version: "test", model: "per_gib", amountUsd: 1 },
    usageDimensions: { common: ["bytes_sent", "bytes_received"], providerSpecific: [] },
    costRank: 1,
  };
}

class HealthProvider implements ProviderAdapter {
  readonly descriptor;

  constructor(
    id: ProviderId,
    private readonly current: ProviderHealth,
  ) {
    this.descriptor = descriptor(id);
  }

  async resolve(): Promise<UpstreamEndpoint> {
    throw new Error("not used");
  }

  rotate(): Promise<void> {
    return Promise.resolve();
  }

  async health(): Promise<ProviderHealth> {
    return this.current;
  }
}

test("synthetic GeoIP mismatch degrades expected geography without rewriting it as observed", async () => {
  const store = new InMemoryRouteStore();
  const checkedAt = "2026-07-15T00:00:00.000Z";
  const synthetic = new CooldownSyntheticValidator(
    async () => ({
      testId: "synthetic-geo-mismatch",
      outcome: "success",
      checkedAt,
      observedIp: "203.0.113.10",
      expectedCountry: "US",
      expectedCity: "New York",
      country: "CA",
      city: "Toronto",
      geoStatus: "available",
      geographyVerification: "mismatch",
      geoDataset: {
        vendor: "MaxMind",
        edition: "GeoLite2-City",
        buildTimestamp: checkedAt,
      },
      message: "Observed GeoIP evidence did not match the requested geography",
    }),
    300_000,
    () => Date.parse(checkedAt),
  );
  const aggregator = new CapabilityHealthAggregator(
    store,
    [
      new HealthProvider("bright_data", { provider: "bright_data", state: "healthy", checkedAt }),
      new HealthProvider("proxidize", { provider: "proxidize", state: "healthy", checkedAt }),
    ],
    {
      passiveValidationMaxAgeMs: 300_000,
      syntheticValidator: synthetic,
      now: () => Date.parse(checkedAt),
    },
    silentLogger,
  );
  const snapshot = await aggregator.refresh({
    forceSynthetic: true,
    scope: { country: "US", city: "New York" },
  });
  assert.equal(snapshot.capabilities.find(({ capability }) => capability === "health_verification")?.status, "degraded");
  assert.deepEqual(snapshot.geographies, [
    {
      country: "US",
      city: "New York",
      status: "degraded",
      validatedAt: checkedAt,
      source: "synthetic",
    },
  ]);
  await store.close();
});

test("capability aggregation keeps freshness separate and requires corroboration for unavailability", async () => {
  const store = new InMemoryRouteStore();
  const checkedAt = "2026-07-15T00:00:00.000Z";
  const synthetic = new CooldownSyntheticValidator(
    async () => ({
      testId: "synthetic-1",
      outcome: "proxy_failure",
      checkedAt,
      country: "US",
      city: "New York",
    }),
    300_000,
    () => Date.parse(checkedAt),
  );
  const aggregator = new CapabilityHealthAggregator(
    store,
    [
      new HealthProvider("bright_data", { provider: "bright_data", state: "healthy", checkedAt }),
      new HealthProvider("proxidize", { provider: "proxidize", state: "unhealthy", checkedAt }),
    ],
    {
      passiveValidationMaxAgeMs: 300_000,
      syntheticValidator: synthetic,
      now: () => Date.parse(checkedAt),
    },
    silentLogger,
  );
  aggregator.recordPassiveSignal({
    provider: "bright_data",
    capability: "stateless_traffic",
    outcome: "failure",
    observedAt: checkedAt,
    country: "US",
    city: "New York",
  });
  const snapshot = await aggregator.refresh({ forceSynthetic: true, scope: { country: "US", city: "New York" } });
  const statuses = Object.fromEntries(snapshot.capabilities.map((entry) => [entry.capability, entry.status]));
  assert.deepEqual(statuses, {
    all_traffic: "degraded",
    managed_sessions: "degraded",
    stateless_traffic: "degraded",
    health_verification: "operational",
  });
  assert.equal(snapshot.capabilities.find((entry) => entry.capability === "stateless_traffic")?.endToEndValidatedAt, checkedAt);
  assert.equal(snapshot.geographies[0]?.status, "degraded");
  assert.deepEqual(await store.latestCapabilityHealth(), snapshot);
  const restarted = new CapabilityHealthAggregator(
    store,
    [
      new HealthProvider("bright_data", { provider: "bright_data", state: "healthy", checkedAt }),
      new HealthProvider("proxidize", { provider: "proxidize", state: "unhealthy", checkedAt }),
    ],
    {
      passiveValidationMaxAgeMs: 300_000,
      now: () => Date.parse(checkedAt) + 600_000,
    },
    silentLogger,
  );
  const afterRestart = await restarted.refresh();
  assert.equal(afterRestart.capabilities.find((entry) => entry.capability === "stateless_traffic")?.endToEndValidatedAt, checkedAt);
  assert.equal(afterRestart.capabilities.find((entry) => entry.capability === "health_verification")?.status, "operational");
  assert.equal(afterRestart.geographies.length, 1);
  await store.close();
});

test("an inconclusive canary check cannot mark health verification unavailable", async () => {
  const store = new InMemoryRouteStore();
  const checkedAt = "2026-07-15T00:00:00.000Z";
  const aggregator = new CapabilityHealthAggregator(
    store,
    [
      new HealthProvider("bright_data", { provider: "bright_data", state: "healthy", checkedAt }),
      new HealthProvider("proxidize", { provider: "proxidize", state: "healthy", checkedAt }),
    ],
    {
      passiveValidationMaxAgeMs: 300_000,
      syntheticValidator: new CooldownSyntheticValidator(
        async () => ({ testId: "inconclusive", outcome: "inconclusive", checkedAt, message: "canary unavailable" }),
        300_000,
        () => Date.parse(checkedAt),
      ),
      now: () => Date.parse(checkedAt),
    },
    silentLogger,
  );
  try {
    const snapshot = await aggregator.refresh({ forceSynthetic: true });
    assert.equal(snapshot.capabilities.find(({ capability }) => capability === "health_verification")?.status, "degraded");
    assert.equal(
      snapshot.capabilities.some(({ status }) => status === "unavailable"),
      false,
    );
  } finally {
    await store.close();
  }
});

test("capability health follows preferred provider classes without penalizing a healthy preferred class", async () => {
  const checkedAt = "2026-07-15T00:00:00.000Z";
  const snapshotFor = async (
    brightDataState: ProviderHealth["state"],
    proxidizeState: ProviderHealth["state"],
  ): Promise<CapabilityHealthSnapshot> => {
    const store = new InMemoryRouteStore();
    try {
      const aggregator = new CapabilityHealthAggregator(
        store,
        [
          new HealthProvider("bright_data", {
            provider: "bright_data",
            state: brightDataState,
            checkedAt,
          }),
          new HealthProvider("proxidize", {
            provider: "proxidize",
            state: proxidizeState,
            checkedAt,
          }),
        ],
        {
          passiveValidationMaxAgeMs: 300_000,
          now: () => Date.parse(checkedAt),
        },
        silentLogger,
      );
      return await aggregator.refresh();
    } finally {
      await store.close();
    }
  };

  const devicePreferred = await snapshotFor("unhealthy", "healthy");
  assert.deepEqual(Object.fromEntries(devicePreferred.capabilities.slice(0, 3).map((entry) => [entry.capability, entry.status])), {
    all_traffic: "degraded",
    managed_sessions: "operational",
    stateless_traffic: "degraded",
  });

  const residentialPreferred = await snapshotFor("healthy", "unhealthy");
  assert.deepEqual(Object.fromEntries(residentialPreferred.capabilities.slice(0, 3).map((entry) => [entry.capability, entry.status])), {
    all_traffic: "degraded",
    managed_sessions: "degraded",
    stateless_traffic: "operational",
  });

  const unavailable = await snapshotFor("unhealthy", "unhealthy");
  assert.deepEqual(Object.fromEntries(unavailable.capabilities.slice(0, 3).map((entry) => [entry.capability, entry.status])), {
    all_traffic: "unavailable",
    managed_sessions: "unavailable",
    stateless_traffic: "unavailable",
  });
});

test("health aggregation alone classifies fresh capacity-pressure evidence as degraded capability state", async () => {
  const checkedAt = "2026-07-15T00:00:00.000Z";
  const store = new InMemoryRouteStore();
  try {
    await store.saveCapacityPressureEvidence({
      id: "capacity:proxidize:hour",
      provider: "proxidize",
      periodStartedAt: "2026-07-14T23:00:00.000Z",
      periodEndsAt: checkedAt,
      relatedRollupId: "rollup-1",
      capacityPolicyVersion: "capacity-v1",
      capacityConstraint: "slot_exhaustion",
      capacityDrivenFallbackCount: 2,
      capacityFailureCount: 0,
      capacityWaitMs: 500,
      concurrencyUtilization: 1.1,
      throughputUtilization: 0.8,
      observedAt: checkedAt,
    });
    const providers = [
      new HealthProvider("bright_data", { provider: "bright_data", state: "healthy", checkedAt }),
      new HealthProvider("proxidize", { provider: "proxidize", state: "healthy", checkedAt }),
    ];
    const aggregator = new CapabilityHealthAggregator(
      store,
      providers,
      {
        passiveValidationMaxAgeMs: 300_000,
        capacityPressureMaxAgeMs: 300_000,
        now: () => Date.parse(checkedAt),
      },
      silentLogger,
    );
    const pressured = await aggregator.refresh();
    assert.deepEqual(Object.fromEntries(pressured.capabilities.slice(0, 3).map((entry) => [entry.capability, entry.status])), {
      all_traffic: "degraded",
      managed_sessions: "degraded",
      stateless_traffic: "operational",
    });
    assert.equal(pressured.providers.find((provider) => provider.provider === "proxidize")?.state, "healthy");
    assert.match(
      pressured.capabilities.find((entry) => entry.capability === "managed_sessions")?.message ?? "",
      /capacity-pressure evidence/,
    );

    await store.saveCapacityPressureEvidence({
      id: "capacity:bright-data:hour",
      provider: "bright_data",
      periodStartedAt: "2026-07-14T23:00:00.000Z",
      periodEndsAt: checkedAt,
      relatedRollupId: "rollup-2",
      capacityPolicyVersion: "capacity-v1",
      capacityDrivenFallbackCount: 1,
      capacityFailureCount: 0,
      capacityWaitMs: 0,
      concurrencyUtilization: 0,
      throughputUtilization: 0,
      observedAt: checkedAt,
    });
    const bothClassesPressured = await aggregator.refresh();
    assert.equal(bothClassesPressured.capabilities.find((entry) => entry.capability === "stateless_traffic")?.status, "degraded");
    assert.equal(bothClassesPressured.providers.find((provider) => provider.provider === "bright_data")?.state, "healthy");

    const afterExpiry = new CapabilityHealthAggregator(
      store,
      providers,
      {
        passiveValidationMaxAgeMs: 300_000,
        capacityPressureMaxAgeMs: 300_000,
        now: () => Date.parse(checkedAt) + 300_001,
      },
      silentLogger,
    );
    const recovered = await afterExpiry.refresh();
    assert.equal(recovered.capabilities.find((entry) => entry.capability === "managed_sessions")?.status, "operational");
    assert.equal(recovered.capabilities.find((entry) => entry.capability === "all_traffic")?.status, "operational");
  } finally {
    await store.close();
  }
});

test("notification failures cannot prevent finalized health persistence", async (t) => {
  const store = new InMemoryRouteStore();
  t.after(() => store.close());
  const checkedAt = "2026-07-15T00:00:00.000Z";
  const aggregator = new CapabilityHealthAggregator(
    store,
    [new HealthProvider("bright_data", { provider: "bright_data", state: "healthy", checkedAt })],
    {
      passiveValidationMaxAgeMs: 300_000,
      now: () => Date.parse(checkedAt),
      alerting: {
        evaluate: async () => {
          throw new Error("notification unavailable");
        },
      },
    },
    silentLogger,
  );
  const result = await aggregator.refresh();
  assert.equal((await store.latestCapabilityHealth())?.id, result.id);
});

test("health aggregator accepts collector-filtered OTLP JSON passive outcomes", async (t) => {
  const checkedAt = "2026-07-15T00:00:00.000Z";
  const store = new InMemoryRouteStore();
  const aggregator = new CapabilityHealthAggregator(
    store,
    [
      new HealthProvider("bright_data", { provider: "bright_data", state: "healthy", checkedAt }),
      new HealthProvider("proxidize", { provider: "proxidize", state: "healthy", checkedAt }),
    ],
    {
      passiveValidationMaxAgeMs: 300_000,
      now: () => Date.parse(checkedAt),
    },
    silentLogger,
  );
  const server = new HealthAggregatorServer(
    aggregator,
    store,
    {
      host: "127.0.0.1",
      port: 0,
      token: "collector-token",
      refreshIntervalMs: 60_000,
    },
    silentLogger,
  );
  const address = await server.start();
  t.after(async () => {
    await server.stop();
    await store.close();
  });
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1784073600000000000",
                body: { stringValue: "profound.proxy.passive_health" },
                attributes: [
                  { key: "event.name", value: { stringValue: "profound.proxy.passive_health" } },
                  { key: "proxy.provider", value: { stringValue: "bright_data" } },
                  { key: "proxy.capability", value: { stringValue: "stateless_traffic" } },
                  { key: "proxy.outcome", value: { stringValue: "success" } },
                  { key: "proxy.observed_at", value: { stringValue: checkedAt } },
                  { key: "proxy.country", value: { stringValue: "US" } },
                  { key: "proxy.city", value: { stringValue: "New York" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(passiveSignalsFromOtlpJson(payload), [
    {
      provider: "bright_data",
      capability: "stateless_traffic",
      outcome: "success",
      observedAt: checkedAt,
      country: "US",
      city: "New York",
    },
  ]);
  const unauthorized = await fetch(`http://127.0.0.1:${address.port}/v1/passive-signals/otlp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(unauthorized.status, 401);
  const accepted = await fetch(`http://127.0.0.1:${address.port}/v1/passive-signals/otlp`, {
    method: "POST",
    headers: {
      authorization: "Bearer collector-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {});
  const snapshot = await store.latestCapabilityHealth();
  assert.equal(snapshot?.capabilities.find((entry) => entry.capability === "stateless_traffic")?.endToEndValidatedAt, checkedAt);
  assert.equal(snapshot?.geographies[0]?.source, "passive");
});

test("status application serves durable snapshots, history, and explicit staleness", async (t) => {
  const store = new InMemoryRouteStore();
  const snapshot: CapabilityHealthSnapshot = {
    id: "snapshot-1",
    generatedAt: "2026-07-15T00:00:00.000Z",
    capabilities: [{ capability: "all_traffic", status: "operational", providerStatusAt: "2026-07-15T00:00:00.000Z" }],
    providers: [],
    geographies: [],
  };
  await store.saveCapabilityHealth(snapshot);
  const server = new StatusApplicationServer(
    store,
    {
      host: "127.0.0.1",
      port: 0,
      staleAfterMs: 300_000,
      historyLimit: 10,
      now: () => Date.parse("2026-07-15T00:10:00.000Z"),
    },
    silentLogger,
  );
  const address = await server.start();
  t.after(async () => {
    await server.stop();
    await store.close();
  });
  const status = await fetch(`http://127.0.0.1:${address.port}/v1/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    snapshot,
    stale: true,
    ageMs: 600_000,
    capabilityFreshness: [
      {
        capability: "all_traffic",
        providerStatusStale: true,
        endToEndValidationStale: true,
      },
    ],
  });
  const history = await fetch(`http://127.0.0.1:${address.port}/v1/status/history?limit=1`);
  assert.deepEqual(await history.json(), { data: [snapshot] });
  const html = await (await fetch(`http://127.0.0.1:${address.port}/`)).text();
  assert.match(html, /All Traffic/);
  assert.match(html, /Status data is stale/);
});
