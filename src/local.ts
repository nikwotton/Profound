import { startLocalRuntime } from "./local-runtime.js";

const application = await startLocalRuntime();

process.stdout.write(
  [
    "",
    "Profound local runtime is ready (mock providers, in-memory persistence).",
    `  HTTP/HTTPS proxy  http://${application.forwardAddress.host}:${application.forwardAddress.port}`,
    `  SOCKS5 proxy      socks5h://${application.socks5Address.host}:${application.socks5Address.port}`,
    `  Control API       http://${application.controlAddress.host}:${application.controlAddress.port}`,
    `  Swagger UI        http://${application.controlAddress.host}:${application.controlAddress.port}/docs`,
    "  Control token     change-me (local loopback only)",
    "",
    "Data is ephemeral and is discarded when this process stops. Press Ctrl-C to stop.",
    "",
  ].join("\n"),
);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`\nStopping local runtime (${signal})...\n`);
  await application.stop();
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
