import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
const project = process.argv[2] ?? "tsconfig.build.json";
if (project !== "tsconfig.build.json" && project !== "tsconfig.dev-build.json" && project !== "tsconfig.test-build.json") {
  throw new Error("build project must be tsconfig.build.json, tsconfig.dev-build.json, or tsconfig.test-build.json");
}
const result = spawnSync(
  process.execPath,
  [new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname, "-p", new URL(`../${project}`, import.meta.url).pathname],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
