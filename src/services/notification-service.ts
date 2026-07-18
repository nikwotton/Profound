import { createServer } from "node:http";
import { parseHealthAlertDestinationConfig, WebhookNotificationAdapter } from "../alerting.js";
import type { Logger } from "../logger.js";
import { closeServer, listen } from "../net-utils.js";
import { ResourceScope } from "../resource-scope.js";
import { createStore, integer, persistenceConfig, type RunningService, type RuntimeServiceDependencies } from "./runtime.js";

export async function startNotificationService(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeServiceDependencies = {},
): Promise<RunningService> {
  const scope = new ResourceScope();
  try {
    const store = createStore(persistenceConfig(env), dependencies);
    scope.defer(() => store.close());
    const config = parseHealthAlertDestinationConfig(env["HEALTH_ALERT_DESTINATIONS_JSON"]);
    const notifier = new WebhookNotificationAdapter(
      store,
      config.destinations,
      {
        timeoutMs: integer(env["HEALTH_ALERT_WEBHOOK_TIMEOUT_MS"], 5_000, "HEALTH_ALERT_WEBHOOK_TIMEOUT_MS"),
        maxAttempts: integer(env["HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS"], 5, "HEALTH_ALERT_WEBHOOK_MAX_ATTEMPTS"),
        initialBackoffMs: integer(env["HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS"], 1_000, "HEALTH_ALERT_WEBHOOK_INITIAL_BACKOFF_MS"),
        ...(dependencies.fetchImplementation === undefined ? {} : { fetch: dependencies.fetchImplementation }),
      },
      logger,
    );
    const intervalMs = integer(env["NOTIFICATION_POLL_INTERVAL_MS"], 5_000, "NOTIFICATION_POLL_INTERVAL_MS");
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
    const address = await listen(
      server,
      env["NOTIFICATION_HOST"] ?? "127.0.0.1",
      integer(env["NOTIFICATION_PORT"], 8084, "NOTIFICATION_PORT", 0),
    );
    scope.defer(() => closeServer(server));
    await flush();
    const timer = setInterval(() => void flush(), intervalMs);
    timer.unref();
    scope.defer(() => clearInterval(timer));
    logger.info("Notification service started", { address, configurationVersion: config.version });
    return scope.service();
  } catch (error) {
    await scope.close().catch(() => undefined);
    throw error;
  }
}
