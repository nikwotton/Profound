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
import { CooldownSyntheticValidator } from "../src/health-aggregator.js";
import { silentLogger, type Logger } from "../src/logger.js";
import { PublicCanaryServer } from "../src/public-canary.js";
import { startPublicCanaryService } from "../src/runtime-services.js";
import { SignedCanaryProbe } from "../src/signed-canary-probe.js";
import { v0TraceSampler } from "../src/telemetry.js";
import { createRoute, startTestApp } from "./helpers.js";

test("the current experimental observability default records every trace", () => {
  const result = v0TraceSampler.shouldSample();
  assert.equal(result.decision, SamplingDecision.RECORD_AND_SAMPLED);
});

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
