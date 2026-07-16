import type {
  DataPlaneProtocol,
  MobileEndpoint,
  ProxyTarget,
  ProviderDescriptor,
  ProviderHealth,
  StoredRoute,
  UpstreamEndpoint,
} from "../types.js";

export interface ResolveOptions {
  dataPlaneProtocol: DataPlaneProtocol;
  target: ProxyTarget;
  logicalOperationId: string;
  candidateIndex: number;
  signal: AbortSignal;
  excludedEndpointIds?: ReadonlySet<string>;
}

/** Generic provider boundary used by routing; vendor details stay adapter-local. */
export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  resolve(route: StoredRoute, options: ResolveOptions): Promise<UpstreamEndpoint>;
  rotate(route: StoredRoute, signal?: AbortSignal): Promise<void>;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
}

export interface MobileProviderAdapter extends ProviderAdapter {
  listEndpoints(refresh?: boolean, signal?: AbortSignal): Promise<MobileEndpoint[]>;
  setRotationInterval(endpointId: string, intervalSeconds?: number): Promise<void>;
}
