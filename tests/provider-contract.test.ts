import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ProviderAuthenticationError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  providerIdFromError,
} from "../src/errors.js";
import { BrightDataAdapter } from "../src/providers/bright-data.js";
import { ProxidizeAdapter } from "../src/providers/proxidize.js";
import type { ProviderDescriptor } from "../src/types.js";

function assertNormalizedContract(descriptor: ProviderDescriptor): void {
  assert.ok(descriptor.capabilities.clientProtocols.size > 0);
  assert.ok(descriptor.capabilities.upstreamProtocols.size > 0);
  assert.ok(descriptor.capabilities.geography.has("country"));
  assert.equal(typeof descriptor.capabilities.sessions, "boolean");
  assert.ok(["provider_guaranteed", "verifiable", "unsupported"].includes(descriptor.capabilities.exactCity));
  assert.ok(["disabled", "observable", "uncontrolled"].includes(descriptor.capabilities.assignmentControl.providerManagedReassignment));
  assert.ok(["disabled", "uncontrolled"].includes(descriptor.capabilities.assignmentControl.providerManagedRotation));
  assert.ok(descriptor.capabilities.rotation.size > 0);
  assert.ok(["provider_configurable", "provider_remote", "unverified"].includes(descriptor.capabilities.dnsResolution.http));
  assert.ok(["provider_configurable", "provider_remote", "unverified"].includes(descriptor.capabilities.dnsResolution.socks5));
  assert.ok(["verified", "provider_trusted"].includes(descriptor.capabilities.destinationSafety.http));
  assert.ok(["verified", "provider_trusted"].includes(descriptor.capabilities.destinationSafety.socks5));
  assert.equal(descriptor.capabilities.destinationSafety.providerNetworkScope, "external_public_only");
  assert.ok(["provider_api_or_probe", "provider_inventory"].includes(descriptor.capabilities.health.source));
  assert.ok(["provider_api_or_evidence", "provider_inventory"].includes(descriptor.capabilities.capacity.observation));
  assert.equal(descriptor.capabilities.capacity.hardLimit, "provider_signal_or_proxy_failure");
  assert.ok(["unsupported", "operator_only", "adapter_optional"].includes(descriptor.capabilities.capacity.provisioning));
  assert.match(descriptor.pricing.version, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(descriptor.pricing.amountUsd > 0);
  assert.deepEqual(descriptor.usageDimensions.common, ["bytes_sent", "bytes_received"]);
  assert.ok(descriptor.usageDimensions.providerSpecific.length > 0);
  assert.ok(descriptor.costRank > 0);
}

test("every adapter satisfies the normalized provider capability contract and its pinned specification", () => {
  const brightData = new BrightDataAdapter({
    host: "127.0.0.1",
    port: 33335,
    customerId: "customer",
    zone: "zone",
    password: "password",
    connectTimeoutMs: 1_000,
  });
  const proxidize = new ProxidizeAdapter({
    apiBaseUrl: "http://127.0.0.1:2000",
    apiToken: "token",
    requestTimeoutMs: 1_000,
    exactCity: "provider_guaranteed",
  });
  for (const adapter of [brightData, proxidize]) assertNormalizedContract(adapter.descriptor);

  const brightDataSpec = JSON.parse(readFileSync("config/providers/bright-data-v0.json", "utf8")) as {
    provider: string;
    targeting: string[];
    rotation: string[];
    destinationSafety: string;
    providerNetworkScope: string;
    capacityObservation: string;
    hardLimitBehavior: string;
    provisioning: string;
  };
  const proxidizeSpec = JSON.parse(readFileSync("config/providers/proxidize-v0.json", "utf8")) as {
    provider: string;
    destinationSafety: string;
    providerNetworkScope: string;
    capacityObservation: string;
    hardLimitBehavior: string;
    provisioning: string;
  };
  assert.equal(brightData.descriptor.id, brightDataSpec.provider);
  assert.deepEqual([...brightData.descriptor.capabilities.geography], brightDataSpec.targeting);
  assert.deepEqual([...brightData.descriptor.capabilities.rotation], brightDataSpec.rotation);
  assert.equal(brightData.descriptor.capabilities.destinationSafety.http, brightDataSpec.destinationSafety);
  assert.equal(brightData.descriptor.capabilities.destinationSafety.providerNetworkScope, brightDataSpec.providerNetworkScope);
  assert.equal(brightData.descriptor.capabilities.capacity.observation, brightDataSpec.capacityObservation);
  assert.equal(brightData.descriptor.capabilities.capacity.hardLimit, brightDataSpec.hardLimitBehavior);
  assert.equal(brightData.descriptor.capabilities.capacity.provisioning, brightDataSpec.provisioning);
  assert.equal(proxidize.descriptor.id, proxidizeSpec.provider);
  assert.equal(proxidize.descriptor.capabilities.destinationSafety.http, proxidizeSpec.destinationSafety);
  assert.equal(proxidize.descriptor.capabilities.destinationSafety.providerNetworkScope, proxidizeSpec.providerNetworkScope);
  assert.equal(proxidize.descriptor.capabilities.capacity.observation, proxidizeSpec.capacityObservation);
  assert.equal(proxidize.descriptor.capabilities.capacity.hardLimit, proxidizeSpec.hardLimitBehavior);
  assert.equal(proxidize.descriptor.capabilities.capacity.provisioning, proxidizeSpec.provisioning);
});

test("Proxidize decodes injected control-plane responses and exposes typed, attributed protocol failures", async () => {
  let requestCount = 0;
  const malformed = new ProxidizeAdapter({
    apiBaseUrl: "https://proxidize.invalid",
    apiToken: "token",
    requestTimeoutMs: 1_000,
    exactCity: "provider_guaranteed",
    fetchImplementation: () => {
      requestCount += 1;
      return Promise.resolve(
        requestCount === 1
          ? Response.json({ data: [{ meta_data: { username: "account" } }] })
          : Response.json({
              data: [
                {
                  id: "slot-1",
                  username: "proxy-user",
                  password: "proxy-password",
                  host: "proxy.example",
                  port: "not-a-port",
                  country: "US",
                  region: "NY",
                  carrier: "T-Mobile",
                  public_key: "key-1",
                  healthy: true,
                },
              ],
            }),
      );
    },
  });

  await assert.rejects(malformed.listEndpoints(true), (error: unknown) => {
    assert.ok(error instanceof ProviderProtocolError);
    assert.equal(error.code, "provider_protocol_error");
    assert.equal(error.retryable, false);
    assert.equal(providerIdFromError(error), "proxidize");
    return true;
  });
  assert.equal(requestCount, 2);

  const rateLimited = new ProxidizeAdapter({
    apiBaseUrl: "https://proxidize.invalid",
    apiToken: "token",
    requestTimeoutMs: 1_000,
    exactCity: "provider_guaranteed",
    fetchImplementation: () => Promise.resolve(new Response(undefined, { status: 429, headers: { "retry-after": "2" } })),
  });
  await assert.rejects(rateLimited.listEndpoints(true), (error: unknown) => {
    assert.ok(error instanceof ProviderRateLimitError);
    assert.match(error.message, /HTTP 429/);
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 2_000);
    assert.equal(providerIdFromError(error), "proxidize");
    return true;
  });

  const unauthorized = new ProxidizeAdapter({
    apiBaseUrl: "https://proxidize.invalid",
    apiToken: "token",
    requestTimeoutMs: 1_000,
    exactCity: "provider_guaranteed",
    fetchImplementation: () => Promise.resolve(new Response(undefined, { status: 401 })),
  });
  await assert.rejects(unauthorized.listEndpoints(true), (error: unknown) => {
    assert.ok(error instanceof ProviderAuthenticationError);
    assert.equal(error.retryable, false);
    assert.equal(providerIdFromError(error), "proxidize");
    return true;
  });

  const serviceUnavailable = new ProxidizeAdapter({
    apiBaseUrl: "https://proxidize.invalid",
    apiToken: "token",
    requestTimeoutMs: 1_000,
    exactCity: "provider_guaranteed",
    fetchImplementation: () => Promise.resolve(new Response(undefined, { status: 503 })),
  });
  await assert.rejects(serviceUnavailable.listEndpoints(true), (error: unknown) => {
    assert.ok(error instanceof ProviderUnavailableError);
    assert.equal(error.retryable, true);
    assert.equal(providerIdFromError(error), "proxidize");
    return true;
  });

  const invalidJson = new ProxidizeAdapter({
    apiBaseUrl: "https://proxidize.invalid",
    apiToken: "token",
    requestTimeoutMs: 1_000,
    exactCity: "provider_guaranteed",
    fetchImplementation: () => Promise.resolve(new Response("{", { status: 200 })),
  });
  await assert.rejects(invalidJson.listEndpoints(true), (error: unknown) => {
    assert.ok(error instanceof ProviderProtocolError);
    assert.match(error.message, /malformed JSON/);
    assert.equal(providerIdFromError(error), "proxidize");
    return true;
  });

  const unavailable = new ProxidizeAdapter({
    apiBaseUrl: "https://proxidize.invalid",
    apiToken: "token",
    requestTimeoutMs: 1_000,
    exactCity: "provider_guaranteed",
    fetchImplementation: () => Promise.reject(new Error("private network detail")),
  });
  await assert.rejects(unavailable.listEndpoints(true), (error: unknown) => {
    assert.ok(error instanceof ProviderUnavailableError);
    assert.equal(error.message, "Proxidize control API is unavailable");
    assert.equal(providerIdFromError(error), "proxidize");
    return true;
  });
});
