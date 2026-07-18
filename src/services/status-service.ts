import type { Logger } from "../logger.js";
import { ResourceScope } from "../resource-scope.js";
import { StatusApplicationServer } from "../status-app.js";
import { createStore, integer, persistenceConfig, type RunningService, type RuntimeServiceDependencies } from "./runtime.js";

export async function startStatusApplicationService(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeServiceDependencies = {},
): Promise<RunningService> {
  const scope = new ResourceScope();
  try {
    const store = createStore(persistenceConfig(env), dependencies);
    scope.defer(() => store.close());
    const server = new StatusApplicationServer(
      store,
      {
        host: env["STATUS_APP_HOST"] ?? "127.0.0.1",
        port: integer(env["STATUS_APP_PORT"], 8083, "STATUS_APP_PORT", 0),
        staleAfterMs: integer(env["STATUS_STALE_AFTER_MS"], 300_000, "STATUS_STALE_AFTER_MS"),
        historyLimit: integer(env["STATUS_HISTORY_LIMIT"], 100, "STATUS_HISTORY_LIMIT"),
        ...(env["HEALTH_AGGREGATOR_URL"]?.trim() ? { healthAggregatorUrl: env["HEALTH_AGGREGATOR_URL"].trim() } : {}),
        ...(env["HEALTH_AGGREGATOR_TOKEN"]?.trim() ? { healthAggregatorToken: env["HEALTH_AGGREGATOR_TOKEN"].trim() } : {}),
        ...(dependencies.fetchImplementation === undefined ? {} : { fetchImplementation: dependencies.fetchImplementation }),
      },
      logger,
    );
    const address = await server.start();
    scope.defer(() => server.stop());
    logger.info("Status application started", { address });
    return scope.service();
  } catch (error) {
    await scope.close().catch(() => undefined);
    throw error;
  }
}
