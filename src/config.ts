import { isIP } from "node:net";
import { isUnknownRecord } from "./decoding.js";
import { ValidationError } from "./errors.js";

export interface AppConfig {
  providerMode: "mock" | "live";
  forwardHost: string;
  forwardPort: number;
  socks5Host: string;
  socks5Port: number;
  controlHost: string;
  controlPort: number;
  adminToken: string;
  adminUserId: string;
  controlIdentities: ReadonlyMap<string, string>;
  advertisedProxyHost: string;
  advertisedHttpProxyProtocol: "http" | "https";
  routeTableName: string;
  deploymentId: string;
  allowedTargetPorts: Set<number>;
  attemptEstablishmentTimeoutMs: number;
  operationEstablishmentTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxHeaderBytes: number;
  maxHttpRequestBodyBytes: number;
  maxHttpResponseBodyBytes: number;
  retryDefaults: { maxAttempts: number };
  proxidizeExactCity: "provider_guaranteed" | "verifiable" | "unsupported";
  telemetry: { serviceName: string; serviceVersion: string };
  brightData: {
    host: string;
    port: number;
    customerId: string;
    zone: string;
    password: string;
    statusApiUrl?: string;
    apiKey?: string;
  };
  proxidize: { apiBaseUrl: string; apiToken: string };
}

function integer(value: string | undefined, fallback: number, field: string, minimum = 0, maximum = 65_535): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new ValidationError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function targetPorts(value: string | undefined): Set<number> {
  const parts = (value ?? "80,443").split(",").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isInteger(part) || part < 1 || part > 65_535)) {
    throw new ValidationError("ALLOWED_TARGET_PORTS must contain comma-separated TCP ports");
  }
  return new Set(parts);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

function exactCitySupport(value: string): AppConfig["proxidizeExactCity"] {
  if (value === "provider_guaranteed" || value === "verifiable" || value === "unsupported") return value;
  throw new ValidationError("PROXIDIZE_EXACT_CITY_SUPPORT must be provider_guaranteed, verifiable, or unsupported");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const providerMode = env["PROVIDER_MODE"] ?? "mock";
  if (providerMode !== "mock" && providerMode !== "live") throw new ValidationError("PROVIDER_MODE must be mock or live");
  const routeTableName = env["ROUTE_TABLE_NAME"]?.trim();
  if (!routeTableName) throw new ValidationError("ROUTE_TABLE_NAME is required");
  const advertisedHttpProxyProtocol = env["ADVERTISED_HTTP_PROXY_PROTOCOL"] ?? "http";
  if (advertisedHttpProxyProtocol !== "http" && advertisedHttpProxyProtocol !== "https") {
    throw new ValidationError("ADVERTISED_HTTP_PROXY_PROTOCOL must be http or https");
  }
  const controlHost = env["CONTROL_API_HOST"] ?? "127.0.0.1";
  const proxidizeExactCity = exactCitySupport(
    env["PROXIDIZE_EXACT_CITY_SUPPORT"] ?? (providerMode === "mock" ? "provider_guaranteed" : "verifiable"),
  );
  const adminToken = env["CONTROL_API_TOKEN"]?.trim() || "change-me";
  const adminUserId = env["CONTROL_API_USER_ID"]?.trim() || "local-dev";
  let controlIdentities: ReadonlyMap<string, string> = new Map([[adminToken, adminUserId]]);
  if (env["CONTROL_API_IDENTITIES_JSON"] !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env["CONTROL_API_IDENTITIES_JSON"]);
    } catch {
      throw new ValidationError("CONTROL_API_IDENTITIES_JSON must map bearer tokens to trusted user IDs");
    }
    if (!isUnknownRecord(parsed)) {
      throw new ValidationError("CONTROL_API_IDENTITIES_JSON must map bearer tokens to trusted user IDs");
    }
    const identities = new Map<string, string>();
    for (const [token, user] of Object.entries(parsed)) {
      if (token.trim() === "" || typeof user !== "string" || user.trim() === "") {
        throw new ValidationError("CONTROL_API_IDENTITIES_JSON requires non-empty token and user ID strings");
      }
      identities.set(token, user.trim());
    }
    if (identities.size === 0) {
      throw new ValidationError("CONTROL_API_IDENTITIES_JSON requires non-empty token and user ID strings");
    }
    controlIdentities = identities;
  }
  if (
    env["CONTROL_API_DISABLED"] !== "true" &&
    (providerMode === "live" || !isLoopbackHost(controlHost)) &&
    controlIdentities.has("change-me")
  ) {
    throw new ValidationError(
      "CONTROL_API_TOKEN must be set to a non-placeholder value in live mode or when CONTROL_API_HOST is not loopback",
    );
  }
  if (adminUserId === "") throw new ValidationError("CONTROL_API_USER_ID must be a non-empty trusted user identifier");

  const config: AppConfig = {
    providerMode,
    forwardHost: env["FORWARD_PROXY_HOST"] ?? "127.0.0.1",
    forwardPort: integer(env["FORWARD_PROXY_PORT"], 8080, "FORWARD_PROXY_PORT"),
    socks5Host: env["SOCKS5_PROXY_HOST"] ?? "127.0.0.1",
    socks5Port: integer(env["SOCKS5_PROXY_PORT"], 1080, "SOCKS5_PROXY_PORT"),
    controlHost,
    controlPort: integer(env["CONTROL_API_PORT"], 8081, "CONTROL_API_PORT"),
    adminToken,
    adminUserId,
    controlIdentities,
    advertisedProxyHost: env["ADVERTISED_PROXY_HOST"] ?? "127.0.0.1",
    advertisedHttpProxyProtocol,
    routeTableName,
    deploymentId: env["DEPLOYMENT_ID"]?.trim() || "local",
    allowedTargetPorts: targetPorts(env["ALLOWED_TARGET_PORTS"]),
    attemptEstablishmentTimeoutMs: integer(env["CONNECT_TIMEOUT_MS"], 10_000, "CONNECT_TIMEOUT_MS", 1, 10_000),
    operationEstablishmentTimeoutMs: integer(env["OPERATION_TIMEOUT_MS"], 30_000, "OPERATION_TIMEOUT_MS", 1, 30_000),
    streamIdleTimeoutMs: integer(env["STREAM_IDLE_TIMEOUT_MS"], 60_000, "STREAM_IDLE_TIMEOUT_MS", 1, 3_600_000),
    maxHeaderBytes: integer(env["MAX_HEADER_BYTES"], 32 * 1024, "MAX_HEADER_BYTES", 1_024, 1_048_576),
    maxHttpRequestBodyBytes: integer(env["MAX_HTTP_REQUEST_BODY_BYTES"], 10 * 1024 * 1024, "MAX_HTTP_REQUEST_BODY_BYTES", 1, 1_073_741_824),
    maxHttpResponseBodyBytes: integer(
      env["MAX_HTTP_RESPONSE_BODY_BYTES"],
      50 * 1024 * 1024,
      "MAX_HTTP_RESPONSE_BODY_BYTES",
      1,
      1_073_741_824,
    ),
    retryDefaults: {
      maxAttempts: integer(env["RETRY_MAX_ATTEMPTS"], 4, "RETRY_MAX_ATTEMPTS", 1, 6),
    },
    proxidizeExactCity,
    telemetry: { serviceName: env["OTEL_SERVICE_NAME"] ?? "profound-proxy-router", serviceVersion: "0.3.0" },
    brightData: {
      host: env["BRIGHT_DATA_HOST"] ?? "brd.superproxy.io",
      port: integer(env["BRIGHT_DATA_PORT"], 33_335, "BRIGHT_DATA_PORT", 1),
      customerId: env["BRIGHT_DATA_CUSTOMER_ID"] ?? "mock-customer",
      zone: env["BRIGHT_DATA_ZONE"] ?? "residential",
      password: env["BRIGHT_DATA_PASSWORD"] ?? "mock-bright-password",
      ...(env["BRIGHT_DATA_API_KEY"]?.trim()
        ? {
            apiKey: env["BRIGHT_DATA_API_KEY"].trim(),
            statusApiUrl: env["BRIGHT_DATA_STATUS_API_URL"] ?? "https://api.brightdata.com/network_status/res",
          }
        : {}),
    },
    proxidize: {
      apiBaseUrl: env["PROXIDIZE_API_BASE_URL"] ?? "https://api.proxidize.com",
      apiToken: env["PROXIDIZE_API_TOKEN"] ?? "mock-proxidize-token",
    },
  };
  if (providerMode === "live") {
    if (!env["BRIGHT_DATA_CUSTOMER_ID"] || !env["BRIGHT_DATA_ZONE"] || !env["BRIGHT_DATA_PASSWORD"] || !env["BRIGHT_DATA_API_KEY"]) {
      throw new ValidationError("Live mode requires Bright Data customer, zone, password, and API key credentials");
    }
    if (!env["PROXIDIZE_API_TOKEN"]) throw new ValidationError("Live mode requires PROXIDIZE_API_TOKEN");
  }
  return config;
}
