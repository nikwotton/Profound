import type { AppConfig } from "./config.js";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { HealthAlertCoordinator, parseHealthAlertDestinationConfig, WebhookNotificationAdapter } from "./alerting.js";
import { DynamoRouteStore } from "./dynamo-store.js";
import { CapabilityHealthAggregator, CooldownSyntheticValidator, HealthAggregatorServer } from "./health-aggregator.js";
import { LocalGeoIpResolver, MaxMindGeoLiteUpdater } from "./geoip.js";
import { IntegrationTargetServer } from "./integration-target.js";
import type { Logger } from "./logger.js";
import { closeServer, listen } from "./net-utils.js";
import { BrightDataAdapter } from "./providers/bright-data.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { ProxidizeAdapter } from "./providers/proxidize.js";
import { PublicCanaryServer } from "./public-canary.js";
import { SignedCanaryProbe } from "./signed-canary-probe.js";
import { BrightDataSimulator } from "./simulators/bright-data.js";
import { ProxidizeSimulator } from "./simulators/proxidize.js";
import { SqliteRouteStore, type RouteStore } from "./store.js";
import { StatusApplicationServer } from "./status-app.js";
import {
  decodeProviderCostTotal,
  decodeProvisionedProxySlotCapacity,
  provisionedProxySlotCapacityRecord,
  UsageAccountingWorker,
  type UsageVarianceThresholds,
} from "./usage-accounting.js";
import { expectArray, expectRecord, parseJson } from "./decoding.js";

export interface RunningService {
  stop(): Promise<void>;
}

export async function startIntegrationTargetService(logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<RunningService> {
  if (env.NODE_ENV === "production" && env.ALLOW_INTEGRATION_TARGET !== "true") {
    throw new Error("The integration target requires ALLOW_INTEGRATION_TARGET=true");
  }
  const server = new IntegrationTargetServer(
    {
      host: env.INTEGRATION_TARGET_HOST ?? "127.0.0.1",
      port: integer(env.INTEGRATION_TARGET_PORT, 8091, "INTEGRATION_TARGET_PORT", 0),
    },
    logger,
  );
  const address = await server.start();
  logger.info("Integration target started", { address });
  return { stop: () => server.stop() };
}

function integer(value: string | undefined, fallback: number, name: string, minimum = 1): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
  return parsed;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function nonnegativeNumber(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function createStore(config: AppConfig): RouteStore {
  if (config.persistenceBackend === "dynamodb") {
    if (config.routeTableName === undefined) throw new Error("DynamoDB route table name is missing");
    return new DynamoRouteStore(config.routeTableName);
  }
  return new SqliteRouteStore(config.sqlitePath);
}

async function createHealthProviders(config: AppConfig, logger: Logger): Promise<{ providers: ProviderAdapter[]; stop(): Promise<void> }> {
  let brightConfig = config.brightData;
  let proxidizeConfig = config.proxidize;
  let brightSimulator: BrightDataSimulator | undefined;
  let proxidizeSimulator: ProxidizeSimulator | undefined;
  if (config.providerMode === "mock") {
    brightSimulator = new BrightDataSimulator({
      host: "127.0.0.1",
      port: 0,
      customerId: config.brightData.customerId,
      zone: config.brightData.zone,
      password: config.brightData.password,
      logger,
    });
    proxidizeSimulator = new ProxidizeSimulator({
      host: "127.0.0.1",
      controlPort: 0,
      dataPort: 0,
      apiToken: config.proxidize.apiToken,
      logger,
    });
    const [brightAddress, proxidizeAddress] = await Promise.all([brightSimulator.start(), proxidizeSimulator.start()]);
    brightConfig = { ...brightConfig, host: brightAddress.host, port: brightAddress.port };
    proxidizeConfig = {
      ...proxidizeConfig,
      apiBaseUrl: `http://${proxidizeAddress.control.host}:${proxidizeAddress.control.port}`,
    };
  }
  const providers: ProviderAdapter[] = [
    new BrightDataAdapter({ ...brightConfig, connectTimeoutMs: config.attemptEstablishmentTimeoutMs }),
    new ProxidizeAdapter({
      ...proxidizeConfig,
      requestTimeoutMs: config.attemptEstablishmentTimeoutMs,
      exactCity: config.proxidizeExactCity,
    }),
  ];
  return {
    providers,
    stop: async () => {
      await Promise.allSettled([
        ...(brightSimulator === undefined ? [] : [brightSimulator.stop()]),
        ...(proxidizeSimulator === undefined ? [] : [proxidizeSimulator.stop()]),
      ]);
    },
  };
}

export function requireServiceOwnedCapabilityAlerts(env: NodeJS.ProcessEnv = process.env): void {
  const owner = env.HEALTH_ALERT_RULE_OWNER?.trim() || "service";
  if (owner !== "service") {
    throw new Error("HEALTH_ALERT_RULE_OWNER must remain service for v0 capability health and recovery alerts");
  }
}

export async function startHealthAggregatorService(
  config: AppConfig,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunningService> {
  const store = createStore(config);
  const providerRuntime = await createHealthProviders(config, logger);
  const canaryUrl = env.HEALTH_CANARY_URL?.trim();
  const signingSecret = env.CANARY_SIGNING_SECRET?.trim();
  const probe =
    canaryUrl && signingSecret
      ? new SignedCanaryProbe({
          canaryUrl,
          signingSecret,
          ...(env.HEALTH_PROXY_URL?.trim() ? { proxyUrl: env.HEALTH_PROXY_URL.trim() } : {}),
          ...(env.HEALTH_PROXY_USERNAME?.trim() ? { proxyUsername: env.HEALTH_PROXY_USERNAME.trim() } : {}),
          ...(env.HEALTH_PROXY_PASSWORD?.trim() ? { proxyPassword: env.HEALTH_PROXY_PASSWORD.trim() } : {}),
          timeoutMs: integer(env.HEALTH_SYNTHETIC_TIMEOUT_MS, 10_000, "HEALTH_SYNTHETIC_TIMEOUT_MS"),
        })
      : undefined;
  const syntheticValidator =
    probe === undefined
      ? undefined
      : new CooldownSyntheticValidator(
          (scope) => probe.run(scope),
          integer(env.HEALTH_SYNTHETIC_COOLDOWN_MS, 300_000, "HEALTH_SYNTHETIC_COOLDOWN_MS"),
        );
  requireServiceOwnedCapabilityAlerts(env);
  const configuredDestinationIds = (env.HEALTH_ALERT_DESTINATION_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const alerting = new HealthAlertCoordinator(
    store,
    {
      configurationVersion: env.HEALTH_ALERT_CONFIGURATION_VERSION?.trim() || "unconfigured",
      destinationIds: configuredDestinationIds,
      degradedDelayMs: integer(env.HEALTH_ALERT_DEGRADED_DELAY_MS, 300_000, "HEALTH_ALERT_DEGRADED_DELAY_MS", 0),
    },
    logger,
  );
  const aggregator = new CapabilityHealthAggregator(
    store,
    providerRuntime.providers,
    {
      passiveValidationMaxAgeMs: integer(env.HEALTH_PASSIVE_MAX_AGE_MS, 300_000, "HEALTH_PASSIVE_MAX_AGE_MS"),
      ...(syntheticValidator === undefined ? {} : { syntheticValidator }),
      alerting,
    },
    logger,
  );
  const server = new HealthAggregatorServer(
    aggregator,
    store,
    {
      host: env.HEALTH_AGGREGATOR_HOST ?? "127.0.0.1",
      port: integer(env.HEALTH_AGGREGATOR_PORT, 8082, "HEALTH_AGGREGATOR_PORT", 0),
      token: required(env.HEALTH_AGGREGATOR_TOKEN, "HEALTH_AGGREGATOR_TOKEN"),
      refreshIntervalMs: integer(env.HEALTH_PROVIDER_REFRESH_MS, 60_000, "HEALTH_PROVIDER_REFRESH_MS"),
    },
    logger,
  );
  try {
    const address = await server.start();
    logger.info("Health aggregator started", { address });
    return {
      stop: async () => {
        await server.stop();
        await providerRuntime.stop();
        await store.close();
      },
    };
  } catch (error) {
    await providerRuntime.stop();
    await store.close();
    throw error;
  }
}

export async function startNotificationService(logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<RunningService> {
  const backend = env.PERSISTENCE_BACKEND ?? "sqlite";
  let store: RouteStore;
  if (backend === "dynamodb") {
    store = new DynamoRouteStore(required(env.ROUTE_TABLE_NAME, "ROUTE_TABLE_NAME"));
  } else if (backend === "sqlite") {
    const path = resolve(env.SQLITE_PATH ?? "./data/profound.db");
    mkdirSync(dirname(path), { recursive: true });
    store = new SqliteRouteStore(path);
  } else {
    throw new Error("PERSISTENCE_BACKEND must be sqlite or dynamodb");
  }
  const config = parseHealthAlertDestinationConfig(env.HEALTH_ALERT_DESTINATIONS_JSON);
  const notifier = new WebhookNotificationAdapter(
    store,
    config.destinations,
    {
      timeoutMs: integer(env.HEALTH_ALERT_WEBHOOK_TIMEOUT_MS, 5_000, "HEALTH_ALERT_WEBHOOK_TIMEOUT_MS"),
      maxAttempts: integer(env.HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS, 5, "HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS"),
      initialBackoffMs: integer(env.HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS, 1_000, "HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS"),
    },
    logger,
  );
  const intervalMs = integer(env.NOTIFICATION_POLL_INTERVAL_MS, 5_000, "NOTIFICATION_POLL_INTERVAL_MS");
  let lastError: string | undefined;
  let running = false;
  const flush = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await notifier.flush();
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown";
      logger.error("Notification delivery poll failed", {
        "event.name": "profound.health.notification_poll_failure",
        error: lastError,
      });
    } finally {
      running = false;
    }
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://notification.local").pathname;
    if (request.method === "GET" && path === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "live" }));
      return;
    }
    if (request.method === "GET" && path === "/health/ready") {
      response.writeHead(lastError === undefined ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify(lastError === undefined ? { status: "ready" } : { status: "failed" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  try {
    const address = await listen(
      server,
      env.NOTIFICATION_HOST ?? "127.0.0.1",
      integer(env.NOTIFICATION_PORT, 8084, "NOTIFICATION_PORT", 0),
    );
    await flush();
    const timer = setInterval(() => void flush(), intervalMs);
    timer.unref();
    logger.info("Notification service started", { address, configurationVersion: config.version });
    return {
      stop: async () => {
        clearInterval(timer);
        await closeServer(server);
        await store.close();
      },
    };
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    await store.close();
    throw error;
  }
}

export async function startStatusApplicationService(logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<RunningService> {
  const backend = env.PERSISTENCE_BACKEND ?? "sqlite";
  let store: RouteStore;
  if (backend === "dynamodb") {
    store = new DynamoRouteStore(required(env.ROUTE_TABLE_NAME, "ROUTE_TABLE_NAME"));
  } else if (backend === "sqlite") {
    const path = resolve(env.SQLITE_PATH ?? "./data/profound.db");
    mkdirSync(dirname(path), { recursive: true });
    store = new SqliteRouteStore(path);
  } else {
    throw new Error("PERSISTENCE_BACKEND must be sqlite or dynamodb");
  }
  const server = new StatusApplicationServer(
    store,
    {
      host: env.STATUS_APP_HOST ?? "127.0.0.1",
      port: integer(env.STATUS_APP_PORT, 8083, "STATUS_APP_PORT", 0),
      staleAfterMs: integer(env.STATUS_STALE_AFTER_MS, 300_000, "STATUS_STALE_AFTER_MS"),
      historyLimit: integer(env.STATUS_HISTORY_LIMIT, 100, "STATUS_HISTORY_LIMIT"),
      ...(env.HEALTH_AGGREGATOR_URL?.trim() ? { healthAggregatorUrl: env.HEALTH_AGGREGATOR_URL.trim() } : {}),
      ...(env.HEALTH_AGGREGATOR_TOKEN?.trim() ? { healthAggregatorToken: env.HEALTH_AGGREGATOR_TOKEN.trim() } : {}),
    },
    logger,
  );
  try {
    const address = await server.start();
    logger.info("Status application started", { address });
    return {
      stop: async () => {
        await server.stop();
        await store.close();
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}

function jsonArray<T>(value: string | undefined, name: string, decode: (value: unknown, context: string) => T): T[] {
  if (value?.trim() === undefined || value.trim() === "") return [];
  return expectArray(parseJson(value, name), name).map((item, index) => decode(item, `${name}[${index}]`));
}

export async function startUsageAccountingService(logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<RunningService> {
  const backend = env.PERSISTENCE_BACKEND ?? "sqlite";
  let store: RouteStore;
  if (backend === "dynamodb") store = new DynamoRouteStore(required(env.ROUTE_TABLE_NAME, "ROUTE_TABLE_NAME"));
  else if (backend === "sqlite") {
    const path = resolve(env.SQLITE_PATH ?? "./data/profound.db");
    mkdirSync(dirname(path), { recursive: true });
    store = new SqliteRouteStore(path);
  } else throw new Error("PERSISTENCE_BACKEND must be sqlite or dynamodb");

  let providerTotals = jsonArray(env.PROVIDER_COST_TOTALS_JSON, "PROVIDER_COST_TOTALS_JSON", decodeProviderCostTotal);
  let capacity = jsonArray(
    env.PROVISIONED_PROXY_SLOT_CAPACITY_JSON,
    "PROVISIONED_PROXY_SLOT_CAPACITY_JSON",
    decodeProvisionedProxySlotCapacity,
  );
  const sourceUrl = env.USAGE_ACCOUNTING_SOURCE_URL?.trim() || undefined;
  const thresholds: UsageVarianceThresholds = {
    absoluteFloorUsd: nonnegativeNumber(env.USAGE_VARIANCE_ABSOLUTE_FLOOR_USD, 1, "USAGE_VARIANCE_ABSOLUTE_FLOOR_USD"),
    warningRelative: nonnegativeNumber(env.USAGE_VARIANCE_WARNING_RELATIVE, 0.05, "USAGE_VARIANCE_WARNING_RELATIVE"),
    errorRelative: nonnegativeNumber(env.USAGE_VARIANCE_ERROR_RELATIVE, 0.15, "USAGE_VARIANCE_ERROR_RELATIVE"),
  };
  const worker = new UsageAccountingWorker(
    store,
    () => providerTotals,
    thresholds,
    (record) => {
      const attributes = {
        "event.name": "profound.usage.reconciliation_variance",
        provider: record.provider,
        periodStartedAt: record.periodStartedAt,
        periodEndsAt: record.periodEndsAt,
        estimatedTotalUsd: record.estimatedTotalUsd,
        reportedTotalUsd: record.reportedTotalUsd,
        varianceUsd: record.varianceUsd,
        relativeVariance: record.relativeVariance,
        varianceAttribution: record.varianceAttribution,
        severity: record.severity,
      };
      if (record.severity === "error") logger.error("Usage reconciliation variance is severe or repeated", attributes);
      else if (record.severity === "warning") logger.warn("Usage reconciliation variance exceeded a warning threshold", attributes);
      else logger.info("Usage reconciliation completed", attributes);
    },
    (rollup) => {
      const attributes = {
        "event.name": "profound.usage.capacity_pressure",
        periodStartedAt: rollup.periodStartedAt,
        periodEndsAt: rollup.periodEndsAt,
        provisionedSlots: rollup.provisionedSlots,
        peakConcurrentConnections: rollup.peakConcurrentConnections,
        p95ConcurrentConnections: rollup.p95ConcurrentConnections,
        concurrencyUtilization: rollup.concurrencyUtilization,
        throughputUtilization: rollup.throughputUtilization,
        capacityDrivenFallbackCount: rollup.capacityDrivenFallbackCount,
        capacityFailureCount: rollup.capacityFailureCount,
        capacityWaitMs: rollup.capacityWaitMs,
        capacityConstraint: rollup.capacityConstraint,
        capacityPolicyVersion: rollup.capacityPolicyVersion,
      };
      if (rollup.capacityFailureCount > 0) logger.error("Proxy-slot capacity caused connection failures", attributes);
      else logger.warn("Proxy-slot capacity pressure exceeded policy", attributes);
    },
  );
  const intervalMs = integer(env.USAGE_ACCOUNTING_INTERVAL_MS, 60_000, "USAGE_ACCOUNTING_INTERVAL_MS", 1_000);
  let lastError: string | undefined;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      if (sourceUrl !== undefined) {
        const response = await fetch(sourceUrl, {
          headers: env.USAGE_ACCOUNTING_SOURCE_TOKEN?.trim() ? { authorization: `Bearer ${env.USAGE_ACCOUNTING_SOURCE_TOKEN.trim()}` } : {},
          signal: AbortSignal.timeout(integer(env.USAGE_ACCOUNTING_SOURCE_TIMEOUT_MS, 10_000, "USAGE_ACCOUNTING_SOURCE_TIMEOUT_MS")),
        });
        if (!response.ok) throw new Error(`usage_accounting_source_${response.status}`);
        const published = expectRecord(await response.json(), "usage-accounting source response");
        if (published.providerTotals !== undefined) {
          providerTotals = expectArray(published.providerTotals, "usage-accounting source response.providerTotals").map((item, index) =>
            decodeProviderCostTotal(item, `usage-accounting source response.providerTotals[${index}]`),
          );
        }
        if (published.provisionedProxySlotCapacity !== undefined) {
          capacity = expectArray(
            published.provisionedProxySlotCapacity,
            "usage-accounting source response.provisionedProxySlotCapacity",
          ).map((item, index) =>
            decodeProvisionedProxySlotCapacity(item, `usage-accounting source response.provisionedProxySlotCapacity[${index}]`),
          );
        }
      }
      for (const item of capacity) await store.recordUsage(provisionedProxySlotCapacityRecord(item));
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 32 * 86_400_000).toISOString();
      const rollupCount = await worker.run(from, to);
      lastError = undefined;
      logger.info("Usage accounting rollups completed", {
        rollupCount,
        costTotals: providerTotals.length,
        provisionedProxySlots: capacity.length,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown";
      logger.error("Usage accounting rollups failed", { error: lastError });
    } finally {
      running = false;
    }
  };
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "live" }));
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      response.writeHead(lastError === undefined ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify(lastError === undefined ? { status: "ready" } : { status: "failed" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  try {
    const address = await listen(
      server,
      env.USAGE_ACCOUNTING_HOST ?? "127.0.0.1",
      integer(env.USAGE_ACCOUNTING_PORT, 8085, "USAGE_ACCOUNTING_PORT", 0),
    );
    await run();
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref();
    logger.info("Usage accounting service started", { address });
    return {
      stop: async () => {
        clearInterval(timer);
        await closeServer(server);
        await store.close();
      },
    };
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    await store.close();
    throw error;
  }
}

export async function startPublicCanaryService(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
  securityLogger: Logger = logger,
): Promise<RunningService> {
  const accountId = env.MAXMIND_ACCOUNT_ID?.trim() || undefined;
  const licenseKey = env.MAXMIND_LICENSE_KEY?.trim() || undefined;
  if ((accountId === undefined) !== (licenseKey === undefined)) {
    throw new Error("MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY must be configured together");
  }
  const databasePath = resolve(env.GEOIP_DATABASE_PATH ?? "./data/GeoLite2-City.mmdb");
  const geoIp = new LocalGeoIpResolver(
    {
      databasePath,
      maximumAccuracyRadiusKm: integer(env.GEOIP_MAX_ACCURACY_RADIUS_KM, 100, "GEOIP_MAX_ACCURACY_RADIUS_KM"),
    },
    logger,
  );
  await geoIp.load();
  const updater =
    accountId === undefined || licenseKey === undefined
      ? undefined
      : new MaxMindGeoLiteUpdater(
          geoIp,
          {
            accountId,
            licenseKey,
            intervalMs: integer(env.GEOIP_UPDATE_INTERVAL_MS, 302_400_000, "GEOIP_UPDATE_INTERVAL_MS"),
          },
          logger,
        );
  if (updater !== undefined) {
    try {
      await updater.refresh();
    } catch (error) {
      logger.warn("Initial GeoIP dataset refresh failed", {
        "event.name": "profound.geoip.initial_refresh_failure",
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    updater.start();
  }
  const server = new PublicCanaryServer(
    {
      host: env.CANARY_HOST ?? "127.0.0.1",
      port: integer(env.CANARY_PORT, 8090, "CANARY_PORT", 0),
      signingSecret: required(env.CANARY_SIGNING_SECRET, "CANARY_SIGNING_SECRET"),
      trustedProxyCidrs: (env.CANARY_TRUSTED_PROXY_CIDRS ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
      requestsPerMinute: integer(env.CANARY_REQUESTS_PER_MINUTE, 60, "CANARY_REQUESTS_PER_MINUTE"),
    },
    securityLogger,
    geoIp,
  );
  try {
    const address = await server.start();
    logger.info("Public canary started", {
      address,
      geoDataset: geoIp.dataset ?? "unavailable",
    });
    return {
      stop: async () => {
        updater?.stop();
        await server.stop();
      },
    };
  } catch (error) {
    updater?.stop();
    throw error;
  }
}
