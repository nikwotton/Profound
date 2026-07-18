import { HealthAlertCoordinator } from "../alerting.js";
import type { AppConfig } from "../config.js";
import { CapabilityHealthAggregator, CooldownSyntheticValidator, HealthAggregatorServer } from "../health-aggregator.js";
import type { Logger } from "../logger.js";
import { ResourceScope } from "../resource-scope.js";
import { SignedCanaryProbe } from "../signed-canary-probe.js";
import {
  appPersistenceConfig,
  createHealthProviders,
  createStore,
  integer,
  required,
  type RunningService,
  type RuntimeServiceDependencies,
} from "./runtime.js";

export function requireServiceOwnedCapabilityAlerts(env: NodeJS.ProcessEnv = process.env): void {
  const owner = env["HEALTH_ALERT_RULE_OWNER"]?.trim() || "service";
  if (owner !== "service") {
    throw new Error("HEALTH_ALERT_RULE_OWNER must remain service for v0 capability health and recovery alerts");
  }
}

export async function startHealthAggregatorService(
  config: AppConfig,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeServiceDependencies = {},
): Promise<RunningService> {
  const scope = new ResourceScope();
  try {
    const store = createStore(appPersistenceConfig(config), dependencies);
    scope.defer(() => store.close());
    const providerRuntime = await createHealthProviders(config, logger, dependencies);
    scope.defer(() => providerRuntime.stop());
    const canaryUrl = env["HEALTH_CANARY_URL"]?.trim();
    const signingSecret = env["CANARY_SIGNING_SECRET"]?.trim();
    const probe =
      canaryUrl && signingSecret
        ? new SignedCanaryProbe({
            canaryUrl,
            signingSecret,
            ...(env["HEALTH_PROXY_URL"]?.trim() ? { proxyUrl: env["HEALTH_PROXY_URL"].trim() } : {}),
            ...(env["HEALTH_PROXY_USERNAME"]?.trim() ? { proxyUsername: env["HEALTH_PROXY_USERNAME"].trim() } : {}),
            ...(env["HEALTH_PROXY_PASSWORD"]?.trim() ? { proxyPassword: env["HEALTH_PROXY_PASSWORD"].trim() } : {}),
            timeoutMs: integer(env["HEALTH_SYNTHETIC_TIMEOUT_MS"], 10_000, "HEALTH_SYNTHETIC_TIMEOUT_MS"),
          })
        : undefined;
    const syntheticValidator =
      probe === undefined
        ? undefined
        : new CooldownSyntheticValidator(
            (validationScope) => probe.run(validationScope),
            integer(env["HEALTH_SYNTHETIC_COOLDOWN_MS"], 300_000, "HEALTH_SYNTHETIC_COOLDOWN_MS"),
          );
    requireServiceOwnedCapabilityAlerts(env);
    const configuredDestinationIds = (env["HEALTH_ALERT_DESTINATION_IDS"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const alerting = new HealthAlertCoordinator(
      store,
      {
        configurationVersion: env["HEALTH_ALERT_CONFIGURATION_VERSION"]?.trim() || "unconfigured",
        destinationIds: configuredDestinationIds,
        degradedDelayMs: integer(env["HEALTH_ALERT_DEGRADED_DELAY_MS"], 300_000, "HEALTH_ALERT_DEGRADED_DELAY_MS", 0),
      },
      logger,
    );
    const aggregator = new CapabilityHealthAggregator(
      store,
      providerRuntime.providers,
      {
        passiveValidationMaxAgeMs: integer(env["HEALTH_PASSIVE_MAX_AGE_MS"], 300_000, "HEALTH_PASSIVE_MAX_AGE_MS"),
        capacityPressureMaxAgeMs: integer(env["HEALTH_CAPACITY_PRESSURE_MAX_AGE_MS"], 300_000, "HEALTH_CAPACITY_PRESSURE_MAX_AGE_MS"),
        ...(syntheticValidator === undefined ? {} : { syntheticValidator }),
        alerting,
      },
      logger,
    );
    const server = new HealthAggregatorServer(
      aggregator,
      store,
      {
        host: env["HEALTH_AGGREGATOR_HOST"] ?? "127.0.0.1",
        port: integer(env["HEALTH_AGGREGATOR_PORT"], 8082, "HEALTH_AGGREGATOR_PORT", 0),
        token: required(env["HEALTH_AGGREGATOR_TOKEN"], "HEALTH_AGGREGATOR_TOKEN"),
        refreshIntervalMs: integer(env["HEALTH_PROVIDER_REFRESH_MS"], 60_000, "HEALTH_PROVIDER_REFRESH_MS"),
      },
      logger,
    );
    const address = await server.start();
    scope.defer(() => server.stop());
    logger.info("Health aggregator started", { address });
    return scope.service();
  } catch (error) {
    await scope.close().catch(() => undefined);
    throw error;
  }
}
