import type {
  DataPlaneProtocol,
  ProxyTarget,
  ProviderDescriptor,
  ProviderId,
  ProviderInventorySlot,
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
  excludedCandidateIds?: ReadonlySet<string>;
  selectedCandidateId?: string;
}

export interface ProviderCandidate {
  id: string;
  healthy: boolean;
  inventory: ProviderInventorySlot;
}

export interface PreparedProviderCandidate {
  providerManagedReassignmentDisabled: boolean;
}

/**
 * Optional capability for providers whose independently selectable candidates
 * have inventory, load, and capacity semantics. The core routes against this
 * normalized shape without knowing which adapter supplies it.
 */
export interface ProviderCandidateSource {
  providerAccountId(): string;
  list(refresh?: boolean, signal?: AbortSignal): Promise<ProviderCandidate[]>;
  matches(candidate: ProviderCandidate, route: StoredRoute | { targeting: StoredRoute["targeting"] }): boolean;
  prepare?(candidateId: string): Promise<PreparedProviderCandidate>;
}

/**
 * Normalized provider boundary. `resolve` performs adapter-local candidate
 * discovery/selection and materializes the upstream proxy connection details;
 * the gateway owns protocol transport. Health may be provider-backed or
 * configuration-backed, but vendor APIs and credentials stay adapter-local.
 */
export interface ProviderAdapter<Id extends ProviderId = ProviderId> {
  readonly descriptor: ProviderDescriptor & { id: Id };
  readonly candidates?: ProviderCandidateSource;
  resolve(route: StoredRoute, options: ResolveOptions): Promise<UpstreamEndpoint>;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
}
