import { createInterface } from "node:readline/promises";
import { startDemo } from "../src/demo.js";
import { createLogger } from "../src/logger.js";

const runOnce = process.argv.includes("--once");
const ephemeralPorts = process.argv.includes("--ephemeral-ports");
const interactive = !runOnce && !process.argv.includes("--no-interactive") && process.stdin.isTTY && process.stdout.isTTY;
const terminal = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
const pauseBeforeStep =
  terminal === undefined
    ? undefined
    : async ({ number, total, title }: { number: number; total: number; title: string }): Promise<void> => {
        await terminal.question(`\nPress Enter to run step ${number}/${total}: ${title}...`);
      };

const demo = await startDemo({
  ...(ephemeralPorts ? { forwardPort: 0, socks5Port: 0, controlPort: 0, statusPort: 0 } : {}),
  ...(pauseBeforeStep === undefined ? {} : { pauseBeforeStep }),
  logger: createLogger({ consoleMode: "errors", instrumentationScope: "profound-proxy-demo" }),
}).finally(() => {
  terminal?.close();
});

if (runOnce) {
  await demo.stop();
} else {
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\nStopping demo (${signal})...\n`);
    await demo.stop();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}
