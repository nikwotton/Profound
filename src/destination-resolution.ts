import { isIP } from "node:net";
import type { Span } from "@opentelemetry/api";
import { AppError } from "./errors.js";
import type { Logger } from "./logger.js";
import { isPublicAddress, type LocalResolutionObservation, type TargetValidation } from "./target-security.js";

export interface ProviderResolutionMetadata {
  resolvedDestinationAddresses?: string[];
  resolverCountry?: string;
}

export function resolvedAddressesFromHeader(value: string | string[] | undefined): string[] | undefined {
  const values = (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => isIP(entry) !== 0);
  const normalized = [...new Set(values)].sort();
  return normalized.length === 0 ? undefined : normalized;
}

export function assertSafeProviderResolution(metadata: ProviderResolutionMetadata | undefined): void {
  const unsafe = (metadata?.resolvedDestinationAddresses ?? []).filter((address) => !isPublicAddress(address));
  if (unsafe.length > 0) {
    throw new AppError("Provider resolved the target to a non-public address", "provider_target_forbidden", 403);
  }
}

function sameAddresses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

export function recordDestinationResolution(options: {
  validation?: TargetValidation | undefined;
  providerMetadata?: ProviderResolutionMetadata | undefined;
  expectedCountry?: string | undefined;
  logger: Logger;
  span: Span;
  context: Record<string, unknown>;
}): void {
  const localPromise: Promise<LocalResolutionObservation> =
    options.validation?.localResolution ?? Promise.resolve({ status: "unavailable", addresses: [] });
  void localPromise
    .catch((): LocalResolutionObservation => ({ status: "unavailable", addresses: [] }))
    .then((local) => {
      const localAddresses = [...local.addresses].sort();
      const providerAddresses = [...(options.providerMetadata?.resolvedDestinationAddresses ?? [])].sort();
      const providerStatus = providerAddresses.length === 0 ? "unavailable" : "available";
      const verificationAvailability = local.status === "available" && providerStatus === "available" ? "available" : "unavailable";
      const divergence =
        verificationAvailability === "available"
          ? sameAddresses(localAddresses, providerAddresses)
            ? "match"
            : "different"
          : "unavailable";
      const unsafeLocalAddresses = localAddresses.filter((address) => !isPublicAddress(address));
      const unsafeProviderAddresses = providerAddresses.filter((address) => !isPublicAddress(address));
      const resolverCountry = options.providerMetadata?.resolverCountry;
      const geographyVerification =
        resolverCountry === undefined || options.expectedCountry === undefined
          ? "unavailable"
          : resolverCountry.toUpperCase() === options.expectedCountry.toUpperCase()
            ? "match"
            : "mismatch";
      const warning = unsafeLocalAddresses.length > 0 || unsafeProviderAddresses.length > 0 || geographyVerification === "mismatch";
      const attributes = {
        "proxy.destination_resolution.local.status": local.status,
        "proxy.destination_resolution.local.addresses": localAddresses,
        "proxy.destination_resolution.provider.status": providerStatus,
        "proxy.destination_resolution.provider.addresses": providerAddresses,
        "proxy.destination_resolution.divergence": divergence,
        "proxy.destination_resolution.verification_availability": verificationAvailability,
        "proxy.destination_resolution.geography_verification": geographyVerification,
        "proxy.destination_resolution.warning": warning,
        ...(resolverCountry === undefined ? {} : { "proxy.destination_resolution.provider.resolver_country": resolverCountry }),
      } as const;
      options.span.addEvent("proxy.destination_resolution.observed", attributes);
      const context = {
        ...options.context,
        localResolutionStatus: local.status,
        localResolvedAddresses: localAddresses,
        providerResolutionStatus: providerStatus,
        providerResolvedAddresses: providerAddresses,
        resolutionDivergence: divergence,
        resolutionVerificationAvailability: verificationAvailability,
        resolutionGeographyVerification: geographyVerification,
        ...(unsafeLocalAddresses.length === 0 ? {} : { unsafeLocalResolvedAddresses: unsafeLocalAddresses }),
        ...(unsafeProviderAddresses.length === 0 ? {} : { unsafeProviderResolvedAddresses: unsafeProviderAddresses }),
        ...(resolverCountry === undefined ? {} : { providerResolverCountry: resolverCountry }),
      };
      if (warning) options.logger.warn("Destination resolution requires operator review", context);
      else options.logger.info("Destination resolution observed", context);
    });
}
