import type {
  DataPlaneProtocol,
  MobileEndpoint,
  ProxyTarget,
  ProviderDescriptor,
  ProviderHealth,
  ProviderId,
  StoredRoute,
  UpstreamEndpoint,
} from "../types.js";

export interface ResolveOptions {
  dataPlaneProtocol: DataPlaneProtocol;
  target: ProxyTarget;
  logicalOperationId: string;
  sessionMode: "managed" | "none";
  affinityHandle?: string;
  candidateIndex: number;
  signal: AbortSignal;
  excludedEndpointIds?: ReadonlySet<string>;
}

/** Generic provider boundary used by routing; vendor details stay adapter-local. */
export interface ProviderAdapter<Id extends ProviderId = ProviderId> {
  readonly descriptor: ProviderDescriptor & { id: Id };
  resolve(route: StoredRoute, options: ResolveOptions): Promise<UpstreamEndpoint>;
  rotate(route: StoredRoute, signal?: AbortSignal): Promise<void>;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
}

export interface MobileProviderAdapter extends ProviderAdapter<"proxidize"> {
  readonly providerAccountId: string;
  listEndpoints(refresh?: boolean, signal?: AbortSignal): Promise<MobileEndpoint[]>;
  setRotationInterval(endpointId: string, intervalSeconds?: number): Promise<void>;
  matches(endpoint: MobileEndpoint, route: StoredRoute | { targeting: StoredRoute["targeting"] }): boolean;
}
