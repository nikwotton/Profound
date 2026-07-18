import { isIP } from "node:net";
import { startStandaloneApplication, type RunningApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { AppError } from "./errors.js";
import { InMemoryRouteStore } from "./in-memory-route-store.js";
import { createLogger, type Logger } from "./logger.js";
import type { RouteStore } from "./store.js";
import { createTargetValidator, type TargetValidator } from "./target-security.js";
import { Telemetry } from "./telemetry.js";

export const LOCAL_CONTROL_TOKEN = "change-me";

export interface LocalRuntimeOptions {
  forwardPort?: number;
  socks5Port?: number;
  controlPort?: number;
  allowedTargetPorts?: readonly number[];
  logger?: Logger;
}

export interface RunningLocalApplication extends RunningApplication {
  readonly controlToken: typeof LOCAL_CONTROL_TOKEN;
  readonly persistence: "memory";
  readonly store: RouteStore;
}

function localTargetValidator(allowedPorts: ReadonlySet<number>): TargetValidator {
  const publicTargetValidator = createTargetValidator(allowedPorts);
  return (rawHost, port, signal) => {
    if (!allowedPorts.has(port)) throw new AppError("Target port is not allowed", "target_port_forbidden", 403);
    const host = rawHost
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/\.$/, "");
    const loopback = host === "localhost" || host.endsWith(".localhost") || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
    if (loopback) {
      return { localResolution: Promise.resolve({ status: "available", addresses: [host] }) };
    }
    return publicTargetValidator(rawHost, port, signal);
  };
}

/**
 * Starts the real proxy and control servers in one process with ephemeral
 * persistence and provider simulators. No environment configuration, cloud
 * resources, telemetry exporter, or vendor credentials are read.
 */
export async function startLocalRuntime(options: LocalRuntimeOptions = {}): Promise<RunningLocalApplication> {
  const allowedTargetPorts = new Set(options.allowedTargetPorts ?? [80, 443]);
  const logger = options.logger ?? createLogger({ instrumentationScope: "profound-proxy-local" });
  const telemetry = new Telemetry({
    serviceName: "profound-proxy-local",
    serviceVersion: "0.6.0",
    environment: { OTEL_SDK_DISABLED: "true" },
  });
  const config = loadConfig({
    PROVIDER_MODE: "mock",
    FORWARD_PROXY_HOST: "127.0.0.1",
    FORWARD_PROXY_PORT: String(options.forwardPort ?? 8080),
    SOCKS5_PROXY_HOST: "127.0.0.1",
    SOCKS5_PROXY_PORT: String(options.socks5Port ?? 1080),
    CONTROL_API_HOST: "127.0.0.1",
    CONTROL_API_PORT: String(options.controlPort ?? 8081),
    CONTROL_API_TOKEN: LOCAL_CONTROL_TOKEN,
    CONTROL_API_USER_ID: "local-reviewer",
    ADVERTISED_PROXY_HOST: "127.0.0.1",
    ROUTE_TABLE_NAME: "local-memory",
    DEPLOYMENT_ID: "local",
    ALLOWED_TARGET_PORTS: [...allowedTargetPorts].join(","),
  });

  let store: InMemoryRouteStore | undefined;
  try {
    const application = await startStandaloneApplication(config, logger, {
      telemetry,
      storeFactory: () => {
        store = new InMemoryRouteStore();
        return store;
      },
      targetValidator: localTargetValidator(allowedTargetPorts),
    });
    if (store === undefined) throw new Error("Local in-memory store was not initialized");
    let stopped = false;
    return {
      ...application,
      controlToken: LOCAL_CONTROL_TOKEN,
      persistence: "memory",
      store,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await application.stop();
        await telemetry.shutdown();
      },
    };
  } catch (error) {
    await telemetry.shutdown();
    throw error;
  }
}
