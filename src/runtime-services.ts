export { startHealthAggregatorService, requireServiceOwnedCapabilityAlerts } from "./services/health-aggregator-service.js";
export { startIntegrationTargetService } from "./services/integration-target-service.js";
export { startNotificationService } from "./services/notification-service.js";
export { startPublicCanaryService } from "./services/public-canary-service.js";
export { startStatusApplicationService } from "./services/status-service.js";
export { startUsageAccountingService } from "./services/usage-accounting-service.js";
export type { RunningService, RuntimePersistenceConfig, RuntimeServiceDependencies } from "./services/runtime.js";
