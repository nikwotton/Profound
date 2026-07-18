import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const expectedSstSecrets = [
  "AxiomIngestToken",
  "BrightDataApiKey",
  "BrightDataCustomerId",
  "BrightDataPassword",
  "BrightDataZone",
  "CanarySigningSecret",
  "ControlApiIdentities",
  "ControlApiToken",
  "HealthAggregatorToken",
  "HealthAlertDestinations",
  "HealthProxyPassword",
  "HealthProxyUsername",
  "ProxidizeApiToken",
  "UsageAccountingSourceToken",
];

const expectedOperatorDeploymentInputs = [
  "CONTROL_CERT_ARN",
  "CONTROL_DOMAIN",
  "CONTROL_PLANE_ALLOWED_CIDRS",
  "DATA_PLANE_ALLOWED_CIDRS",
  "PROXY_CERT_ARN",
  "PROXY_DOMAIN",
];

const expectedCiDeploymentInputs = ["RELEASE_IMAGE_URI", "RELEASE_SHA"];

test("the fixed local runtime adds no standalone environment configuration contract", () => {
  assert.equal(existsSync(".env.example"), false);
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.["dev"], undefined);
  assert.equal(packageJson.scripts?.["dev:local"], "tsx src/local.ts");
  assert.equal(packageJson.scripts?.["demo"], "tsx scripts/demo.ts");
  assert.equal(packageJson.scripts?.["dev:service"], "tsx watch src/index.ts");

  const runtime = ["src/app.ts", "src/config.ts", "src/index.ts", "src/local-runtime.ts", "src/runtime-services.ts"]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert.doesNotMatch(runtime, /PERSISTENCE_BACKEND|SQLITE_PATH/);
  assert.doesNotMatch(readFileSync("src/store.ts", "utf8"), /node:sqlite|SqliteRouteStore/);
  assert.doesNotMatch(readFileSync("src/index.ts", "utf8"), /case "proxy"/);
  assert.doesNotMatch(readFileSync("src/runtime-services.ts", "utf8"), /SqliteRouteStore/);
  assert.match(readFileSync("src/in-memory-route-store.ts", "utf8"), /class InMemoryRouteStore/);
  const localRuntime = readFileSync("src/local-runtime.ts", "utf8");
  assert.match(localRuntime, /PROVIDER_MODE: "mock"/);
  assert.match(localRuntime, /OTEL_SDK_DISABLED: "true"/);
  assert.match(localRuntime, /storeFactory: \(\) => \{/);
  assert.match(localRuntime, /store = new InMemoryRouteStore\(\)/);
  assert.doesNotMatch(localRuntime, /process\.env|PERSISTENCE_BACKEND/);

  const infrastructure = readFileSync("infra/providers/aws.ts", "utf8");
  assert.doesNotMatch(infrastructure, /PERSISTENCE_BACKEND|command: "pnpm dev"/);
  assert.match(infrastructure, /command: "pnpm dev:service"/);
});

test("SST secrets have an audited exclusive source and development placeholders", () => {
  const aws = readFileSync("infra/providers/aws.ts", "utf8");
  const awsPolicy = readFileSync("infra/providers/aws-policy.ts", "utf8");
  const root = readFileSync("sst.config.ts", "utf8");
  const stageConfiguration = readFileSync("infra/stage-config.ts", "utf8");
  const documentation = readFileSync("docs/CONFIGURATION.md", "utf8");
  const infrastructure = `${root}\n${stageConfiguration}\n${awsPolicy}\n${aws}`;
  const secrets = [...aws.matchAll(/new sst\.Secret\(\s*"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(secrets, expectedSstSecrets);

  for (const secret of expectedSstSecrets) {
    assert.match(documentation, new RegExp("\\| `" + secret + "`\\s+\\|"));
  }
  for (const runtimeSecret of [
    "AXIOM_TOKEN",
    "BRIGHT_DATA_API_KEY",
    "BRIGHT_DATA_CUSTOMER_ID",
    "BRIGHT_DATA_PASSWORD",
    "BRIGHT_DATA_ZONE",
    "CANARY_SIGNING_SECRET",
    "CONTROL_API_IDENTITIES_JSON",
    "CONTROL_API_TOKEN",
    "HEALTH_AGGREGATOR_TOKEN",
    "HEALTH_ALERT_DESTINATIONS_JSON",
    "HEALTH_PROXY_PASSWORD",
    "HEALTH_PROXY_USERNAME",
    "PROXIDIZE_API_TOKEN",
    "USAGE_ACCOUNTING_SOURCE_TOKEN",
  ]) {
    assert.doesNotMatch(infrastructure, new RegExp(`process\\.env(?:\\.${runtimeSecret}\\b|\\[["']${runtimeSecret}["']\\])`));
  }

  const deploymentInputs = [...root.matchAll(/process\.env\.([A-Z0-9_]+)/g), ...aws.matchAll(/process\.env\.([A-Z0-9_]+)/g)]
    .map((match) => match[1])
    .filter((knob): knob is string => knob !== undefined);
  assert.deepEqual([...new Set(deploymentInputs)].sort(), [...expectedOperatorDeploymentInputs, ...expectedCiDeploymentInputs].sort());
  for (const input of [...expectedOperatorDeploymentInputs, ...expectedCiDeploymentInputs]) {
    assert.match(documentation, new RegExp("`" + input + "`"));
  }
  assert.doesNotMatch(stageConfiguration, /environment|process\.env/);
  assert.match(stageConfiguration, /providerMode = production \|\| stage === "staging" \? "live" : "mock"/);
  assert.match(aws, /import \{ v0Policy \} from "\.\/aws-policy\.js"/);
  assert.match(awsPolicy, /export const v0Policy =/);

  assert.match(aws, /new sst\.Secret\("ControlApiToken", \$dev \? devControlApiToken : undefined\)/);
  assert.match(aws, /new sst\.Secret\("HealthAggregatorToken", \$dev \? devHealthAggregatorToken : undefined\)/);
  assert.match(aws, /new sst\.Secret\(\s*"CanarySigningSecret",\s*\$dev \? devCanarySigningSecret : undefined/);
  assert.match(aws, /new sst\.Secret\("AxiomIngestToken", \$dev \? "unused-in-sst-dev" : undefined\)/);
});
