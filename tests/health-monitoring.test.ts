import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { AddressNotFoundError } from "@maxmind/geoip2-node";
import { create as createTar } from "tar";
import { signCanaryChallenge, verifyCanaryChallenge } from "../src/canary-challenge.js";
import { LocalGeoIpResolver, MaxMindGeoLiteUpdater, type GeoIpResolver } from "../src/geoip.js";
import {
  CapabilityHealthAggregator,
  CooldownSyntheticValidator,
  HealthAggregatorServer,
  passiveSignalsFromOtlpJson,
} from "../src/health-aggregator.js";
import { silentLogger, type Logger } from "../src/logger.js";
import type { ProviderAdapter } from "../src/providers/provider.js";
import { PublicCanaryServer } from "../src/public-canary.js";
import { startPublicCanaryService } from "../src/runtime-services.js";
import { SignedCanaryProbe } from "../src/signed-canary-probe.js";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";
import { StatusApplicationServer } from "../src/status-app.js";
import { v0TraceSampler } from "../src/telemetry.js";
import type { CapabilityHealthSnapshot, ProviderDescriptor, ProviderHealth, ProviderId, UpstreamEndpoint } from "../src/types.js";
import { createRoute, startTestApp } from "./helpers.js";

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

test("v0 trace sampling records every trace", () => {
  const result = v0TraceSampler.shouldSample();
  assert.equal(result.decision, SamplingDecision.RECORD_AND_SAMPLED);
});

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

test("signed canary challenges reject tampering and expiration", () => {
  const unsigned = { testId: "test-1", nonce: "nonce", expiresAt: new Date(61_000).toISOString() };
  const challenge = signCanaryChallenge("secret", unsigned);
  assert.equal(verifyCanaryChallenge("secret", challenge, 1_000), true);
  assert.equal(verifyCanaryChallenge("secret", { ...challenge, nonce: "changed" }, 1_000), false);
  assert.equal(verifyCanaryChallenge("secret", challenge, 62_000), false);
});

test("public canary validates signed challenges and returns observed egress evidence", async (t) => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  const server = new PublicCanaryServer(
    {
      host: "127.0.0.1",
      port: 0,
      signingSecret: "canary-secret",
      trustedProxyCidrs: [],
      requestsPerMinute: 10,
      now: () => now,
    },
    silentLogger,
  );
  const address = await server.start();
  t.after(() => server.stop());
  const testId = randomUUID();
  const challenge = signCanaryChallenge("canary-secret", {
    testId,
    nonce: "nonce",
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(challenge),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    observedIp: "127.0.0.1",
    geo: { status: "unavailable" },
    timestamp: "2026-07-15T00:00:00.000Z",
    correlationId: testId,
  });
  const replayed = await fetch(`http://127.0.0.1:${address.port}/v1/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(challenge),
  });
  assert.equal(replayed.status, 409);
  const rejected = await fetch(`http://127.0.0.1:${address.port}/v1/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...challenge, signature: "invalid" }),
  });
  assert.equal(rejected.status, 401);
});

test("public canary trusts forwarding headers only from configured load-balancer CIDRs", async (t) => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  const geoIp: GeoIpResolver = {
    lookup: (ip) => ({
      geo: {
        status: "available",
        countryCode: ip === "203.0.113.10" ? "US" : "MX",
        subdivisionCode: "NY",
        city: "New York",
        geonameId: 5_128_581,
        accuracyRadiusKm: 20,
      },
      geoDataset: {
        vendor: "MaxMind",
        edition: "GeoLite2-City",
        buildTimestamp: "2026-07-14T00:00:00.000Z",
      },
    }),
  };
  const start = async (trustedProxyCidrs: string[]) => {
    const server = new PublicCanaryServer(
      {
        host: "127.0.0.1",
        port: 0,
        signingSecret: "trusted-proxy-secret",
        trustedProxyCidrs,
        requestsPerMinute: 10,
        now: () => now,
      },
      silentLogger,
      geoIp,
    );
    const address = await server.start();
    t.after(() => server.stop());
    return address;
  };
  const challenge = (testId: string) =>
    signCanaryChallenge("trusted-proxy-secret", {
      testId,
      nonce: randomUUID(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });
  const request = async (port: number, testId: string) =>
    fetch(`http://127.0.0.1:${port}/v1/challenge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.99, 203.0.113.10",
      },
      body: JSON.stringify(challenge(testId)),
    });

  const trusted = await start(["127.0.0.0/8"]);
  const trustedBody = (await (await request(trusted.port, randomUUID())).json()) as Record<string, unknown>;
  assert.equal(trustedBody["observedIp"], "203.0.113.10");
  assert.deepEqual(trustedBody["geo"], {
    status: "available",
    countryCode: "US",
    subdivisionCode: "NY",
    city: "New York",
    geonameId: 5_128_581,
    accuracyRadiusKm: 20,
  });
  assert.deepEqual(trustedBody["geoDataset"], {
    vendor: "MaxMind",
    edition: "GeoLite2-City",
    buildTimestamp: "2026-07-14T00:00:00.000Z",
  });

  const untrusted = await start([]);
  const untrustedBody = (await (await request(untrusted.port, randomUUID())).json()) as Record<string, unknown>;
  assert.equal(untrustedBody["observedIp"], "127.0.0.1");
});

test("local GeoIP resolver activates versioned MaxMind evidence and marks weak data unverifiable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "profound-geoip-test-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const databasePath = join(directory, "active", "GeoLite2-City.mmdb");
  const candidatePath = join(directory, "candidate.mmdb");
  await writeFile(candidatePath, "test-mmdb");
  let accuracyRadius = 20;
  let missing = false;
  const openDatabase = async () => ({
    city: () => {
      if (missing) throw new AddressNotFoundError("not found");
      return {
        country: { isoCode: "US" },
        subdivisions: [{ isoCode: "NY" }],
        city: { names: { en: "New York" }, geonameId: 5_128_581 },
        location: { accuracyRadius },
      } as never;
    },
  });
  const resolver = new LocalGeoIpResolver(
    {
      databasePath,
      maximumAccuracyRadiusKm: 100,
      openDatabase,
    },
    silentLogger,
  );
  await resolver.activate(candidatePath, "2026-07-14T00:00:00.000Z");
  assert.equal(await readFile(databasePath, "utf8"), "test-mmdb");
  assert.deepEqual(resolver.lookup("203.0.113.10"), {
    geo: {
      status: "available",
      countryCode: "US",
      subdivisionCode: "NY",
      city: "New York",
      geonameId: 5_128_581,
      accuracyRadiusKm: 20,
    },
    geoDataset: {
      vendor: "MaxMind",
      edition: "GeoLite2-City",
      buildTimestamp: "2026-07-14T00:00:00.000Z",
    },
  });
  accuracyRadius = 101;
  assert.equal(resolver.lookup("203.0.113.10").geo.status, "unverifiable");
  missing = true;
  assert.equal(resolver.lookup("203.0.113.10").geo.status, "unverifiable");

  const reloaded = new LocalGeoIpResolver(
    {
      databasePath,
      maximumAccuracyRadiusKm: 100,
      openDatabase,
    },
    silentLogger,
  );
  assert.equal(await reloaded.load(), true);
  assert.equal(reloaded.dataset?.buildTimestamp, "2026-07-14T00:00:00.000Z");
});

test("MaxMind updater checks with HEAD, downloads MMDB, and skips the current build", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "profound-geoip-update-test-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const packageDirectory = join(directory, "GeoLite2-City_20260714");
  await mkdir(packageDirectory);
  await writeFile(join(packageDirectory, "GeoLite2-City.mmdb"), "downloaded-mmdb");
  const archivePath = join(directory, "GeoLite2-City.tar.gz");
  await createTar({ gzip: true, file: archivePath, cwd: directory }, ["GeoLite2-City_20260714"]);
  const archive = await readFile(archivePath);
  const calls: Array<{ method: string; authorization: string | null }> = [];
  const fetchImplementation: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    calls.push({ method, authorization: headers.get("authorization") });
    return method === "HEAD"
      ? new Response(null, { status: 200, headers: { "last-modified": "Tue, 14 Jul 2026 00:00:00 GMT" } })
      : new Response(archive, { status: 200 });
  };
  const resolver = new LocalGeoIpResolver(
    {
      databasePath: join(directory, "active", "GeoLite2-City.mmdb"),
      maximumAccuracyRadiusKm: 100,
      openDatabase: async () => ({ city: () => ({}) as never }),
    },
    silentLogger,
  );
  const updater = new MaxMindGeoLiteUpdater(
    resolver,
    {
      accountId: "account",
      licenseKey: "license",
      intervalMs: 302_400_000,
      fetchImplementation,
    },
    silentLogger,
  );
  assert.equal(await updater.refresh(), "activated");
  assert.equal(await updater.refresh(), "current");
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["HEAD", "GET", "HEAD"],
  );
  assert.ok(calls.every(({ authorization }) => authorization === `Basic ${Buffer.from("account:license").toString("base64")}`));
  assert.equal(await readFile(resolver.options.databasePath, "utf8"), "downloaded-mmdb");
});

test("public canary keeps access events on its security logger", async (t) => {
  const operationalMessages: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const securityMessages: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const collectingLogger = (messages: Array<{ message: string; context?: Record<string, unknown> }>): Logger => ({
    info: (message, context) => messages.push({ message, ...(context === undefined ? {} : { context }) }),
    warn: (message, context) => messages.push({ message, ...(context === undefined ? {} : { context }) }),
    error: (message, context) => messages.push({ message, ...(context === undefined ? {} : { context }) }),
  });
  const service = await startPublicCanaryService(
    collectingLogger(operationalMessages),
    {
      CANARY_HOST: "127.0.0.1",
      CANARY_PORT: "0",
      CANARY_SIGNING_SECRET: "security-log-secret",
    },
    collectingLogger(securityMessages),
  );
  t.after(() => service.stop());
  assert.deepEqual(
    operationalMessages.map(({ message }) => message),
    ["Public canary started"],
  );
  assert.equal(securityMessages.length, 0);

  const address = operationalMessages[0]?.context?.["address"] as { port?: unknown } | undefined;
  assert.equal(typeof address?.port, "number");
  const response = await fetch(`http://127.0.0.1:${String(address?.port)}/not-a-canary-route?secret=query-value`, {
    headers: {
      authorization: "Bearer header-secret",
      cookie: "session=cookie-secret",
      "user-agent": "safe-test-agent",
    },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(
    operationalMessages.map(({ message }) => message),
    ["Public canary started"],
  );
  assert.deepEqual(
    securityMessages.map(({ message }) => message),
    ["Canary request rejected"],
  );
  assert.equal(securityMessages[0]?.context?.["geoStatus"], "unavailable");
  assert.equal(securityMessages[0]?.context?.["derivedCountry"], "unknown");
  assert.equal(securityMessages[0]?.context?.["path"], "/not-a-canary-route");
  assert.equal(securityMessages[0]?.context?.["derivedAsn"], "unknown");
  assert.equal(securityMessages[0]?.context?.["userAgent"], "safe-test-agent");
  const encodedSecurityLog = JSON.stringify(securityMessages);
  for (const secret of ["query-value", "header-secret", "cookie-secret"]) {
    assert.ok(!encodedSecurityLog.includes(secret));
  }
});

test("synthetic validation coalesces concurrent requests and shares its cooldown", async () => {
  let now = 1_000;
  let calls = 0;
  const validator = new CooldownSyntheticValidator(
    async () => {
      calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { testId: `test-${calls}`, outcome: "success", checkedAt: new Date(now).toISOString() };
    },
    300_000,
    () => now,
  );
  const [first, second] = await Promise.all([validator.validate({}), validator.validate({ country: "US" })]);
  assert.equal(calls, 1);
  assert.equal(first.testId, second.testId);
  assert.equal((await validator.validate({ city: "New York" })).testId, first.testId);
  assert.equal(calls, 1);
  now += 300_001;
  assert.notEqual((await validator.validate({})).testId, first.testId);
  assert.equal(calls, 2);
});

test("signed synthetic probe uses the normal proxy path and a direct control on proxy failure", async (t) => {
  const canary = new PublicCanaryServer(
    {
      host: "127.0.0.1",
      port: 0,
      signingSecret: "probe-secret",
      trustedProxyCidrs: [],
      requestsPerMinute: 20,
    },
    silentLogger,
  );
  const canaryAddress = await canary.start();
  const app = await startTestApp([canaryAddress.port]);
  t.after(async () => Promise.all([canary.stop(), app.stop()]));
  const route = await createRoute(app.application, {
    name: "health-probe",
    targeting: { country: "US" },
    shouldRetry: false,
  });
  const proxy = new URL(route.proxyUrls.http);
  const proxyUrl = `${proxy.protocol}//${proxy.host}`;
  const probe = new SignedCanaryProbe({
    canaryUrl: `http://127.0.0.1:${canaryAddress.port}/v1/challenge`,
    signingSecret: "probe-secret",
    proxyUrl,
    proxyUsername: decodeURIComponent(proxy.username),
    proxyPassword: decodeURIComponent(proxy.password),
    timeoutMs: 1_000,
  });
  const successful = await probe.run({ country: "US" });
  assert.equal(successful.outcome, "success");
  assert.equal(successful.expectedCountry, "US");
  assert.equal(successful.country, undefined);
  assert.equal(successful.geoStatus, "unavailable");
  assert.equal(successful.geographyVerification, "unverifiable");
  const rejected = new SignedCanaryProbe({
    canaryUrl: `http://127.0.0.1:${canaryAddress.port}/v1/challenge`,
    signingSecret: "probe-secret",
    proxyUrl,
    proxyUsername: decodeURIComponent(proxy.username),
    proxyPassword: "wrong",
    timeoutMs: 1_000,
  });
  assert.equal((await rejected.run({ country: "US" })).outcome, "proxy_failure");
});

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
