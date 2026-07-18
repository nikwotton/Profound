import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import { RouteProfilePayload } from "../src/control-contract.js";
import { expectBufferChunk, parseJson } from "../src/decoding.js";
import { assignmentFromError, attributeAssignment, toRouteServiceError } from "../src/errors.js";
import { decodeSyntheticValidationScope } from "../src/health-aggregator.js";
import { decodeIntegrationTargetEvent } from "../src/integration-target-lambda.js";
import { decodeBufferedLogLine, decodeCanaryGatewayEvent } from "../src/lambda-decoding.js";
import { decodeOpenApiDocument } from "../src/openapi-compat.js";
import { decodeActiveTunnel, decodeStoredRoute, decodeUsageReconciliation, decodeUsageRecord } from "../src/storage-decoding.js";
import { decodeProviderCostTotal, decodeProvisionedProxySlotCapacity } from "../src/usage-accounting.js";

test("JSON and stream decoders reject malformed external values", () => {
  assert.throws(() => parseJson("{", "configuration"), /configuration is not valid JSON/);
  assert.throws(() => expectBufferChunk({ bytes: [1] }), /stream chunk must be a string or byte array/);
  assert.deepEqual(expectBufferChunk(new Uint8Array([1, 2])), Buffer.from([1, 2]));
});

test("HTTP and Lambda trust boundaries decode exact runtime shapes", () => {
  assert.deepEqual(
    Schema.decodeUnknownSync(RouteProfilePayload)({
      customerId: "customer-1",
      allowConnectionRetry: true,
    }),
    {
      customerId: "customer-1",
      allowConnectionRetry: true,
    },
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(RouteProfilePayload)({
      customerId: "customer-1",
      allowConnectionRetry: true,
      unexpected: true,
    }),
  );
  assert.deepEqual(decodeSyntheticValidationScope({ capability: "all_traffic", country: "US", city: "New York" }), {
    capability: "all_traffic",
    country: "US",
    city: "New York",
  });
  assert.throws(() => decodeSyntheticValidationScope({ capability: "health_verification" }));
  assert.throws(() => decodeSyntheticValidationScope({ country: 1 }));

  assert.deepEqual(
    decodeCanaryGatewayEvent({
      rawPath: "/v1/challenge",
      headers: { "content-type": "application/json" },
      requestContext: { http: { method: "POST", sourceIp: "203.0.113.1" } },
    }),
    {
      rawPath: "/v1/challenge",
      headers: { "content-type": "application/json" },
      requestContext: { http: { method: "POST", sourceIp: "203.0.113.1" } },
    },
  );
  assert.throws(() => decodeCanaryGatewayEvent({ headers: { "content-length": 10 } }));
  assert.deepEqual(decodeIntegrationTargetEvent({ rawPath: "/echo", cookies: ["session=1"] }), {
    rawPath: "/echo",
    cookies: ["session=1"],
  });
  assert.throws(() => decodeIntegrationTargetEvent({ cookies: "session=1" }));
});

test("buffered logs and typed error metadata fail closed", () => {
  assert.deepEqual(
    decodeBufferedLogLine(
      JSON.stringify({ level: "info", time: "2026-07-17T00:00:00.000Z", message: "safe", context: { routeId: "route-1" } }),
    ),
    { level: "info", time: "2026-07-17T00:00:00.000Z", message: "safe", context: { routeId: "route-1" } },
  );
  assert.equal(decodeBufferedLogLine(JSON.stringify({ level: 1, time: "invalid", message: "unsafe" })), undefined);

  const evidence = {
    candidateId: "candidate-1",
    assignmentMode: "service_verified" as const,
    providerManagedReassignmentDisabled: true,
    changeReason: "selection" as const,
  };
  const error = attributeAssignment(new Error("failed"), evidence);
  assert.deepEqual(assignmentFromError(error), evidence);
  assert.equal(assignmentFromError({ assignmentEvidence: evidence }), undefined);
  const cause = new Error("secret detail");
  const normalized = toRouteServiceError(cause);
  assert.equal(normalized.code, "internal_error");
  assert.equal(normalized.cause, cause);
});

test("persistence decoders fail closed on invalid records", () => {
  assert.throws(() => decodeStoredRoute({ id: "route-1", provider: "unexpected" }));
  assert.throws(() =>
    decodeUsageRecord({
      kind: "attempt",
      id: "usage-1",
      bytesSent: "not-a-number",
    }),
  );

  const activeTunnel = {
    id: "tunnel-1",
    deploymentId: "deployment-1",
    routeId: "route-1",
    accessGrantId: "grant-1",
    protocol: "https",
    provider: "bright_data",
    routingScore: 1,
    startedAt: "2026-07-17T00:00:00.000Z",
    lastHeartbeatAt: "2026-07-17T00:00:01.000Z",
    expiresAt: "2026-07-17T00:01:00.000Z",
  };
  assert.deepEqual(decodeActiveTunnel(activeTunnel), activeTunnel);
  assert.throws(() => decodeActiveTunnel({ ...activeTunnel, routingScore: -1 }));
  assert.throws(() => decodeActiveTunnel({ ...activeTunnel, startedAt: "July 17, 2026" }));
  assert.throws(() => decodeActiveTunnel({ ...activeTunnel, unexpected: true }));

  assert.throws(
    () =>
      decodeUsageReconciliation({
        id: "reconciliation-1",
        provider: "bright_data",
        periodStartedAt: "2026-07-18T00:00:00.000Z",
        periodEndsAt: "2026-07-17T00:00:00.000Z",
        estimatedTotalUsd: 1,
        reportedTotalUsd: 1,
        varianceUsd: 0,
        relativeVariance: 0,
        varianceAttribution: "Unallocated",
        severity: "normal",
        sourceVersion: "invoice-1",
        createdAt: "2026-07-18T00:00:00.000Z",
      }),
    /positive time range/,
  );
});

test("provider accounting decoders require complete finite payloads", () => {
  assert.deepEqual(
    decodeProviderCostTotal({
      provider: "bright_data",
      periodStartedAt: "2026-07-01T00:00:00.000Z",
      periodEndsAt: "2026-08-01T00:00:00.000Z",
      amountUsd: 12.5,
      sourceVersion: "invoice-1",
    }),
    {
      provider: "bright_data",
      periodStartedAt: "2026-07-01T00:00:00.000Z",
      periodEndsAt: "2026-08-01T00:00:00.000Z",
      amountUsd: 12.5,
      sourceVersion: "invoice-1",
    },
  );
  assert.throws(() =>
    decodeProviderCostTotal({
      provider: "bright_data",
      periodStartedAt: "2026-07-01T00:00:00.000Z",
      periodEndsAt: "2026-08-01T00:00:00.000Z",
      amountUsd: Number.POSITIVE_INFINITY,
      sourceVersion: "invoice-1",
    }),
  );
  assert.throws(
    () =>
      decodeProviderCostTotal({
        provider: "bright_data",
        periodStartedAt: "2026-08-01T00:00:00.000Z",
        periodEndsAt: "2026-07-01T00:00:00.000Z",
        amountUsd: 12.5,
        sourceVersion: "invoice-1",
      }),
    /positive time range/,
  );
  assert.throws(
    () =>
      decodeProviderCostTotal({
        provider: "bright_data",
        periodStartedAt: "2026-07-01T00:00:00.000Z",
        periodEndsAt: "2026-08-01T00:00:00.000Z",
        amountUsd: -0.01,
        sourceVersion: "invoice-1",
      }),
    /non-negative/,
  );
  assert.throws(() =>
    decodeProvisionedProxySlotCapacity({
      id: "capacity-1",
      proxySlotId: "slot-1",
      periodStartedAt: "2026-07-01T00:00:00.000Z",
      periodEndsAt: "2026-08-01T00:00:00.000Z",
      priceUsd: 59,
      pricingVersion: "mobile-v1",
      health: "unknown",
    }),
  );
});

test("OpenAPI decoder rejects documents without required structural fields", () => {
  assert.throws(() => decodeOpenApiDocument({ openapi: "3.1.0", paths: [] }), /paths must be an object/);
});
