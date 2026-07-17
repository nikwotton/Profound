import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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
  };
  const proxidizeSpec = JSON.parse(readFileSync("config/providers/proxidize-v0.json", "utf8")) as { provider: string };
  assert.equal(brightData.descriptor.id, brightDataSpec.provider);
  assert.deepEqual([...brightData.descriptor.capabilities.geography], brightDataSpec.targeting);
  assert.deepEqual([...brightData.descriptor.capabilities.rotation], brightDataSpec.rotation);
  assert.equal(proxidize.descriptor.id, proxidizeSpec.provider);
});
