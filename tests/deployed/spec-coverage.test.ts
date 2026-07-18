import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DESIGN_DOCUMENT_ID, DESIGN_DOCUMENT_REVISION, SPEC_COVERAGE } from "./spec-matrix.js";

function testSource(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return testSource(path);
      return entry.isFile() && entry.name.endsWith(".test.ts") ? readFileSync(path, "utf8") : "";
    })
    .join("\n");
}

test("the current design-document revision has an explicit test disposition for every decision group", () => {
  assert.equal(DESIGN_DOCUMENT_ID, "1Ud9m_c7YEYxjXS2QOiuCAKYMT5WVGzuN5oshEbm5zfU");
  assert.ok(DESIGN_DOCUMENT_REVISION.length > 40);
  assert.deepEqual(new Set(SPEC_COVERAGE.map(({ section }) => section)), new Set([1, 2, 3, 4, 5]));
  assert.equal(new Set(SPEC_COVERAGE.map(({ id }) => id)).size, SPEC_COVERAGE.length);
  const source = testSource("tests");
  for (const coverage of SPEC_COVERAGE) {
    assert.ok(coverage.requirement.length > 10, `${coverage.id} lacks a useful requirement description`);
    if (coverage.deferred === true) {
      assert.equal(coverage.deployed.length + coverage.offline.length, 0, `${coverage.id} is open but has normative assertions`);
    } else {
      assert.ok(coverage.deployed.length + coverage.offline.length > 0, `${coverage.id} has no deployed or controlled offline assertion`);
      for (const testName of [...coverage.deployed, ...coverage.offline]) {
        assert.ok(source.includes(`"${testName}"`), `${coverage.id} references missing test ${testName}`);
      }
    }
  }
});
