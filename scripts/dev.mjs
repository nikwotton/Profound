import { spawn } from "node:child_process";

const children = new Set();
let stopping = false;

function start(environment) {
  const child = spawn("pnpm", ["dev:service"], {
    stdio: "inherit",
    env: { ...process.env, ...environment },
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      stop(signal ?? "SIGTERM");
      process.exitCode = code ?? 1;
    }
  });
  return child;
}

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

async function waitUntilReady(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The simulator process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const mode = process.env.SERVICE_MODE ?? "proxy";
if (mode !== "proxy" || process.env.PROVIDER_MODE === "live") {
  start({});
} else {
  const brightDataPort = process.env.PROVIDER_SIMULATOR_BRIGHT_DATA_PORT ?? "33335";
  const proxidizeControlPort = process.env.PROVIDER_SIMULATOR_PROXIDIZE_CONTROL_PORT ?? "8092";
  const adminPort = process.env.PROVIDER_SIMULATOR_ADMIN_PORT ?? "8094";
  start({ SERVICE_MODE: "provider-simulators" });
  try {
    await waitUntilReady(`http://127.0.0.1:${adminPort}/health/ready`);
    start({
      SERVICE_MODE: mode,
      BRIGHT_DATA_HOST: process.env.BRIGHT_DATA_HOST ?? "127.0.0.1",
      BRIGHT_DATA_PORT: process.env.BRIGHT_DATA_PORT ?? brightDataPort,
      PROXIDIZE_API_BASE_URL: process.env.PROXIDIZE_API_BASE_URL ?? `http://127.0.0.1:${proxidizeControlPort}`,
    });
  } catch (error) {
    console.error(error);
    stop();
    process.exitCode = 1;
  }
}
