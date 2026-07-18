import { ParseResult, Schema } from "effect";
import { ValidationError } from "./errors.js";
import { RouteProfilePayload } from "./route-profile-schema.js";
import type { DecodedRouteProfilePayload } from "./route-profile-schema.js";
import type { RetryPolicy, RouteProfile, RouteProfileInput, Targeting } from "./types.js";

const COUNTRY_CODE = /^[A-Za-z]{2}$/;

function routeProfileContractError(error: ParseResult.ParseError): ValidationError {
  const issues = ParseResult.ArrayFormatter.formatIssueSync(error.issue);
  const first = issues[0];
  const path = first?.path.map(String) ?? [];
  if (path.length === 1 && path[0] === "providerOverride") {
    return new ValidationError("providerOverride must be bright_data, proxidize, or null");
  }
  if (first?._tag === "Unexpected" && path.length > 0) {
    const field = path.length === 1 ? `profile.${path[0]}` : path.join(".");
    return new ValidationError(`${field} is not part of the profile contract`);
  }
  const field = path.length === 0 ? "profile" : path.length === 1 ? `profile.${path[0]}` : path.join(".");
  return new ValidationError(`${field} does not match the route profile contract`);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function parseGeography(value: DecodedRouteProfilePayload["geography"]): {
  profile?: RouteProfileInput["geography"];
  targeting: Targeting;
} {
  if (value === undefined) return { targeting: {} };
  const rawCountry = optionalString(value.countryCode, "geography.countryCode");
  const countryCode = rawCountry?.toUpperCase();
  if (countryCode !== undefined && !COUNTRY_CODE.test(countryCode)) {
    throw new ValidationError("geography.countryCode must be a two-letter ISO country code");
  }
  const regionCode = optionalString(value.regionCode, "geography.regionCode");
  const city = optionalString(value.city, "geography.city");
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
  const decoded = Schema.decodeUnknownEither(RouteProfilePayload)(value);
  if (decoded._tag === "Left") throw routeProfileContractError(decoded.left);
  const input: DecodedRouteProfilePayload = decoded.right;

  const { profile: geography, targeting } = parseGeography(input.geography);
  const carrier = optionalString(input.carrier, "carrier");
  const providerOverride = input.providerOverride ?? undefined;
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
