import { resolve } from "node:path";
import { LocalGeoIpResolver, MaxMindGeoLiteUpdater } from "../geoip.js";
import type { Logger } from "../logger.js";
import { PublicCanaryServer } from "../public-canary.js";
import { ResourceScope } from "../resource-scope.js";
import { integer, required, type RunningService, type RuntimeServiceDependencies } from "./runtime.js";

export async function startPublicCanaryService(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
  securityLogger: Logger = logger,
  dependencies: RuntimeServiceDependencies = {},
): Promise<RunningService> {
  const accountId = env["MAXMIND_ACCOUNT_ID"]?.trim() || undefined;
  const licenseKey = env["MAXMIND_LICENSE_KEY"]?.trim() || undefined;
  if ((accountId === undefined) !== (licenseKey === undefined)) {
    throw new Error("MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY must be configured together");
  }
  const scope = new ResourceScope();
  try {
    const databasePath = resolve(env["GEOIP_DATABASE_PATH"] ?? "./data/GeoLite2-City.mmdb");
    const geoIp = new LocalGeoIpResolver(
      {
        databasePath,
        maximumAccuracyRadiusKm: integer(env["GEOIP_MAX_ACCURACY_RADIUS_KM"], 100, "GEOIP_MAX_ACCURACY_RADIUS_KM"),
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
              intervalMs: integer(env["GEOIP_UPDATE_INTERVAL_MS"], 302_400_000, "GEOIP_UPDATE_INTERVAL_MS"),
              ...(dependencies.fetchImplementation === undefined ? {} : { fetchImplementation: dependencies.fetchImplementation }),
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
      scope.defer(() => updater.stop());
    }
    const server = new PublicCanaryServer(
      {
        host: env["CANARY_HOST"] ?? "127.0.0.1",
        port: integer(env["CANARY_PORT"], 8090, "CANARY_PORT", 0),
        signingSecret: required(env["CANARY_SIGNING_SECRET"], "CANARY_SIGNING_SECRET"),
        trustedProxyCidrs: (env["CANARY_TRUSTED_PROXY_CIDRS"] ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        requestsPerMinute: integer(env["CANARY_REQUESTS_PER_MINUTE"], 60, "CANARY_REQUESTS_PER_MINUTE"),
      },
      securityLogger,
      geoIp,
    );
    const address = await server.start();
    scope.defer(() => server.stop());
    logger.info("Public canary started", {
      address,
      geoDataset: geoIp.dataset ?? "unavailable",
    });
    return scope.service();
  } catch (error) {
    await scope.close().catch(() => undefined);
    throw error;
  }
}
