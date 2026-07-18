import type { ProviderAdapter } from "./providers/provider.js";
import type { DataPlaneProtocol, ProviderClass, ProviderId, ProxyTarget, RouteProfile, SessionMode } from "./domain/routing.js";

const TARGETING_KEYS = ["country", "region", "city", "postalCode", "asn", "carrier"] as const;

export function providerCompatible(
  provider: ProviderAdapter,
  route: RouteProfile,
  protocol?: DataPlaneProtocol,
  target?: ProxyTarget,
  sessionMode?: SessionMode,
): boolean {
  const capabilities = provider.descriptor.capabilities;
  const destinationSafety = protocol === "socks5" ? capabilities.destinationSafety.socks5 : capabilities.destinationSafety.http;
  if (destinationSafety === "provider_trusted" && capabilities.destinationSafety.providerNetworkScope !== "external_public_only")
    return false;
  if (protocol !== undefined && !capabilities.clientProtocols.has(protocol)) return false;
  if (protocol === undefined && !route.allowedProtocols.some((candidate) => capabilities.clientProtocols.has(candidate))) return false;
  if (sessionMode === "managed" && !capabilities.sessions) return false;
  if (route.targeting.city !== undefined && capabilities.exactCity === "unsupported") return false;
  const requiredRotation = sessionMode === "managed" ? "manual" : sessionMode === "stateless" ? "per_request" : undefined;
  const deviceBackedStatelessOverflow = requiredRotation === "per_request" && provider.descriptor.providerClass === "device_backed";
  if (
    requiredRotation === undefined
      ? !capabilities.rotation.has("manual") && !capabilities.rotation.has("per_request")
      : !capabilities.rotation.has(requiredRotation) && !deviceBackedStatelessOverflow
  ) {
    return false;
  }
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

export function preferredProviderClass(sessionMode: SessionMode): ProviderClass {
  return sessionMode === "managed" ? "device_backed" : "residential";
}

function compareProviders(
  left: ProviderAdapter,
  right: ProviderAdapter,
  sessionMode: SessionMode | undefined,
  currentProvider?: ProviderId,
): number {
  if (sessionMode !== undefined) {
    const preferredClass = preferredProviderClass(sessionMode);
    const classDifference =
      Number(left.descriptor.providerClass !== preferredClass) - Number(right.descriptor.providerClass !== preferredClass);
    if (classDifference !== 0) return classDifference;
  }
  if (left.descriptor.id === currentProvider) return -1;
  if (right.descriptor.id === currentProvider) return 1;
  return left.descriptor.costRank - right.descriptor.costRank;
}

export function selectCompatibleProvider(
  providers: Iterable<ProviderAdapter>,
  profile: RouteProfile,
  currentProvider?: ProviderId,
  sessionMode?: SessionMode,
): ProviderAdapter | undefined {
  return [...providers]
    .filter(
      (provider) =>
        providerCompatible(provider, profile, undefined, undefined, sessionMode) &&
        (profile.providerOverride === undefined || provider.descriptor.id === profile.providerOverride),
    )
    .sort((left, right) => compareProviders(left, right, sessionMode, currentProvider))[0];
}
