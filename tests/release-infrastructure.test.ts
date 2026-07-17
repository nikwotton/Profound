import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function file(path: string): string {
  return readFileSync(path, "utf8");
}

test("repository delivery policy encodes required CI, review, dependency, migration, and live-probe gates", () => {
  const ci = file(".github/workflows/ci.yml");
  const settings = file("docs/repository-and-release-settings.md");
  const template = file(".github/pull_request_template.md");
  assert.match(ci, /merge_group:/);
  for (const command of [
    "format:check",
    "pnpm lint",
    "pnpm check",
    "test:unit",
    "test:property",
    "openapi:check",
    "pr:policy",
    "docker build",
  ]) {
    assert.ok(ci.includes(command), `CI is missing ${command}`);
  }
  assert.match(settings, /require one approval and CODEOWNER review/);
  assert.match(settings, /merge commits only/);
  assert.match(settings, /GitHub App integration/);
  assert.match(template, /migration:destructive/);
  assert.match(file(".github/dependabot.yml"), /github-actions/);
  assert.match(file(".github/workflows/live-provider-smoke.yml"), /schedule:/);
  assert.match(file(".github/workflows/live-provider-smoke.yml"), /src\/providers\/\*\*/);
});

test("AWS delivery workflows build once, promote unchanged, serialize releases, and clean ephemeral stages", () => {
  const release = file(".github/workflows/release.yml");
  const ephemeral = file(".github/workflows/aws-pr.yml");
  assert.match(release, /cancel-in-progress: false/);
  assert.match(release, /Build candidate once/);
  assert.ok((release.match(/RELEASE_IMAGE_URI: \$\{\{ steps\.image\.outputs\.uri \}\}/g) ?? []).length >= 2);
  assert.match(release, /assert-current-main/);
  assert.match(release, /record-release/);
  assert.match(file("scripts/record-release.mjs"), /GITHUB_STEP_SUMMARY/);
  assert.match(ephemeral, /merge_group:/);
  assert.match(ephemeral, /cancel-in-progress: false/);
  assert.match(ephemeral, /Deploy current main as the upgrade baseline/);
  assert.match(ephemeral, /Run ordered restartable migrations/);
  assert.match(ephemeral, /ROUTE_TABLE_NAME=/);
  assert.match(ephemeral, /Rollback rehearsal/);
  assert.match(ephemeral, /if: always\(\)/);
  assert.match(file(".github/workflows/ephemeral-janitor.yml"), /remove-expired-stages/);
});

test("gateway releases persist active tunnels and enforce the staged drain escalation policy", () => {
  const service = file("src/route-service.ts");
  const coordinator = file("src/deployment-coordinator.ts");
  const stack = file("infra/providers/aws.ts");
  assert.match(service, /registerActiveTunnel/);
  assert.match(service, /shouldTerminateDeployment/);
  assert.match(coordinator, /coordinateDeploymentDrain/);
  assert.match(coordinator, /SNSClient/);
  assert.match(stack, /DeploymentDrainPoller/);
  assert.match(stack, /rate\(15 minutes\)/);
  assert.match(stack, /strategy: "BLUE_GREEN"/);
  assert.match(stack, /bakeTimeInMinutes: "360"/);
  assert.match(stack, /POST_PRODUCTION_TRAFFIC_SHIFT/);
  assert.match(stack, /alternateTargetGroupArn/);
});

test("developer stages are isolated and destination simulators preserve configurable recipient behavior", () => {
  const stage = file("infra/stage-config.ts");
  const simulator = file("src/destination-simulator.ts");
  assert.match(stage, /Personal developer stages cannot use live provider credentials/);
  for (const option of ["responseStatus", "responseHeader", "responseBody", "delayMs", "connection"]) {
    assert.ok(simulator.includes(option), `Destination simulator is missing ${option}`);
  }
});

test("provider contracts are pinned and checked for freshness", () => {
  const sources = JSON.parse(file("config/provider-sources.json")) as { providers: Array<{ id: string }> };
  assert.deepEqual(
    sources.providers.map((provider) => provider.id),
    ["bright_data", "proxidize"],
  );
  assert.match(file("scripts/provider-freshness.mjs"), /last-modified/);
  assert.match(file(".github/workflows/provider-freshness.yml"), /issues: write/);
  assert.match(file("tests/provider-contract.test.ts"), /assertNormalizedContract/);
});
