import type {
  MobileEndpoint,
  ProviderHealth,
  StoredRoute,
  UpstreamEndpoint,
} from "../types.js";

export interface ProviderAdapter {
  readonly provider: StoredRoute["provider"];
  resolve(route: StoredRoute): Promise<UpstreamEndpoint>;
  rotate(route: StoredRoute): Promise<void>;
  health(): Promise<ProviderHealth>;
}

export interface MobileProviderAdapter extends ProviderAdapter {
  listEndpoints(refresh?: boolean): Promise<MobileEndpoint[]>;
  setRotationInterval(endpointId: string, intervalSeconds?: number): Promise<void>;
}
