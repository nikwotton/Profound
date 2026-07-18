import { ValidationError } from "./errors.js";
import type { RetryPolicy, RouteProfile, RouteProfileInput, Targeting } from "./types.js";

const COUNTRY_CODE = /^[A-Za-z]{2}$/;
const PROFILE_FIELDS = new Set(["customerId", "geography", "carrier", "providerOverride", "isTargetAuthenticated", "allowConnectionRetry"]);
const GEOGRAPHY_FIELDS = new Set(["countryCode", "regionCode", "city"]);

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(input: Record<string, unknown>, fields: ReadonlySet<string>, context: string): void {
  const unknown = Object.keys(input).find((key) => !fields.has(key));
  if (unknown !== undefined) throw new ValidationError(`${context}.${unknown} is not part of the profile contract`);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function parseGeography(value: unknown): { profile?: RouteProfileInput["geography"]; targeting: Targeting } {
  if (value === undefined) return { targeting: {} };
  const input = object(value, "geography");
  rejectUnknown(input, GEOGRAPHY_FIELDS, "geography");
  const rawCountry = optionalString(input.countryCode, "geography.countryCode");
  const countryCode = rawCountry?.toUpperCase();
  if (countryCode !== undefined && !COUNTRY_CODE.test(countryCode)) {
    throw new ValidationError("geography.countryCode must be a two-letter ISO country code");
  }
  const regionCode = optionalString(input.regionCode, "geography.regionCode");
  const city = optionalString(input.city, "geography.city");
  const profile = {
    ...(countryCode === undefined ? {} : { countryCode }),
    ...(regionCode === undefined ? {} : { regionCode }),
    ...(city === undefined ? {} : { city }),
  };
  return {
    profile,
    targeting: {
      ...(countryCode === undefined ? {} : { country: countryCode }),
      ...(regionCode === undefined ? {} : { region: regionCode }),
      ...(city === undefined ? {} : { city }),
    },
  };
}

export function validateRouteProfile(value: unknown, userId: string, retryDefaults: RetryPolicy): RouteProfile {
  const input = object(value, "profile");
  rejectUnknown(input, PROFILE_FIELDS, "profile");
  if (typeof input.isTargetAuthenticated !== "boolean") {
    throw new ValidationError("isTargetAuthenticated must be boolean");
  }
  if (typeof input.allowConnectionRetry !== "boolean") {
    throw new ValidationError("allowConnectionRetry must be boolean");
  }

  const { profile: geography, targeting } = parseGeography(input.geography);
  const carrier = optionalString(input.carrier, "carrier");
  const providerOverride = (() => {
    if (input.providerOverride === undefined || input.providerOverride === null) return undefined;
    const provider = string(input.providerOverride, "providerOverride");
    if (provider !== "bright_data" && provider !== "proxidize") {
      throw new ValidationError("providerOverride must be bright_data, proxidize, or null");
    }
    return provider;
  })();
  if (input.isTargetAuthenticated && (geography?.countryCode === undefined || geography.city === undefined)) {
    throw new ValidationError("geography.countryCode and geography.city are required when isTargetAuthenticated is true");
  }
  if (carrier !== undefined) targeting.carrier = carrier;

  const isTargetAuthenticated = input.isTargetAuthenticated;
  const allowConnectionRetry = input.allowConnectionRetry;
  return {
    name: string(input.customerId, "customerId"),
    customerId: string(input.customerId, "customerId"),
    ...(geography === undefined ? {} : { geography }),
    ...(carrier === undefined ? {} : { carrier }),
    ...(providerOverride === undefined ? {} : { providerOverride }),
    isTargetAuthenticated,
    allowConnectionRetry,
    userId: string(userId, "userId"),
    allowedProtocols: ["http", "https", "socks5"],
    targeting,
    rotation: isTargetAuthenticated ? { mode: "manual" } : { mode: "per_request" },
    session: isTargetAuthenticated
      ? { mode: "sticky", requireGeographicContinuity: true }
      : { mode: "none", requireGeographicContinuity: false },
    isAuthenticated: isTargetAuthenticated,
    shouldRetry: allowConnectionRetry,
    retryPolicy: retryDefaults,
  };
}
