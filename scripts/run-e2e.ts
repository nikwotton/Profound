import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { IntegrationTargetServer } from "../src/integration-target.js";
import { LOCAL_CONTROL_TOKEN, startLocalRuntime, type RunningLocalApplication } from "../src/local-runtime.js";
import { silentLogger } from "../src/logger.js";

interface LocalE2eEnvironment {
  runtime: RunningLocalApplication;
  target?: IntegrationTargetServer;
  variables: Record<string, string>;
}

async function localEnvironment(): Promise<LocalE2eEnvironment> {
  const configuredTarget = process.env["E2E_TARGET_URL"]?.trim();
  let target: IntegrationTargetServer | undefined;
  let targetUrl: URL;
  if (configuredTarget === undefined || configuredTarget === "") {
    target = new IntegrationTargetServer({ host: "127.0.0.1", port: 0 }, silentLogger);
    const address = await target.start();
    targetUrl = new URL(`http://127.0.0.1:${address.port}/resource`);
  } else {
    targetUrl = new URL(configuredTarget);
  }
  const targetPort = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80));
  try {
    const runtime = await startLocalRuntime({
      forwardPort: 0,
      socks5Port: 0,
      controlPort: 0,
      allowedTargetPorts: [targetPort],
      logger: silentLogger,
    });
    return {
      runtime,
      ...(target === undefined ? {} : { target }),
      variables: {
        E2E_CONTROL_API_URL: `http://127.0.0.1:${runtime.controlAddress.port}`,
        E2E_CONTROL_API_TOKEN: LOCAL_CONTROL_TOKEN,
        E2E_TARGET_URL: targetUrl.toString(),
        E2E_EXPECTED_TARGET_STATUS: process.env["E2E_EXPECTED_TARGET_STATUS"]?.trim() || "200",
      },
    };
  } catch (error) {
    await target?.stop();
    throw error;
  }
}

async function runTests(variables: Record<string, string>): Promise<number> {
  const directory = resolve("dist/tests/e2e");
  const tests = (await readdir(directory))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => resolve(directory, name));
  if (tests.length === 0) throw new Error("No compiled E2E tests were found");
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
    stdio: "inherit",
    env: { ...process.env, RUN_PROXY_E2E_TESTS: "1", ...variables },
  });
  return await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`E2E test process terminated by ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
}

const externalControlUrl = process.env["E2E_CONTROL_API_URL"]?.trim();
let local: LocalE2eEnvironment | undefined;
try {
  if (externalControlUrl !== undefined && externalControlUrl !== "" && !process.env["E2E_TARGET_URL"]?.trim()) {
    throw new Error("E2E_TARGET_URL is required when E2E_CONTROL_API_URL selects an external environment");
  }
  local = externalControlUrl === undefined || externalControlUrl === "" ? await localEnvironment() : undefined;
  process.exitCode = await runTests(local?.variables ?? {});
} finally {
  if (local !== undefined) await Promise.allSettled([local.runtime.stop(), local.target?.stop()]);
}
