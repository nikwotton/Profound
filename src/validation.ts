import { ValidationError } from "./errors.js";
import type {
  DataPlaneProtocol,
  ProviderId,
  RetryPolicy,
  RotationPolicy,
  RouteProfile,
  RouteProfileInput,
  SessionPolicy,
  Targeting,
} from "./types.js";

const COUNTRY_CODE = /^[A-Za-z]{2}$/;
const POSTAL_CODE_US = /^\d{5}$/;
const DATA_PLANE_PROTOCOLS = new Set<DataPlaneProtocol>(["http", "https", "socks5"]);

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function parseProvider(value: unknown): ProviderId | undefined {
  if (value === undefined) return undefined;
  if (value !== "bright_data" && value !== "proxidize") {
    throw new ValidationError("forceProvider must be bright_data or proxidize");
  }
  return value;
}

function parseAllowedProtocols(value: unknown): DataPlaneProtocol[] {
  if (value === undefined) return ["http", "https", "socks5"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("allowedProtocols must be a non-empty array");
  }
  const protocols = value.map((item) => {
    if (typeof item !== "string" || !DATA_PLANE_PROTOCOLS.has(item as DataPlaneProtocol)) {
      throw new ValidationError("allowedProtocols entries must be http, https, or socks5");
    }
    return item as DataPlaneProtocol;
  });
  return [...new Set(protocols)];
}

function parseTargeting(value: unknown): Targeting {
  const input = object(value, "targeting");
  const country = string(input.country, "targeting.country").toUpperCase();
  if (!COUNTRY_CODE.test(country)) throw new ValidationError("targeting.country must be a two-letter ISO country code");
  const region = optionalString(input.region, "targeting.region");
  const city = optionalString(input.city, "targeting.city");
  const postalCode = optionalString(input.postalCode, "targeting.postalCode");
  const carrier = optionalString(input.carrier, "targeting.carrier");
  const asn = input.asn;
  if (asn !== undefined && (!Number.isInteger(asn) || (asn as number) <= 0)) {
    throw new ValidationError("targeting.asn must be a positive integer");
  }
  return {
    country,
    ...(region === undefined ? {} : { region }),
    ...(city === undefined ? {} : { city }),
    ...(postalCode === undefined ? {} : { postalCode }),
    ...(asn === undefined ? {} : { asn: asn as number }),
    ...(carrier === undefined ? {} : { carrier }),
  };
}

function parseRotation(value: unknown, isAuthenticated: boolean, requiresMobileRotation: boolean): RotationPolicy {
  if (value === undefined) return isAuthenticated ? { mode: "manual" } : { mode: "per_request" };
  const input = object(value, "rotation");
  if (input.mode === "per_request") {
    if (requiresMobileRotation) throw new ValidationError("Proxidize mobile routes do not support per_request rotation");
    return { mode: "per_request" };
  }
  if (input.mode === "manual") return { mode: "manual" };
  if (input.mode === "interval") {
    if (!Number.isInteger(input.intervalSeconds) || (input.intervalSeconds as number) < 60) {
      throw new ValidationError("rotation.intervalSeconds must be an integer of at least 60");
    }
    return { mode: "interval", intervalSeconds: input.intervalSeconds as number };
  }
  throw new ValidationError("rotation.mode must be per_request, interval, or manual");
}

function parseRetry(value: unknown, defaults: RetryPolicy): RetryPolicy {
  if (value === undefined) return defaults;
  const input = object(value, "retryPolicy");
  const maxAttempts = input.maxAttempts ?? defaults.maxAttempts;
  if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 6) {
    throw new ValidationError("retryPolicy.maxAttempts must be an integer from 1 to 6");
  }
  if ("backoffMs" in input) {
    throw new ValidationError("retryPolicy.backoffMs is not supported because establishment retries do not back off");
  }
  return { maxAttempts: maxAttempts as number };
}

function parseSession(value: unknown, rotation: RotationPolicy): SessionPolicy {
  if (value === undefined) {
    return rotation.mode === "per_request"
      ? { mode: "none", requireGeographicContinuity: false }
      : { mode: "sticky", requireGeographicContinuity: true };
  }
  const input = object(value, "session");
  if (input.mode === "none") return { mode: "none", requireGeographicContinuity: false };
  if (input.mode !== "sticky") throw new ValidationError("session.mode must be none or sticky");
  const id = optionalString(input.id, "session.id");
  if (input.requireGeographicContinuity !== undefined && typeof input.requireGeographicContinuity !== "boolean") {
    throw new ValidationError("session.requireGeographicContinuity must be boolean");
  }
  if (rotation.mode === "per_request") {
    throw new ValidationError("sticky sessions are incompatible with per_request rotation");
  }
  return {
    mode: "sticky",
    ...(id === undefined ? {} : { id }),
    requireGeographicContinuity: input.requireGeographicContinuity ?? true,
  };
}

export function validateRouteProfile(
  value: unknown,
  userId: string,
  retryDefaults: RetryPolicy,
): RouteProfile {
  const raw = object(value, "route");
  if ("kind" in raw) {
    throw new ValidationError("kind is not part of the route policy; use isAuthenticated and forceProvider");
  }
  const input = raw as unknown as RouteProfileInput;
  if (typeof input.isAuthenticated !== "boolean") throw new ValidationError("isAuthenticated must be boolean");
  if (typeof input.shouldRetry !== "boolean") throw new ValidationError("shouldRetry must be boolean");
  const forceProvider = parseProvider(input.forceProvider);
  const targeting = parseTargeting(input.targeting);
  const selectsProxidize = forceProvider === "proxidize" || (forceProvider === undefined && input.isAuthenticated);
  const rotation = parseRotation(input.rotation, input.isAuthenticated, selectsProxidize);

  if (input.isAuthenticated && targeting.city === undefined) {
    throw new ValidationError("targeting.city is required when isAuthenticated is true");
  }

  if (targeting.postalCode !== undefined && (targeting.country !== "US" || !POSTAL_CODE_US.test(targeting.postalCode))) {
    throw new ValidationError("Bright Data ZIP targeting requires country US and a five-digit postalCode");
  }
  if (selectsProxidize && targeting.country !== "US") {
    throw new ValidationError("Proxidize per-proxy routes currently require country US");
  }
  if (selectsProxidize && (targeting.postalCode !== undefined || targeting.asn !== undefined)) {
    throw new ValidationError("Proxidize does not support postalCode or ASN targeting");
  }
  return {
    name: string(input.name, "name"),
    allowedProtocols: parseAllowedProtocols(input.allowedProtocols),
    targeting,
    rotation,
    session: parseSession(input.session, rotation),
    customerId: string(input.customerId, "customerId"),
    userId: string(userId, "userId"),
    isAuthenticated: input.isAuthenticated,
    shouldRetry: input.shouldRetry,
    retryPolicy: parseRetry(input.retryPolicy, retryDefaults),
    ...(forceProvider === undefined ? {} : { forceProvider }),
  };
}
