import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { OpenApi } from "@effect/platform";
import { ControlApi, CONTROL_API_VERSION } from "../dist/src/control-contract.js";
import { findBreakingOpenApiChanges } from "../dist/src/openapi-compat.js";

const root = resolve(import.meta.dirname, "..");
const artifactPath = resolve(root, `openapi/profound-control-api.v${CONTROL_API_VERSION}.json`);
const [command, compatibilityBaseline] = process.argv.slice(2).filter((argument) => argument !== "--");

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

const document = sortJson(OpenApi.fromApi(ControlApi));
const output = `${JSON.stringify(document, null, 2)}\n`;
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (document.info?.version !== CONTROL_API_VERSION || packageJson.version !== CONTROL_API_VERSION) {
  throw new Error(`Control API, package, and artifact versions must match (${document.info?.version}, ${packageJson.version}, ${CONTROL_API_VERSION})`);
}

if (command === "generate") {
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, output);
  console.log(`Generated ${artifactPath}`);
} else if (command === "check") {
  const committed = await readFile(artifactPath, "utf8").catch(() => "");
  if (committed !== output) throw new Error(`OpenAPI artifact is stale; run pnpm openapi:generate (${artifactPath})`);
  console.log(`OpenAPI artifact is current: ${artifactPath}`);
} else if (command === "compatibility") {
  const baselinePath = compatibilityBaseline;
  if (baselinePath === undefined) throw new Error("Usage: pnpm openapi:compat -- <baseline.json>");
  const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf8"));
  const changes = findBreakingOpenApiChanges(baseline, document);
  if (changes.length > 0) throw new Error(`Breaking OpenAPI changes:\n- ${changes.join("\n- ")}`);
  console.log(`OpenAPI contract is compatible with ${baselinePath}`);
} else {
  throw new Error("Usage: node scripts/openapi-contract.mjs <generate|check|compatibility> [baseline.json]");
}
