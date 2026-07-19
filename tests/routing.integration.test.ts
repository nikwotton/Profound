import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { basicAuth } from "../src/net-utils.js";
import { expectBufferChunk, expectRecord, parseJson } from "../src/decoding.js";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";
import {
  createRoute,
  exchangeViaHttpConnect,
  exchangeViaSocks5,
  recentWallClockRange,
  requestViaProxy,
  startEchoTarget,
  startHttpTarget,
  startTestApp,
} from "./helpers.js";

test("stateless profiles use fresh residential exits per request", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });

  const rotating = await createRoute(testApp.application, {
    name: "rotating",
    targeting: { country: "US" },
  });
  const first = await requestViaProxy(rotating.proxyUrls.http, target.url);
  const second = await requestViaProxy(rotating.proxyUrls.http, target.url);
  assert.equal(first.status, 200);
  assert.equal(expectRecord(parseJson(first.body, "target response"), "target response")["body"], "target-response");
  assert.notEqual(first.headers["x-mock-exit-ip"], second.headers["x-mock-exit-ip"]);
});

test("plain HTTP preserves method, path, headers, and streamed body", async (t) => {
  const target = await startHttpTarget();
  const testApp = await startTestApp([target.port]);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "http-transparency",
    targeting: { country: "US" },
    shouldRetry: false,
  });
  const response = await requestViaProxy(route.proxyUrls.http, target.url, {
    method: "POST",
    headers: { authorization: "Bearer target-token", "content-type": "text/plain" },
    body: "streamed-request-body",
  });
  assert.equal(response.status, 200);
  const received = JSON.parse(response.body) as Record<string, string>;
  assert.equal(received["method"], "POST");
  assert.equal(received["path"], "/resource?secret=query-value");
  assert.equal(received["authorization"], "Bearer target-token");
  assert.equal(received["requestBody"], "streamed-request-body");
});

test("plain HTTP forwards request chunks before the caller completes the body", async (t) => {
  let observeFirstChunk!: () => void;
  const firstChunkSeen = new Promise<void>((resolve) => {
    observeFirstChunk = resolve;
  });
  const target = await startHttpTarget({ onChunk: observeFirstChunk });
  const testApp = await startTestApp([target.port], undefined, undefined, { STREAM_BUFFER_BYTES: "1024" });
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, { targeting: { country: "US" } });
  const proxy = new URL(route.proxyUrls.http);
  const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const proxyRequest = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "POST",
        path: target.url,
        headers: {
          "proxy-authorization": basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password)),
          "content-type": "text/plain",
        },
      },
      (proxyResponse) => {
        const chunks: Buffer[] = [];
        proxyResponse.on("data", (chunk) => chunks.push(expectBufferChunk(chunk)));
        proxyResponse.on("end", () => resolve({ status: proxyResponse.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    proxyRequest.on("error", reject);
    proxyRequest.write("first-");
    void firstChunkSeen.then(() => proxyRequest.end("second"), reject);
  });
  const response = await result;
  assert.equal(response.status, 200);
  assert.equal((JSON.parse(response.body) as Record<string, string>)["requestBody"], "first-second");
});

test("plain HTTP streams bodies larger than the bounded transport buffer without application caps", async (t) => {
  const payload = "streaming-body-".repeat(20_000);
  const target = await startHttpTarget({ responseBody: payload });
  const testApp = await startTestApp([target.port], undefined, undefined, { STREAM_BUFFER_BYTES: "1024" });
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, { targeting: { country: "US" } });

  const response = await requestViaProxy(route.proxyUrls.http, target.url, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: payload,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, payload);
});

test("plain HTTP retries connection establishment before consuming a streamed request body", async (t) => {
  const target = await startHttpTarget();
  const lines: Array<{ message: string; context?: Record<string, unknown> }> = [];
  let stopPrimaryAfterSelection: (() => void) | undefined;
  const logger = {
    info: (message: string, context?: Record<string, unknown>) => {
      lines.push({ message, ...(context === undefined ? {} : { context }) });
      if (message === "Upstream candidate selected" && context?.["provider"] === "bright_data") {
        stopPrimaryAfterSelection?.();
        stopPrimaryAfterSelection = undefined;
      }
    },
    warn: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
    error: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
  };
  const testApp = await startTestApp([target.port], undefined, logger);
  stopPrimaryAfterSelection = () => {
    void testApp.application.simulators?.brightData.stop();
  };
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    targeting: { country: "US", region: "CA", city: "Los Angeles", carrier: "AT&T" },
    shouldRetry: true,
  });
  const response = await requestViaProxy(route.proxyUrls.http, target.url, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "stream-once-body",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-mock-endpoint-id"], "px-us-ca-1");
  assert.equal((JSON.parse(response.body) as Record<string, string>)["requestBody"], "stream-once-body");
  const attempts = lines.filter(({ message }) => message === "Upstream proxy attempt completed");
  assert.deepEqual(
    attempts.map(({ context }) => context?.["commitmentState"]),
    ["pre_commit", "committed"],
  );
});

test("CONNECT and SOCKS5 tunnels stream through the same bounded transport buffer", async (t) => {
  const target = await startEchoTarget();
  const testApp = await startTestApp([target.port], undefined, undefined, { STREAM_BUFFER_BYTES: "1024" });
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, { targeting: { country: "US" } });
  const payload = "opaque-tunnel-payload-exceeds-http-body-caps";

  assert.equal((await exchangeViaHttpConnect(route.proxyUrls.http, target.url, payload)).body, payload);
  assert.equal((await exchangeViaSocks5(route.proxyUrls.socks5, "127.0.0.1", target.port, payload)).body, payload);
});

test("HTTP, HTTPS CONNECT, and SOCKS5 attempts persist authoritative usage records", async (t) => {
  const httpTarget = await startHttpTarget();
  const echoTarget = await startEchoTarget();
  const testApp = await startTestApp([httpTarget.port, echoTarget.port]);
  t.after(async () => {
    await Promise.all([httpTarget.stop(), echoTarget.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "accounted-traffic",
    targeting: { country: "US" },
    allowedProtocols: ["http", "https", "socks5"],
  });
  assert.equal((await requestViaProxy(route.proxyUrls.http, httpTarget.url)).status, 200);
  assert.equal((await exchangeViaHttpConnect(route.proxyUrls.http, `127.0.0.1:${echoTarget.port}`, "connect-bytes")).body, "connect-bytes");
  assert.equal((await exchangeViaSocks5(route.proxyUrls.socks5, "127.0.0.1", echoTarget.port, "socks-bytes")).body, "socks-bytes");

  const store = new InMemoryRouteStore(testApp.storeState);
  try {
    const usageRange = recentWallClockRange();
    let records = await store.listUsageRecords(...usageRange);
    const deadline = Date.now() + 2_000;
    while (records.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      records = await store.listUsageRecords(...usageRange);
    }
    assert.deepEqual(new Set(records.map((record) => record.protocol)), new Set(["http", "https", "socks5"]));
    assert.ok(records.every((record) => record.kind === "attempt" && record.pricingVersion !== undefined));
    assert.ok(records.every((record) => record.latencyMs !== undefined && record.latencyMs >= 0));
    assert.ok(records.every((record) => record.logicalOperationId && record.customerId && record.userId && record.routeId));
    assert.ok(records.every((record) => record.upstreamConnectionId && record.connectionStartedAt && record.connectionEndedAt));
  } finally {
    await store.close();
  }
});

test("provider-side DNS remains authoritative while local and provider observations are diagnostic", async (t) => {
  const target = await startHttpTarget({ host: "localhost" });
  const lines: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logger = {
    info: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
    warn: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
    error: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
  };
  const targetValidator = () => ({
    localResolution: Promise.resolve({
      status: "available" as const,
      addresses: ["93.184.216.34"],
    }),
  });
  const testApp = await startTestApp([target.port], undefined, logger, {}, { targetValidator });
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "provider-dns",
    targeting: { country: "US" },
    shouldRetry: false,
  });
  const domainUrl = target.url;

  assert.equal((await requestViaProxy(route.proxyUrls.http, domainUrl)).status, 200);
  assert.equal(
    (
      await exchangeViaHttpConnect(
        route.proxyUrls.http,
        `localhost:${target.port}`,
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await exchangeViaSocks5(
        route.proxyUrls.socks5,
        "localhost",
        target.port,
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      )
    ).replyCode,
    0x00,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const observations = lines.filter(
    ({ message }) => message === "Destination resolution observed" || message === "Destination resolution requires operator review",
  );
  assert.ok(observations.length >= 3);
  assert.deepEqual(new Set(observations.map(({ context }) => context?.["dataPlaneProtocol"])), new Set(["http", "https", "socks5"]));
  for (const { context } of observations) {
    assert.equal(context?.["localResolutionStatus"], "available");
    assert.deepEqual(context?.["localResolvedAddresses"], ["93.184.216.34"]);
    assert.equal(context?.["providerResolutionStatus"], "available");
    assert.equal(context?.["resolutionDivergence"], "different");
    assert.equal(context?.["resolutionVerificationAvailability"], "available");
    assert.equal(context?.["destinationSafety"], "verified");
    assert.equal(context?.["resolutionGeographyVerification"], "match");
    assert.equal(context?.["providerResolverCountry"], "US");
    assert.ok(Array.isArray(context?.["providerResolvedAddresses"]));
  }
});

test("plain HTTP provider statuses after commitment are returned without replay or failover", async (t) => {
  const target = await startHttpTarget();
  const lines: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logger = {
    info: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
    warn: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
    error: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context === undefined ? {} : { context }) }),
  };
  const testApp = await startTestApp([target.port], undefined, logger);
  t.after(async () => {
    await Promise.all([target.stop(), testApp.stop()]);
  });
  const route = await createRoute(testApp.application, {
    name: "public-failover",
    targeting: { country: "US", region: "CA", carrier: "AT&T" },
    rotation: { mode: "manual" },
    shouldRetry: true,
  });
  testApp.application.simulators?.brightData.setFailure("unavailable");
  const response = await requestViaProxy(route.proxyUrls.http, target.url, { method: "POST", body: "non-replayable-body" });
  assert.equal(response.status, 502);
  assert.equal(testApp.application.simulators?.proxidize.lastIdentity(), undefined);
  const completion = lines.find(({ message }) => message === "Upstream proxy attempt completed");
  assert.equal(completion?.context?.["commitmentState"], "committed");
  assert.equal(completion?.context?.["retryIndex"], 0);
});
