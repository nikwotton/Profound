import { ProviderUnavailableError, UpstreamError } from "../errors.js";
import type { MobileProviderAdapter } from "./provider.js";
import type {
  MobileEndpoint,
  ProviderHealth,
  StoredRoute,
  UpstreamEndpoint,
} from "../types.js";

export interface ProxidizeConfig {
  apiBaseUrl: string;
  apiToken: string;
  requestTimeoutMs: number;
  cacheTtlMs?: number;
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
}

interface ProxiesResponse {
  data?: ProxyRecord[];
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export class ProxidizeAdapter implements MobileProviderAdapter {
  readonly provider = "proxidize" as const;
  #cachedEndpoints: MobileEndpoint[] = [];
  #cacheExpiresAt = 0;

  constructor(private readonly config: ProxidizeConfig) {}

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
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
    }
  }

  async listEndpoints(refresh = false): Promise<MobileEndpoint[]> {
    if (!refresh && Date.now() < this.#cacheExpiresAt) return this.#cachedEndpoints;
    const subscriptions = await this.#request<SubscriptionResponse>("/api/v1/subscription?type=per_proxy");
    const accountUsername = subscriptions.data?.[0]?.meta_data?.username;
    if (accountUsername === undefined) {
      throw new ProviderUnavailableError("No Proxidize per-proxy subscription was found");
    }
    const response = await this.#request<ProxiesResponse>(
      `/api/v1/perproxy/proxies/${encodeURIComponent(accountUsername)}`,
    );
    const endpoints = (response.data ?? []).map((record): MobileEndpoint => {
      if (
        record.id === undefined || record.username === undefined || record.password === undefined ||
        record.host === undefined || record.port === undefined || record.country === undefined ||
        record.region === undefined || record.carrier === undefined || record.public_key === undefined
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
      };
    });
    this.#cachedEndpoints = endpoints;
    this.#cacheExpiresAt = Date.now() + (this.config.cacheTtlMs ?? 5_000);
    return endpoints;
  }

  async resolve(route: StoredRoute): Promise<UpstreamEndpoint> {
    if (route.kind !== "mobile" || route.endpointId === undefined) {
      throw new ProviderUnavailableError("Proxidize route has no assigned mobile endpoint");
    }
    const endpoints = await this.listEndpoints(true);
    const endpoint = endpoints.find((candidate) => candidate.id === route.endpointId);
    if (endpoint === undefined || !endpoint.healthy) {
      throw new ProviderUnavailableError("The mobile route's assigned device is unhealthy");
    }
    return {
      provider: this.provider,
      endpointId: endpoint.id,
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      password: endpoint.password,
    };
  }

  async rotate(route: StoredRoute): Promise<void> {
    if (route.endpointId === undefined) {
      throw new ProviderUnavailableError("Mobile route has no assigned endpoint");
    }
    const endpoint = (await this.listEndpoints(true)).find((candidate) => candidate.id === route.endpointId);
    if (endpoint === undefined || !endpoint.healthy) {
      throw new ProviderUnavailableError("The mobile route's assigned device is unhealthy");
    }
    await this.#request<void>(`/api/v1/perproxy/rotate-url/${encodeURIComponent(endpoint.publicKey)}/`);
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

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const endpoints = await this.listEndpoints(true);
      const healthy = endpoints.filter((endpoint) => endpoint.healthy).length;
      if (healthy === 0) {
        return { provider: this.provider, state: "unhealthy", checkedAt, message: "No healthy mobile devices" };
      }
      if (healthy < endpoints.length) {
        return {
          provider: this.provider,
          state: "degraded",
          checkedAt,
          message: `${endpoints.length - healthy} mobile device(s) unhealthy`,
        };
      }
      return { provider: this.provider, state: "healthy", checkedAt };
    } catch {
      return {
        provider: this.provider,
        state: "unhealthy",
        checkedAt,
        message: "Proxidize control API is unreachable",
      };
    }
  }
}
