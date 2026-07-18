import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenApi } from "@effect/platform";
import { ControlApi, CONTROL_API_VERSION } from "../src/control-contract.js";
import { decodeOpenApiDocument, findBreakingOpenApiChanges, permitsVersionedBreakingChanges } from "../src/openapi-compat.js";

test("versioned OpenAPI artifact stays synchronized with Effect schemas and excludes data-plane protocols", async () => {
  const artifact = decodeOpenApiDocument(JSON.parse(await readFile(`openapi/profound-control-api.v${CONTROL_API_VERSION}.json`, "utf8")));
  const live = decodeOpenApiDocument(OpenApi.fromApi(ControlApi));

  assert.equal(artifact.info?.version, CONTROL_API_VERSION);
  assert.deepEqual(artifact, live);
  assert.ok(artifact.paths?.["/v1/profiles"]);
  for (const path of Object.keys(artifact.paths ?? {})) {
    assert.match(path, /^(\/v1\/|\/health\/)/);
    assert.doesNotMatch(path, /proxy|connect|socks/i);
  }
});

test("OpenAPI compatibility check rejects breaking management-contract changes", () => {
  const baseline = decodeOpenApiDocument(OpenApi.fromApi(ControlApi));
  const removedPath = structuredClone(baseline);
  delete removedPath.paths?.["/v1/profiles"];
  assert.ok(findBreakingOpenApiChanges(baseline, removedPath).some((change) => change.includes("removed path /v1/profiles")));

  const newlyRequired = structuredClone(baseline);
  const operation = newlyRequired.paths?.["/v1/profiles"] as Record<string, unknown> | undefined;
  const post = operation?.["post"] as Record<string, unknown> | undefined;
  if (post === undefined) assert.fail("Expected POST /v1/profiles to exist");
  post["parameters"] = [{ name: "x-breaking-input", in: "header", required: true, schema: { type: "string" } }];
  assert.ok(
    findBreakingOpenApiChanges(baseline, newlyRequired).some((change) =>
      change.includes("added required parameter header:x-breaking-input"),
    ),
  );

  const additive = structuredClone(baseline);
  additive.paths ??= {};
  additive.paths["/v1/new-operation"] = { get: { responses: { "200": { description: "ok" } } } };
  assert.deepEqual(findBreakingOpenApiChanges(baseline, additive), []);
  assert.equal(permitsVersionedBreakingChanges("0.6.0", "0.7.0"), true);
  assert.equal(permitsVersionedBreakingChanges("0.7.0", "0.7.1"), false);
  assert.equal(permitsVersionedBreakingChanges("1.2.0", "2.0.0"), true);
  assert.equal(permitsVersionedBreakingChanges("1.2.0", "1.3.0"), false);
});
