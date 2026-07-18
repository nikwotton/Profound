import type {
  DataPlaneProtocol,
  MobileEndpoint,
  ProxyTarget,
  ProviderDescriptor,
  ProviderId,
  StoredRoute,
  UpstreamEndpoint,
} from "../domain/routing.js";
import type { ProviderHealth } from "../domain/health.js";

export interface ResolveOptions {
  dataPlaneProtocol: DataPlaneProtocol;
  target: ProxyTarget;
  logicalOperationId: string;
  sessionMode: "managed" | "stateless";
  affinityHandle?: string;
  candidateIndex: number;
  signal: AbortSignal;
  excludedEndpointIds?: ReadonlySet<string>;
  selectedEndpointId?: string;
}

/**
 * Normalized provider boundary. `resolve` performs adapter-local candidate
 * discovery/selection and materializes the upstream proxy connection details;
 * the gateway owns protocol transport. Health may be provider-backed or
 * configuration-backed, but vendor APIs and credentials stay adapter-local.
 */
export interface ProviderAdapter<Id extends ProviderId = ProviderId> {
  readonly descriptor: ProviderDescriptor & { id: Id };
  resolve(route: StoredRoute, options: ResolveOptions): Promise<UpstreamEndpoint>;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
}

export interface MobileProviderAdapter extends ProviderAdapter<"proxidize"> {
  readonly providerAccountId: string;
  listEndpoints(refresh?: boolean, signal?: AbortSignal): Promise<MobileEndpoint[]>;
  setRotationInterval(endpointId: string, intervalSeconds?: number): Promise<void>;
  matches(endpoint: MobileEndpoint, route: StoredRoute | { targeting: StoredRoute["targeting"] }): boolean;
}
