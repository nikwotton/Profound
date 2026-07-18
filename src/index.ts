import { startControlPlaneApplication, startDataPlaneApplication } from "./app.js";
import { serviceVersion } from "./build-metadata.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startHealthAggregatorService } from "./services/health-aggregator-service.js";
import { startNotificationService } from "./services/notification-service.js";
import { startPublicCanaryService } from "./services/public-canary-service.js";
import { startDynamicService, type RunningService } from "./services/runtime.js";
import { startStatusApplicationService } from "./services/status-service.js";
import { startUsageAccountingService } from "./services/usage-accounting-service.js";
import { Telemetry } from "./telemetry.js";

const mode = process.env["SERVICE_MODE"];
const serviceName = process.env["OTEL_SERVICE_NAME"] ?? `profound-proxy-${mode}`;
const telemetry = new Telemetry({
  serviceName,
  serviceVersion: serviceVersion(process.env),
  environment: process.env,
});
const logger = createLogger({
  consoleMode: telemetry.exporting ? "errors" : "all",
  instrumentationScope: serviceName,
});
const securityLogger = createLogger({
  consoleMode: telemetry.exporting ? "errors" : "all",
  instrumentationScope: `${serviceName}.security`,
  defaultAttributes: { "log.category": "security" },
});
let application: RunningService;
try {
  switch (mode) {
    case "data-plane":
      application = await startDataPlaneApplication(loadConfig(), logger, { telemetry });
      break;
    case "control-plane":
      application = await startControlPlaneApplication(loadConfig(), logger, { telemetry });
      break;
    case "health-aggregator":
      application = await startHealthAggregatorService(loadConfig(), logger);
      break;
    case "status":
      application = await startStatusApplicationService(logger);
      break;
    case "usage-accounting":
      application = await startUsageAccountingService(logger);
      break;
    case "notification":
      application = await startNotificationService(logger);
      break;
    case "canary":
      application = await startPublicCanaryService(logger, process.env, securityLogger);
      break;
    case "integration-target":
      application = await startDynamicService("./services/" + "integration-target-service.js", "startIntegrationTargetService", [logger]);
      break;
    case undefined:
    default:
      throw new Error(
        "SERVICE_MODE is SST-managed and must be data-plane, control-plane, health-aggregator, status, usage-accounting, notification, canary, or integration-target",
      );
  }
} catch (error) {
  await telemetry.shutdown();
  throw error;
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("Shutdown requested", { signal });
  await application.stop();
  await telemetry.shutdown();
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
