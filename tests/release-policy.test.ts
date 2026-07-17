import assert from "node:assert/strict";
import { test } from "node:test";
import { isCurrentReleaseCandidate, validateMigrationDeclaration } from "../src/release-policy.js";

test("migration policy requires one declaration and CODEOWNER confirmation for sensitive migration-none changes", () => {
  assert.equal(validateMigrationDeclaration([], ["README.md"]).errors.length, 1);
  assert.equal(validateMigrationDeclaration(["migration:none", "migration:compatible"], ["README.md"]).errors.length, 1);
  assert.equal(validateMigrationDeclaration(["migration:none"], ["README.md"]).errors.length, 0);
  const challenged = validateMigrationDeclaration(["migration:none"], ["src/dynamo-store.ts"]);
  assert.deepEqual(challenged.sensitiveFiles, ["src/dynamo-store.ts"]);
  assert.equal(challenged.errors.length, 1);
  assert.equal(validateMigrationDeclaration(["migration:none", "migration:none-reviewed"], ["src/dynamo-store.ts"]).errors.length, 0);
  assert.equal(validateMigrationDeclaration(["migration:compatible"], ["src/dynamo-store.ts"]).errors.length, 0);
});

test("release candidate coalescing deploys only the current cumulative main commit", () => {
  assert.equal(isCurrentReleaseCandidate("ABC123", "abc123"), true);
  assert.equal(isCurrentReleaseCandidate("older", "newer"), false);
});
