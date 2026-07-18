import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";
import { silentLogger } from "../src/logger.js";
import type { ProviderAdapter } from "../src/providers/provider.js";
import { RouteService } from "../src/route-service.js";
import type { Telemetry } from "../src/telemetry.js";

test("a new candidate-backed provider participates in core routing through normalized capabilities only", async () => {
  const store = new InMemoryRouteStore();
  let preparedCandidate: string | undefined;
  const provider: ProviderAdapter<"future_device"> = {
    descriptor: {
      id: "future_device",
      providerClass: "device_backed",
      capabilities: {
        clientProtocols: new Set(["http", "https", "socks5"]),
        upstreamProtocols: new Set(["http"]),
        geography: new Set(["country", "region", "city", "carrier"]),
        countries: new Set(["US"]),
        sessions: true,
        exactCity: "provider_guaranteed",
        assignmentControl: {
          providerManagedReassignment: "observable",
          providerManagedRotation: "uncontrolled",
        },
        rotation: new Set(["interval", "manual"]),
        targetPorts: "any_public",
        dnsResolution: { http: "unverified", socks5: "unverified" },
        destinationSafety: {
          http: "provider_trusted",
          socks5: "provider_trusted",
          providerNetworkScope: "external_public_only",
        },
        health: { source: "provider_inventory" },
        capacity: {
          observation: "provider_inventory",
          hardLimit: "provider_signal_or_proxy_failure",
          provisioning: "adapter_optional",
        },
      },
      pricing: { source: "versioned_config", version: "2026-07-18", model: "per_device_month", amountUsd: 25 },
      usageDimensions: { common: ["bytes_sent", "bytes_received"], providerSpecific: ["candidate_id"] },
      costRank: 1,
    },
    candidates: {
      providerAccountId: () => "future-account",
      list: async () => [
        {
          id: "future-slot-1",
          healthy: true,
          inventory: {
            proxySlotId: "future-slot-1",
            country: "US",
            region: "NY",
            city: "New York",
            carrier: "Future Mobile",
            healthy: true,
          },
        },
      ],
      matches: (candidate, route) => candidate.inventory.city === route.targeting.city,
      prepare: async (candidateId) => {
        preparedCandidate = candidateId;
        return { providerManagedReassignmentDisabled: true };
      },
    },
    health: async () => ({ provider: "future_device", state: "healthy", checkedAt: new Date().toISOString() }),
    resolve: async (_route, options) => {
      assert.equal(options.selectedCandidateId, "future-slot-1");
      return {
        provider: "future_device",
        endpointId: "future-slot-1",
        protocol: "http",
        host: "127.0.0.1",
        port: 30_001,
        username: "future-user",
        password: "future-password",
        assignment: {
          candidateId: "future-slot-1",
          assignmentMode: "provider_guaranteed",
          providerManagedReassignmentDisabled: false,
          changeReason: "selection",
          expectedCity: "New York",
          observedCity: "New York",
        },
      };
    },
  };
  const routes = new RouteService({
    store,
    providers: [provider],
    proxyAddresses: () => ({ http: { host: "127.0.0.1", port: 30_002 }, socks5: { host: "127.0.0.1", port: 30_003 } }),
    advertisedProxyHost: "127.0.0.1",
    advertisedHttpProxyProtocol: "http",
    logger: silentLogger,
    telemetry: {} as Telemetry,
    retryDefaults: { maxAttempts: 2 },
    deploymentId: "test-deployment",
  });

  const profile = await routes.create(
    {
      customerId: "customer",
      geography: { countryCode: "US", regionCode: "NY", city: "New York" },
      providerOverride: "future_device",
      allowConnectionRetry: false,
    },
    "user",
  );
  const issued = await routes.createAccessGrant(profile.profileId, "user", { sessionMode: "managed" });
  const route = await routes.authenticate(issued.credential.username, issued.credential.password);
  const endpoint = await routes.resolve(route, "https", { host: "example.com", port: 443 }, routes.createResolutionState(), {
    logicalOperationId: "future-operation",
    signal: new AbortController().signal,
  });

  assert.equal(endpoint.provider, "future_device");
  assert.equal(endpoint.proxySlotId, "future-slot-1");
  assert.equal(endpoint.assignment.providerManagedReassignmentDisabled, true);
  assert.equal(preparedCandidate, "future-slot-1");
  assert.equal((await store.latestProviderInventory("future_device"))?.providerAccountId, "future-account");
  assert.equal((await store.latestProviderInventory("future_device"))?.monthlyPricePerSlotUsd, 25);
  await routes.releaseCandidate(endpoint);
});
