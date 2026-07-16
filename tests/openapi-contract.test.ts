import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OpenApi } from "@effect/platform";
import { ControlApi, CONTROL_API_VERSION } from "../src/control-contract.js";
import { findBreakingOpenApiChanges, type OpenApiDocument } from "../src/openapi-compat.js";

test("versioned OpenAPI artifact stays synchronized with Effect schemas and excludes data-plane protocols", async () => {
  const artifact = JSON.parse(await readFile(`openapi/profound-control-api.v${CONTROL_API_VERSION}.json`, "utf8")) as OpenApiDocument;
  const live = OpenApi.fromApi(ControlApi) as unknown as OpenApiDocument;

  assert.equal(artifact.info?.version, CONTROL_API_VERSION);
  assert.deepEqual(artifact, live);
  assert.ok(artifact.paths?.["/v1/routes"]);
  for (const path of Object.keys(artifact.paths ?? {})) {
    assert.match(path, /^(\/v1\/|\/health\/)/);
    assert.doesNotMatch(path, /proxy|connect|socks/i);
  }
});

test("OpenAPI compatibility check rejects breaking management-contract changes", () => {
  const baseline = OpenApi.fromApi(ControlApi) as unknown as OpenApiDocument;
  const removedPath = structuredClone(baseline);
  delete removedPath.paths?.["/v1/routes"];
  assert.ok(findBreakingOpenApiChanges(baseline, removedPath).some((change) => change.includes("removed path /v1/routes")));

  const newlyRequired = structuredClone(baseline);
  const operation = newlyRequired.paths?.["/v1/routes"] as Record<string, unknown> | undefined;
  const post = operation?.post as Record<string, unknown> | undefined;
  if (post === undefined) assert.fail("Expected POST /v1/routes to exist");
  post.parameters = [{ name: "x-breaking-input", in: "header", required: true, schema: { type: "string" } }];
  assert.ok(findBreakingOpenApiChanges(baseline, newlyRequired).some((change) => change.includes("added required parameter header:x-breaking-input")));

  const additive = structuredClone(baseline);
  additive.paths ??= {};
  additive.paths["/v1/new-operation"] = { get: { responses: { "200": { description: "ok" } } } };
  assert.deepEqual(findBreakingOpenApiChanges(baseline, additive), []);
});
