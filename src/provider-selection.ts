import type { ProviderAdapter } from "./providers/provider.js";
import type { DataPlaneProtocol, ProviderClass, ProviderId, ProxyTarget, RouteProfile } from "./types.js";

const TARGETING_KEYS = ["country", "region", "city", "postalCode", "asn", "carrier"] as const;

export function providerCompatible(
  provider: ProviderAdapter,
  route: RouteProfile,
  protocol?: DataPlaneProtocol,
  target?: ProxyTarget,
): boolean {
  const capabilities = provider.descriptor.capabilities;
  if (protocol !== undefined && !capabilities.clientProtocols.has(protocol)) return false;
  if (protocol === undefined && !route.allowedProtocols.some((candidate) => capabilities.clientProtocols.has(candidate))) return false;
  if (route.isAuthenticated ? !capabilities.authenticatedTraffic : !capabilities.unauthenticatedTraffic) return false;
  if (route.session.mode === "sticky" && !capabilities.sessions) return false;
  if (route.isAuthenticated && capabilities.exactCity === "unsupported") return false;
  const deviceBackedUnauthenticatedOverflow =
    !route.isAuthenticated && route.rotation.mode === "per_request" && provider.descriptor.providerClass === "device_backed";
  if (!capabilities.rotation.has(route.rotation.mode) && !deviceBackedUnauthenticatedOverflow) return false;
  if (target !== undefined && capabilities.targetPorts !== "any_public" && !capabilities.targetPorts.has(target.port)) return false;
  if (
    route.targeting.country !== undefined &&
    capabilities.countries !== undefined &&
    !capabilities.countries.has(route.targeting.country)
  ) {
    return false;
  }
  return TARGETING_KEYS.every((key) => route.targeting[key] === undefined || capabilities.geography.has(key));
}

export function preferredProviderClass(route: Pick<RouteProfile, "isAuthenticated">): ProviderClass {
  return route.isAuthenticated ? "device_backed" : "residential";
}

function compareProviders(
  left: ProviderAdapter,
  right: ProviderAdapter,
  route: Pick<RouteProfile, "isAuthenticated">,
  currentProvider?: ProviderId,
): number {
  const preferredClass = preferredProviderClass(route);
  const classDifference =
    Number(left.descriptor.providerClass !== preferredClass) - Number(right.descriptor.providerClass !== preferredClass);
  if (classDifference !== 0) return classDifference;
  if (left.descriptor.id === currentProvider) return -1;
  if (right.descriptor.id === currentProvider) return 1;
  return left.descriptor.costRank - right.descriptor.costRank;
}

export function selectCompatibleProvider(
  providers: Iterable<ProviderAdapter>,
  profile: RouteProfile,
  currentProvider?: ProviderId,
): ProviderAdapter | undefined {
  return [...providers]
    .filter(
      (provider) =>
        providerCompatible(provider, profile) &&
        (profile.providerOverride === undefined || provider.descriptor.id === profile.providerOverride),
    )
    .sort((left, right) => compareProviders(left, right, profile, currentProvider))[0];
}
