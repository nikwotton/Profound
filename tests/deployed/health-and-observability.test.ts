import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { signCanaryChallenge } from "../../src/canary-challenge.js";
import { axiomApl, createRoute, deployedEnvironment, deployedTest, requestViaHttpProxy, revokeRoute, waitFor } from "./helpers.js";

interface Capability {
  capability: string;
  status: string;
  providerStatusAt?: string;
  endToEndValidatedAt?: string;
}

interface HealthSnapshot {
  id: string;
  generatedAt: string;
  capabilities: Capability[];
  providers: Array<{ provider: string; state: string }>;
  geographies: unknown[];
}

async function fetchInternal(base: string, path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return fetch(new URL(path, `${base}/`), {
    ...init,
    headers,
  });
}

async function axiomDatasetText(dataset: string, startTime: number): Promise<string> {
  const result = await axiomApl(`["${dataset}"] | sort by _time desc | limit 2000`, startTime);
  return JSON.stringify(result);
}

deployedTest("deployed health aggregator and status application expose durable capability state and freshness", async () => {
  const environment = await deployedEnvironment();
  const token = environment.healthAggregatorToken;
  assert.ok(token, "DEPLOYED_HEALTH_AGGREGATOR_TOKEN is required for internal health checks");

  const aggregatorLive = await fetchInternal(environment.metadata.healthAggregator, "/health/live");
  assert.equal(aggregatorLive.status, 200, "run `pnpm sst tunnel --stage <stage>` so internal URLs are reachable");
  assert.equal((await fetchInternal(environment.metadata.healthAggregator, "/health/ready")).status, 200);
  assert.equal((await fetchInternal(environment.metadata.healthAggregator, "/v1/status")).status, 401);

  const aggregatorStatus = await fetchInternal(environment.metadata.healthAggregator, "/v1/status", token);
  assert.equal(aggregatorStatus.status, 200);
  const aggregatorBody = (await aggregatorStatus.json()) as { snapshot: HealthSnapshot };
  assert.ok(aggregatorBody.snapshot);
  assert.deepEqual(
    aggregatorBody.snapshot.capabilities.map(({ capability }) => capability),
    ["all_traffic", "authenticated_traffic", "unauthenticated_traffic", "health_verification"],
  );
  assert.ok(
    aggregatorBody.snapshot.capabilities.every(
      ({ status }) => status === "operational" || status === "degraded" || status === "unavailable",
    ),
  );
  assert.deepEqual(aggregatorBody.snapshot.providers.map(({ provider }) => provider).sort(), ["bright_data", "proxidize"]);

  const statusLive = await fetchInternal(environment.metadata.statusApplication, "/health/live");
  assert.equal(statusLive.status, 200);
  const status = await fetchInternal(environment.metadata.statusApplication, "/api/status");
  assert.equal(status.status, 200);
  const statusBody = (await status.json()) as {
    snapshot: HealthSnapshot;
    stale: boolean;
    ageMs: number;
    capabilityFreshness: Array<{ capability: string; providerStatusStale: boolean; endToEndValidationStale: boolean }>;
  };
  assert.equal(typeof statusBody.stale, "boolean");
  assert.equal(typeof statusBody.ageMs, "number");
  assert.equal(statusBody.capabilityFreshness.length, 4);

  const history = await fetchInternal(environment.metadata.statusApplication, "/api/status/history?limit=5");
  assert.equal(history.status, 200);
  assert.ok(((await history.json()) as { data: unknown[] }).data.length > 0);
  assert.equal((await fetchInternal(environment.metadata.statusApplication, "/api/status/geographies")).status, 200);

  const requestedValidation = await fetchInternal(environment.metadata.statusApplication, "/api/status/validate", undefined, {
    method: "POST",
  });
  assert.equal(requestedValidation.status, 200);
  assert.ok(((await requestedValidation.json()) as { snapshot: HealthSnapshot }).snapshot);

  const page = await fetchInternal(environment.metadata.statusApplication, "/");
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const label of ["All Traffic", "Authenticated Traffic", "Unauthenticated Traffic", "Health Verification"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /stale|current/);
});

deployedTest("deployed signed public canary works directly and through the normal proxy path without replay", async (t) => {
  const environment = await deployedEnvironment();
  const secret = environment.canarySigningSecret;
  assert.ok(secret, "DEPLOYED_CANARY_SIGNING_SECRET is required for canary integration checks");
  const route = await createRoute({
    name: `canary-path-${Date.now()}`,
    targeting: { country: "US" },
    isAuthenticated: false,
    shouldRetry: false,
  });
  t.after(() => revokeRoute(route.profile.id).catch(() => undefined));
  const challengeUrl = new URL("/v1/challenge", environment.metadata.publicCanary).toString();

  const direct = signCanaryChallenge(secret, {
    testId: randomUUID(),
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const directResponse = await fetch(challengeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.99" },
    body: JSON.stringify(direct),
  });
  assert.equal(directResponse.status, 200);
  const directBody = (await directResponse.json()) as {
    observedIp: string;
    timestamp: string;
    correlationId: string;
    geo: { status: string; accuracyRadiusKm?: number };
    geoDataset?: { vendor: string; edition: string; buildTimestamp: string };
  };
  assert.equal(directBody.correlationId, direct.testId);
  assert.notEqual(directBody.observedIp, "198.51.100.99");
  assert.ok(Number.isFinite(Date.parse(directBody.timestamp)));
  assert.ok(["available", "unverifiable", "unavailable"].includes(directBody.geo.status));
  assert.equal(directBody.geoDataset?.vendor, "MaxMind");
  assert.equal(directBody.geoDataset?.edition, "GeoLite2-City");
  assert.ok(Number.isFinite(Date.parse(directBody.geoDataset?.buildTimestamp ?? "")));
  assert.equal(
    (
      await fetch(challengeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(direct),
      })
    ).status,
    409,
  );

  const proxied = signCanaryChallenge(secret, {
    testId: randomUUID(),
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const proxiedResponse = await requestViaHttpProxy(route.proxyUrls.http, challengeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proxied),
  });
  assert.equal(proxiedResponse.status, 200);
  const proxiedBody = JSON.parse(proxiedResponse.body) as {
    observedIp: string;
    correlationId: string;
    geo: { status: string; countryCode?: string; city?: string; accuracyRadiusKm?: number };
    geoDataset?: { vendor: string; edition: string; buildTimestamp: string };
  };
  assert.equal(proxiedBody.correlationId, proxied.testId);
  assert.notEqual(proxiedBody.observedIp, "unknown");
  assert.ok(["available", "unverifiable"].includes(proxiedBody.geo.status));
  assert.equal(proxiedBody.geoDataset?.vendor, "MaxMind");
  assert.equal(proxiedBody.geoDataset?.edition, "GeoLite2-City");

  const tampered = { ...proxied, testId: randomUUID() };
  assert.equal(
    (
      await fetch(challengeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tampered),
      })
    ).status,
    401,
  );
});

deployedTest("deployed passive traffic reaches the health aggregator through the product telemetry collector", async (t) => {
  const environment = await deployedEnvironment();
  const token = environment.healthAggregatorToken;
  assert.ok(token, "DEPLOYED_HEALTH_AGGREGATOR_TOKEN is required for passive-health checks");
  assert.ok(environment.metadata.integrationTarget);
  const route = await createRoute({
    name: `passive-health-${Date.now()}`,
    targeting: { country: "US", city: "New York" },
    customerId: `passive-customer-${randomUUID()}`,
    isAuthenticated: false,
    shouldRetry: false,
  });
  t.after(() => revokeRoute(route.profile.id).catch(() => undefined));

  const beforeResponse = await fetchInternal(environment.metadata.healthAggregator, "/v1/status", token);
  const before = ((await beforeResponse.json()) as { snapshot: HealthSnapshot }).snapshot;
  const beforeValidation = before.capabilities.find(({ capability }) => capability === "unauthenticated_traffic")?.endToEndValidatedAt;

  const response = await requestViaHttpProxy(
    route.proxyUrls.http,
    new URL("/passive-health", environment.metadata.integrationTarget.url).toString(),
  );
  assert.equal(response.status, 200);

  const updated = await waitFor(
    "collector-fanned passive health",
    async () => {
      const result = await fetchInternal(environment.metadata.healthAggregator, "/v1/status", token);
      if (!result.ok) return undefined;
      const snapshot = ((await result.json()) as { snapshot: HealthSnapshot }).snapshot;
      const validation = snapshot.capabilities.find(({ capability }) => capability === "unauthenticated_traffic")?.endToEndValidatedAt;
      return validation !== undefined && validation !== beforeValidation ? snapshot : undefined;
    },
    { timeoutMs: 120_000, intervalMs: 2_000 },
  );
  assert.ok(updated.geographies.some((geography) => JSON.stringify(geography).includes("New York")));
});

deployedTest("deployed OTLP logs, metrics, traces, and canary security logs arrive in Axiom without sensitive payloads", async (t) => {
  const environment = await deployedEnvironment();
  assert.ok(environment.metadata.integrationTarget);
  const startedAt = Date.now() - 10_000;
  const customer = `otel-customer-${randomUUID()}`;
  const secretHeader = `header-secret-${randomUUID()}`;
  const secretCookie = `cookie-secret-${randomUUID()}`;
  const secretBody = `body-secret-${randomUUID()}`;
  const secretQuery = `query-secret-${randomUUID()}`;
  const route = await createRoute({
    name: `otel-${Date.now()}`,
    targeting: { country: "US" },
    customerId: customer,
    isAuthenticated: false,
    shouldRetry: false,
  });
  t.after(() => revokeRoute(route.profile.id).catch(() => undefined));
  const routeToken = decodeURIComponent(new URL(route.proxyUrls.http).password);
  const response = await requestViaHttpProxy(
    route.proxyUrls.http,
    new URL(`/otel?value=${secretQuery}`, environment.metadata.integrationTarget.url).toString(),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretHeader}`,
        cookie: `session=${secretCookie}`,
        "content-type": "text/plain",
      },
      body: secretBody,
    },
  );
  assert.equal(response.status, 200);

  const proxyLogs = await waitFor(
    "proxy OTLP logs in Axiom",
    async () => {
      const logs = await axiomDatasetText(environment.metadata.telemetry.datasets.logs, startedAt);
      return logs.includes(route.profile.id) && logs.includes(customer) ? logs : undefined;
    },
    { timeoutMs: 180_000, intervalMs: 5_000 },
  );
  for (const secret of [routeToken, secretHeader, secretCookie, secretBody, secretQuery, environment.controlToken]) {
    assert.ok(!proxyLogs.includes(secret), `proxy OTLP logs leaked ${secret}`);
  }
  assert.match(proxyLogs, /bytesSent|bytesReceived|bytes_sent|bytes_received/);
  assert.match(proxyLogs, /provider|candidate|assignment|outcome/);

  const securityMarker = `profound-security-${randomUUID()}`;
  const rejected = await fetch(new URL(`/missing-${randomUUID()}`, environment.metadata.publicCanary), {
    headers: { "user-agent": securityMarker },
  });
  assert.equal(rejected.status, 404);
  const securityLogs = await waitFor(
    "canary security OTLP logs in Axiom",
    async () => {
      const logs = await axiomDatasetText(environment.metadata.telemetry.datasets.logs, startedAt);
      return logs.includes(securityMarker) ? logs : undefined;
    },
    { timeoutMs: 180_000, intervalMs: 5_000 },
  );
  assert.match(securityLogs, /sourceIp|timestamp|method|path|userAgent|tokenValidation/);
  assert.match(securityLogs, /log\.category/);
  assert.match(securityLogs, /security/);

  const metricText = await waitFor(
    "OTLP metrics in Axiom",
    async () => {
      const text = await axiomDatasetText(environment.metadata.telemetry.datasets.metrics, startedAt);
      return text.includes("profound.proxy.requests") ? text : undefined;
    },
    { timeoutMs: 180_000, intervalMs: 10_000 },
  );
  for (const forbidden of ["route", "user", "peer", "device", "session", "ip"]) {
    assert.doesNotMatch(metricText, new RegExp(`proxy[._][^"]*${forbidden}`, "i"));
  }

  const spans = await waitFor(
    "OTLP spans in Axiom",
    async () => {
      const text = await axiomDatasetText(environment.metadata.telemetry.datasets.traces, startedAt);
      return text.includes(route.profile.id) ? text : undefined;
    },
    { timeoutMs: 180_000, intervalMs: 5_000 },
  );
  for (const secret of [routeToken, secretHeader, secretCookie, secretBody, secretQuery]) {
    assert.ok(!spans.includes(secret));
  }
});
