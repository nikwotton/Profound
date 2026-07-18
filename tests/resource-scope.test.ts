import assert from "node:assert/strict";
import test from "node:test";
import { ResourceScope } from "../src/resource-scope.js";

test("resource scope releases acquired resources once in reverse order", async () => {
  const released: string[] = [];
  const scope = new ResourceScope();
  scope.defer(() => {
    released.push("first");
  });
  scope.defer(async () => {
    released.push("second");
  });

  const service = scope.service();
  await service.stop();
  await service.stop();

  assert.deepEqual(released, ["second", "first"]);
});

test("resource scope attempts every cleanup when one release fails", async () => {
  const released: string[] = [];
  const scope = new ResourceScope();
  scope.defer(() => {
    released.push("first");
  });
  scope.defer(() => {
    released.push("second");
    throw new Error("second cleanup failed");
  });

  await assert.rejects(scope.close(), /second cleanup failed/);
  assert.deepEqual(released, ["second", "first"]);
});
