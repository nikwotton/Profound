import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyStage, resolveStageConfiguration } from "../infra/stage-config.js";

test("stage configuration isolates personal stages with safe provider and capacity defaults", () => {
  const personal = resolveStageConfiguration("liam-dev");
  assert.equal(personal.kind, "developer");
  assert.equal(personal.providerMode, "mock");
  assert.equal(personal.protect, false);
  assert.equal(personal.removal, "remove");
  assert.equal(personal.deployTransportTarget, false);
  assert.deepEqual([personal.minimumTasks, personal.maximumTasks], [1, 4]);
  assert.deepEqual(personal.features, {
    controlApiIdentities: false,
    syntheticHealthRoute: false,
    healthAlerting: false,
    usageAccountingSource: false,
  });
});

test("shared, CI, and production stage behavior is centralized and explicit", () => {
  assert.equal(classifyStage("staging"), "shared");
  assert.equal(resolveStageConfiguration("staging").providerMode, "live");
  assert.equal(resolveStageConfiguration("preview").providerMode, "mock");
  assert.equal(resolveStageConfiguration("ci-123").deployTransportTarget, true);
  const production = resolveStageConfiguration("production");
  assert.equal(production.providerMode, "live");
  assert.equal(production.protect, true);
  assert.equal(production.removal, "retain");
  assert.deepEqual([production.minimumTasks, production.maximumTasks], [2, 20]);
  assert.throws(() => classifyStage("Bad/Stage"), /stage names/);
});
