import { startApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const logger = createLogger();
const application = await startApplication(loadConfig(), logger);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("Shutdown requested", { signal });
  await application.stop();
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
