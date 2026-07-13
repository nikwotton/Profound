import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ValidationError } from "./errors.js";

export interface AppConfig {
  providerMode: "mock" | "live";
  forwardHost: string;
  forwardPort: number;
  controlHost: string;
  controlPort: number;
  adminToken: string;
  advertisedProxyHost: string;
  sqlitePath: string;
  allowedTargetPorts: Set<number>;
  connectTimeoutMs: number;
  telemetry: {
    serviceName: string;
    serviceVersion: string;
  };
  brightData: {
    host: string;
    port: number;
    customerId: string;
    zone: string;
    password: string;
  };
  proxidize: {
    apiBaseUrl: string;
    apiToken: string;
  };
}

function integer(value: string | undefined, fallback: number, field: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 65_535) {
    throw new ValidationError(`${field} must be an integer from 0 to 65535`);
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const providerMode = env.PROVIDER_MODE ?? "mock";
  if (providerMode !== "mock" && providerMode !== "live") {
    throw new ValidationError("PROVIDER_MODE must be mock or live");
  }

  const sqlitePath = resolve(env.SQLITE_PATH ?? "./data/profound.db");
  mkdirSync(dirname(sqlitePath), { recursive: true });

  const config: AppConfig = {
    providerMode,
    forwardHost: env.FORWARD_PROXY_HOST ?? "127.0.0.1",
    forwardPort: integer(env.FORWARD_PROXY_PORT, 8080, "FORWARD_PROXY_PORT"),
    controlHost: env.CONTROL_API_HOST ?? "127.0.0.1",
    controlPort: integer(env.CONTROL_API_PORT, 8081, "CONTROL_API_PORT"),
    adminToken: env.CONTROL_API_TOKEN ?? "change-me",
    advertisedProxyHost: env.ADVERTISED_PROXY_HOST ?? "127.0.0.1",
    sqlitePath,
    allowedTargetPorts: targetPorts(env.ALLOWED_TARGET_PORTS),
    connectTimeoutMs: integer(env.CONNECT_TIMEOUT_MS, 10_000, "CONNECT_TIMEOUT_MS"),
    telemetry: {
      serviceName: env.OTEL_SERVICE_NAME ?? "profound-proxy-router",
      serviceVersion: "0.1.0",
    },
    brightData: {
      host: env.BRIGHT_DATA_HOST ?? "brd.superproxy.io",
      port: integer(env.BRIGHT_DATA_PORT, 33_335, "BRIGHT_DATA_PORT"),
      customerId: env.BRIGHT_DATA_CUSTOMER_ID ?? "mock-customer",
      zone: env.BRIGHT_DATA_ZONE ?? "residential",
      password: env.BRIGHT_DATA_PASSWORD ?? "mock-bright-password",
    },
    proxidize: {
      apiBaseUrl: env.PROXIDIZE_API_BASE_URL ?? "https://api.proxidize.com",
      apiToken: env.PROXIDIZE_API_TOKEN ?? "mock-proxidize-token",
    },
  };

  if (providerMode === "live") {
    if (!env.BRIGHT_DATA_CUSTOMER_ID || !env.BRIGHT_DATA_ZONE || !env.BRIGHT_DATA_PASSWORD) {
      throw new ValidationError("Live mode requires Bright Data customer, zone, and password credentials");
    }
    if (!env.PROXIDIZE_API_TOKEN) {
      throw new ValidationError("Live mode requires PROXIDIZE_API_TOKEN");
    }
  }
  return config;
}
