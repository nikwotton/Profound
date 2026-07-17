import { ProviderUnavailableError, UpstreamError } from "../errors.js";
import type { MobileProviderAdapter, ResolveOptions } from "./provider.js";
import type { MobileEndpoint, ProviderHealth, StoredRoute, Targeting, UpstreamEndpoint } from "../types.js";

export interface ProxidizeConfig {
  apiBaseUrl: string;
  apiToken: string;
  requestTimeoutMs: number;
  cacheTtlMs?: number;
  exactCity: "provider_guaranteed" | "unsupported";
}

interface SubscriptionResponse {
  data?: Array<{ meta_data?: { username?: string } }>;
}

interface ProxyRecord {
  id?: string;
  session_id?: string;
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  country?: string;
  region?: string;
  city?: string;
  carrier?: string;
  public_key?: string;
  healthy?: boolean;
  status?: string;
  ip?: string;
  current_ip?: string;
}

interface ProxiesResponse {
  data?: ProxyRecord[];
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
          providerManagedReassignment: "disabled" as const,
          providerManagedRotation: "disabled" as const,
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

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    init?.signal?.addEventListener("abort", abort, { once: true });
    if (init?.signal?.aborted === true) abort();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await fetch(new URL(path, this.config.apiBaseUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          accept: "application/json",
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
          ...init?.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new UpstreamError(`Proxidize control API returned ${response.status}`);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
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
    const subscriptions = await this.#request<SubscriptionResponse>(
      "/api/v1/subscription?type=per_proxy",
      signal === undefined ? undefined : { signal },
    );
    const accountUsername = subscriptions.data?.[0]?.meta_data?.username;
    if (accountUsername === undefined) {
      throw new ProviderUnavailableError("No Proxidize per-proxy subscription was found");
    }
    const response = await this.#request<ProxiesResponse>(
      `/api/v1/perproxy/proxies/${encodeURIComponent(accountUsername)}`,
      signal === undefined ? undefined : { signal },
    );
    const endpoints = (response.data ?? []).map((record): MobileEndpoint => {
      if (
        record.id === undefined ||
        record.username === undefined ||
        record.password === undefined ||
        record.host === undefined ||
        record.port === undefined ||
        record.country === undefined ||
        record.region === undefined ||
        record.carrier === undefined ||
        record.public_key === undefined
      ) {
        throw new UpstreamError("Proxidize returned an incomplete proxy record");
      }
      return {
        id: record.id,
        username: record.username,
        password: record.password,
        host: record.host,
        port: record.port,
        country: record.country.toUpperCase(),
        region: record.region,
        ...(record.city === undefined ? {} : { city: record.city }),
        carrier: record.carrier,
        publicKey: record.public_key,
        healthy: record.healthy ?? record.status === "active",
        ...((record.current_ip ?? record.ip) === undefined ? {} : { egressIp: record.current_ip ?? record.ip }),
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
      throw new ProviderUnavailableError("No healthy Proxidize device matches the route policy");
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
        deviceId: endpoint.id,
        assignmentMode: this.config.exactCity === "provider_guaranteed" ? "provider_guaranteed" : "unverified",
        providerManagedReassignmentDisabled: true,
        changeReason: options.candidateIndex === 0 ? "selection" : "retry",
        ...(endpoint.egressIp === undefined ? {} : { egressIp: endpoint.egressIp }),
        ...(route.targeting.city === undefined ? {} : { expectedCity: route.targeting.city }),
        ...(endpoint.city === undefined ? {} : { observedCity: endpoint.city }),
        ...(this.config.exactCity === "provider_guaranteed" ? { verificationSource: "provider_guarantee" } : {}),
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
    await this.#request<void>(
      `/api/v1/perproxy/rotate-url/${encodeURIComponent(endpoint.publicKey)}/`,
      signal === undefined ? undefined : { signal },
    );
    this.#cacheExpiresAt = 0;
  }

  async setRotationInterval(endpointId: string, intervalSeconds?: number): Promise<void> {
    const endpoint = (await this.listEndpoints(true)).find((candidate) => candidate.id === endpointId);
    if (endpoint === undefined) throw new ProviderUnavailableError("Mobile endpoint was not found");
    await this.#request<void>("/api/v1/perproxy/set-rotation-interval", {
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
    if (endpoint.country !== target.country) return false;
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
