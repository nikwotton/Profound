import assert from "node:assert/strict";
import test from "node:test";
import { expectBufferChunk, parseJson } from "../src/decoding.js";
import { decodeOpenApiDocument } from "../src/openapi-compat.js";
import { decodeStoredRoute, decodeUsageRecord } from "../src/storage-decoding.js";
import { decodeProviderCostTotal, decodeProvisionedProxySlotCapacity } from "../src/usage-accounting.js";

test("JSON and stream decoders reject malformed external values", () => {
  assert.throws(() => parseJson("{", "configuration"), /configuration is not valid JSON/);
  assert.throws(() => expectBufferChunk({ bytes: [1] }), /stream chunk must be a string or byte array/);
  assert.deepEqual(expectBufferChunk(new Uint8Array([1, 2])), Buffer.from([1, 2]));
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
