import { ValidationError } from "./errors.js";
import type {
  ProxyKind,
  RotationPolicy,
  RouteProfile,
  RouteProfileInput,
  Targeting,
} from "./types.js";

const COUNTRY_CODE = /^[A-Za-z]{2}$/;
const POSTAL_CODE_US = /^\d{5}$/;

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function parseKind(value: unknown): ProxyKind {
  if (value !== "residential" && value !== "mobile") {
    throw new ValidationError("kind must be residential or mobile");
  }
  return value;
}

function parseTargeting(value: unknown): Targeting {
  const input = object(value, "targeting");
  const country = string(input.country, "targeting.country").toUpperCase();
  if (!COUNTRY_CODE.test(country)) {
    throw new ValidationError("targeting.country must be a two-letter ISO country code");
  }

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

function parseRotation(value: unknown, kind: ProxyKind): RotationPolicy {
  if (value === undefined) {
    return kind === "residential" ? { mode: "per_request" } : { mode: "manual" };
  }

  const input = object(value, "rotation");
  if (input.mode === "per_request") {
    if (kind === "mobile") {
      throw new ValidationError("mobile routes do not support per_request rotation");
    }
    return { mode: "per_request" };
  }
  if (input.mode === "manual") {
    return { mode: "manual" };
  }
  if (input.mode === "interval") {
    if (!Number.isInteger(input.intervalSeconds) || (input.intervalSeconds as number) < 60) {
      throw new ValidationError("rotation.intervalSeconds must be an integer of at least 60");
    }
    return { mode: "interval", intervalSeconds: input.intervalSeconds as number };
  }
  throw new ValidationError("rotation.mode must be per_request, interval, or manual");
}

export function validateRouteProfile(value: unknown): RouteProfile {
  const input = object(value, "route") as unknown as RouteProfileInput;
  const kind = parseKind(input.kind);
  const targeting = parseTargeting(input.targeting);
  const rotation = parseRotation(input.rotation, kind);

  if (targeting.postalCode !== undefined) {
    if (targeting.country !== "US" || !POSTAL_CODE_US.test(targeting.postalCode)) {
      throw new ValidationError("Bright Data ZIP targeting requires country US and a five-digit postalCode");
    }
  }
  if (kind === "mobile" && targeting.country !== "US") {
    throw new ValidationError("Proxidize per-proxy mobile routes currently require country US");
  }

  return {
    name: string(input.name, "name"),
    kind,
    targeting,
    rotation,
  };
}
