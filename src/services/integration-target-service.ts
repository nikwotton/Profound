import type { Logger } from "../logger.js";
import { IntegrationTargetServer } from "../integration-target.js";
import { integer, type RunningService } from "./runtime.js";

export async function startIntegrationTargetService(logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<RunningService> {
  if (env["NODE_ENV"] === "production" && env["ALLOW_INTEGRATION_TARGET"] !== "true") {
    throw new Error("The integration target requires ALLOW_INTEGRATION_TARGET=true");
  }
  const server = new IntegrationTargetServer(
    {
      host: env["INTEGRATION_TARGET_HOST"] ?? "127.0.0.1",
      port: integer(env["INTEGRATION_TARGET_PORT"], 8091, "INTEGRATION_TARGET_PORT", 0),
    },
    logger,
  );
  const address = await server.start();
  logger.info("Integration target started", { address });
  return { stop: () => server.stop() };
}
