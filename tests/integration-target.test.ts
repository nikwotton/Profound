import assert from "node:assert/strict";
import { test } from "node:test";
import { IntegrationTargetServer } from "../src/integration-target.js";
import { silentLogger } from "../src/logger.js";

test("the disposable deployed origin echoes native requests, statuses, redirects, and replay counts", async (t) => {
  const target = new IntegrationTargetServer({ host: "127.0.0.1", port: 0 }, silentLogger);
  const address = await target.start();
  t.after(() => target.stop());
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/health/live`)).status, 200);

  const echoed = await fetch(`${base}/echo?native=query`, {
    method: "POST",
    headers: {
      authorization: "Bearer target-token",
      cookie: "session=target-cookie",
      "x-profound-test-id": "echo-test",
      "x-profound-test-header": "kept",
    },
    body: "target-body",
  });
  assert.equal(echoed.status, 200);
  assert.deepEqual(await echoed.json(), {
    method: "POST",
    path: "/echo?native=query",
    requestBody: "target-body",
    authorization: "Bearer target-token",
    cookie: "session=target-cookie",
    testHeader: "kept",
    requestCount: 1,
  });

  const status = await fetch(`${base}/status/503`, { headers: { "x-profound-test-id": "status-test" } });
  assert.equal(status.status, 503);
  assert.equal((await status.json() as { requestCount: number }).requestCount, 1);
  const repeated = await fetch(`${base}/status/503`, { headers: { "x-profound-test-id": "status-test" } });
  assert.equal((await repeated.json() as { requestCount: number }).requestCount, 2);

  const redirect = await fetch(`${base}/redirect?to=%2Fcaller-owned`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/caller-owned");
});
