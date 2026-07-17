import { ProviderUnavailableError, UpstreamError } from "../errors.js";
import { expectArray, expectBoolean, expectNumber, expectOptionalString, expectRecord, expectString } from "../decoding.js";
import type { MobileProviderAdapter, ResolveOptions } from "./provider.js";
import type { MobileEndpoint, ProviderHealth, StoredRoute, Targeting, UpstreamEndpoint } from "../types.js";

export interface ProxidizeConfig {
  apiBaseUrl: string;
  apiToken: string;
  requestTimeoutMs: number;
  cacheTtlMs?: number;
  exactCity: "provider_guaranteed" | "verifiable" | "unsupported";
  providerAccountId?: string;
}

function normalized(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export class ProxidizeAdapter implements MobileProviderAdapter {
  readonly descriptor;

  constructor(private readonly config: ProxidizeConfig) {
    this.descriptor = {
      id: "proxidize" as const,
      providerClass: "device_backed" as const,
      capabilities: {
        clientProtocols: new Set(["http", "https", "socks5"] as const),
        upstreamProtocols: new Set(["http"] as const),
        authenticatedTraffic: true,
        unauthenticatedTraffic: true,
        geography: new Set<keyof Targeting>(["country", "region", "city", "carrier"]),
        countries: new Set(["US"]),
        sessions: true,
        exactCity: config.exactCity,
        assignmentControl: {
          providerManagedReassignment: "observable" as const,
          providerManagedRotation: "uncontrolled" as const,
        },
        rotation: new Set(["interval", "manual"] as const),
        targetPorts: "any_public" as const,
        dnsResolution: {
          http: "unverified" as const,
          socks5: "unverified" as const,
        },
      },
      pricing: {
        source: "versioned_config" as const,
        version: "2026-07-13",
        model: "per_device_month" as const,
        amountUsd: 59,
      },
      usageDimensions: {
        common: ["bytes_sent", "bytes_received"] as const,
        providerSpecific: ["device_id"] as const,
      },
      costRank: 2,
    };
  }
  #cachedEndpoints: MobileEndpoint[] = [];
  #cacheExpiresAt = 0;

  get providerAccountId(): string {
    return this.config.providerAccountId ?? "proxidize-primary";
  }

  async #request(path: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    init?.signal?.addEventListener("abort", abort, { once: true });
    if (init?.signal?.aborted === true) abort();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${this.config.apiToken}`);
      headers.set("accept", "application/json");
      if (init?.body !== undefined) headers.set("content-type", "application/json");
      const response = await fetch(new URL(path, this.config.apiBaseUrl), {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new UpstreamError(`Proxidize control API returned ${response.status}`);
      }
      if (response.status === 204) return undefined;
      return await response.json();
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new ProviderUnavailableError("Proxidize control API is unavailable");
    } finally {
      clearTimeout(timeout);
      init?.signal?.removeEventListener("abort", abort);
    }
  }

  async listEndpoints(refresh = false, signal?: AbortSignal): Promise<MobileEndpoint[]> {
    if (!refresh && Date.now() < this.#cacheExpiresAt) return this.#cachedEndpoints;
    const subscriptions = expectRecord(
      await this.#request("/api/v1/subscription?type=per_proxy", signal === undefined ? undefined : { signal }),
      "Proxidize subscriptions response",
    );
    const subscriptionData = expectArray(subscriptions.data, "Proxidize subscriptions response.data");
    const subscription = expectRecord(subscriptionData[0], "Proxidize subscriptions response.data[0]");
    const metadata = expectRecord(subscription.meta_data, "Proxidize subscription metadata");
    const accountUsername = expectOptionalString(metadata.username, "Proxidize subscription username");
    if (accountUsername === undefined || accountUsername.length === 0) {
      throw new ProviderUnavailableError("No Proxidize per-proxy subscription was found");
    }
    const response = expectRecord(
      await this.#request(`/api/v1/perproxy/proxies/${encodeURIComponent(accountUsername)}`, signal === undefined ? undefined : { signal }),
      "Proxidize proxies response",
    );
    const endpoints = expectArray(response.data, "Proxidize proxies response.data").map((value, index): MobileEndpoint => {
      const record = expectRecord(value, `Proxidize proxy record ${index}`);
      const currentIp = expectOptionalString(record.current_ip, `Proxidize proxy record ${index}.current_ip`);
      const ip = expectOptionalString(record.ip, `Proxidize proxy record ${index}.ip`);
      const egressIp = currentIp ?? ip;
      const deviceId = expectOptionalString(record.device_id, `Proxidize proxy record ${index}.device_id`);
      const city = expectOptionalString(record.city, `Proxidize proxy record ${index}.city`);
      const status = expectOptionalString(record.status, `Proxidize proxy record ${index}.status`);
      const healthy =
        record.healthy === undefined ? status === "active" : expectBoolean(record.healthy, `Proxidize proxy record ${index}.healthy`);
      return {
        id: expectString(record.id, `Proxidize proxy record ${index}.id`),
        username: expectString(record.username, `Proxidize proxy record ${index}.username`),
        password: expectString(record.password, `Proxidize proxy record ${index}.password`),
        host: expectString(record.host, `Proxidize proxy record ${index}.host`),
        port: expectNumber(record.port, `Proxidize proxy record ${index}.port`),
        country: expectString(record.country, `Proxidize proxy record ${index}.country`).toUpperCase(),
        region: expectString(record.region, `Proxidize proxy record ${index}.region`),
        ...(city === undefined ? {} : { city }),
        carrier: expectString(record.carrier, `Proxidize proxy record ${index}.carrier`),
        publicKey: expectString(record.public_key, `Proxidize proxy record ${index}.public_key`),
        ...(deviceId === undefined ? {} : { deviceId }),
        healthy,
        ...(egressIp === undefined ? {} : { egressIp }),
      };
    });
    this.#cachedEndpoints = endpoints;
    this.#cacheExpiresAt = Date.now() + (this.config.cacheTtlMs ?? 5_000);
    return endpoints;
  }

  async resolve(route: StoredRoute, options: ResolveOptions): Promise<UpstreamEndpoint> {
    const endpoints = await this.listEndpoints(true, options.signal);
    const assigned = route.endpointId === undefined ? undefined : endpoints.find((candidate) => candidate.id === route.endpointId);
    const endpoint =
      assigned ??
      endpoints.find((candidate) => candidate.healthy && !options.excludedEndpointIds?.has(candidate.id) && this.matches(candidate, route));
    if (endpoint === undefined || !endpoint.healthy) {
      throw new ProviderUnavailableError("No healthy Proxidize proxy slot matches the route policy");
    }
    return {
      provider: this.descriptor.id,
      endpointId: endpoint.id,
      protocol: "http",
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      password: endpoint.password,
      assignment: {
        candidateId: endpoint.id,
        proxySlotId: endpoint.id,
        ...(endpoint.deviceId === undefined ? {} : { deviceId: endpoint.deviceId }),
        assignmentMode:
          this.config.exactCity === "provider_guaranteed"
            ? "provider_guaranteed"
            : this.config.exactCity === "verifiable" && endpoint.city !== undefined
              ? "service_verified"
              : "unverified",
        providerManagedReassignmentDisabled: false,
        changeReason: options.candidateIndex === 0 ? "selection" : "retry",
        ...(endpoint.egressIp === undefined ? {} : { egressIp: endpoint.egressIp }),
        ...(route.targeting.city === undefined ? {} : { expectedCity: route.targeting.city }),
        ...(endpoint.city === undefined ? {} : { observedCity: endpoint.city }),
        ...(this.config.exactCity === "provider_guaranteed"
          ? { verificationSource: "provider_guarantee" }
          : this.config.exactCity === "verifiable" && endpoint.city !== undefined
            ? { verificationSource: "provider_inventory" }
            : {}),
      },
    };
  }

  async rotate(route: StoredRoute, signal?: AbortSignal): Promise<void> {
    if (route.endpointId === undefined) {
      throw new ProviderUnavailableError("Mobile route has no assigned endpoint");
    }
    const endpoint = (await this.listEndpoints(true, signal)).find((candidate) => candidate.id === route.endpointId);
    if (endpoint === undefined || !endpoint.healthy) {
      throw new ProviderUnavailableError("The mobile route's assigned device is unhealthy");
    }
    await this.#request(
      `/api/v1/perproxy/rotate-url/${encodeURIComponent(endpoint.publicKey)}/`,
      signal === undefined ? undefined : { signal },
    );
    this.#cacheExpiresAt = 0;
  }

  async setRotationInterval(endpointId: string, intervalSeconds?: number): Promise<void> {
    const endpoint = (await this.listEndpoints(true)).find((candidate) => candidate.id === endpointId);
    if (endpoint === undefined) throw new ProviderUnavailableError("Mobile endpoint was not found");
    await this.#request("/api/v1/perproxy/set-rotation-interval", {
      method: "POST",
      body: JSON.stringify({
        username: endpoint.username,
        session_id: endpoint.id,
        interval: intervalSeconds ?? -1,
        public_key: endpoint.publicKey,
      }),
    });
  }

  matches(endpoint: MobileEndpoint, route: StoredRoute | { targeting: StoredRoute["targeting"] }): boolean {
    const target = route.targeting;
    if (target.country !== undefined && endpoint.country !== target.country) return false;
    if (target.region !== undefined && normalized(endpoint.region) !== normalized(target.region)) return false;
    if (target.city !== undefined && (endpoint.city === undefined || normalized(endpoint.city) !== normalized(target.city))) {
      return false;
    }
    if (target.carrier !== undefined && normalized(endpoint.carrier) !== normalized(target.carrier)) return false;
    return true;
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const endpoints = await this.listEndpoints(true, signal);
      const healthy = endpoints.filter((endpoint) => endpoint.healthy).length;
      if (healthy === 0) {
        return { provider: this.descriptor.id, state: "unhealthy", checkedAt, message: "No healthy mobile devices" };
      }
      if (healthy < endpoints.length) {
        return {
          provider: this.descriptor.id,
          state: "degraded",
          checkedAt,
          message: `${endpoints.length - healthy} mobile device(s) unhealthy`,
        };
      }
      return { provider: this.descriptor.id, state: "healthy", checkedAt };
    } catch {
      return {
        provider: this.descriptor.id,
        state: "unhealthy",
        checkedAt,
        message: "Proxidize control API is unreachable",
      };
    }
  }
}
