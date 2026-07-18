import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRouteStore } from "../src/in-memory-route-store.js";
import { silentLogger } from "../src/logger.js";
import { StatusApplicationServer } from "../src/status-app.js";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");

test("status usage endpoints reject malformed ranges before querying storage", async (t) => {
  const server = new StatusApplicationServer(
    new InMemoryRouteStore(undefined, () => NOW),
    { host: "127.0.0.1", port: 0, staleAfterMs: 300_000, historyLimit: 10, now: () => NOW },
    silentLogger,
  );
  const address = await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${address.port}`;

  for (const path of ["/v1/usage", "/v1/usage/reconciliations", "/v1/usage/events", "/v1/usage/capacity-pressure-evidence"]) {
    const response = await fetch(`${base}${path}?from=not-a-timestamp&to=2026-07-18T12%3A00%3A00.000Z`);
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: "invalid_usage_time_range" });
  }

  const reversed = await fetch(`${base}/v1/usage?from=2026-07-18T12%3A00%3A00.000Z&to=2026-07-18T11%3A00%3A00.000Z`);
  assert.equal(reversed.status, 400);
  assert.deepEqual(await reversed.json(), { error: "invalid_usage_time_range" });
});

test("status usage endpoints classify an invalid session mode as a client error", async (t) => {
  const server = new StatusApplicationServer(
    new InMemoryRouteStore(undefined, () => NOW),
    { host: "127.0.0.1", port: 0, staleAfterMs: 300_000, historyLimit: 10, now: () => NOW },
    silentLogger,
  );
  const address = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/usage?sessionMode=unexpected`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_session_mode" });
});
