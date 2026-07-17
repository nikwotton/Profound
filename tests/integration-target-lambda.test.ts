import assert from "node:assert/strict";
import { test } from "node:test";
import { handleIntegrationTargetRequest, type IntegrationTargetRequestCounter } from "../src/integration-target-lambda.js";

class MemoryCounter implements IntegrationTargetRequestCounter {
  readonly #counts = new Map<string, number>();

  async increment(testId: string): Promise<number> {
    const count = (this.#counts.get(testId) ?? 0) + 1;
    this.#counts.set(testId, count);
    return count;
  }
}

test("the serverless integration target preserves request observations and durable replay counts", async () => {
  const counter = new MemoryCounter();
  const event = {
    rawPath: "/echo/path",
    rawQueryString: "first=one&second=two",
    headers: {
      Authorization: "Bearer target-token",
      Cookie: "session=target-cookie",
      "x-profound-test-id": "echo-test",
      "x-profound-test-header": "kept",
    },
    body: Buffer.from("target-body").toString("base64"),
    isBase64Encoded: true,
    requestContext: { requestId: "request-id", http: { method: "POST" } },
  };
  const first = await handleIntegrationTargetRequest(event, counter);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(JSON.parse(first.body), {
    method: "POST",
    path: "/echo/path?first=one&second=two",
    requestBody: "target-body",
    authorization: "Bearer target-token",
    cookie: "session=target-cookie",
    testHeader: "kept",
    requestCount: 1,
  });
  assert.equal(JSON.parse((await handleIntegrationTargetRequest(event, counter)).body).requestCount, 2);
});

test("the serverless integration target supports health, status, redirects, cookies, and body limits", async () => {
  const counter = new MemoryCounter();
  const health = await handleIntegrationTargetRequest(
    {
      rawPath: "/health/live",
      requestContext: { http: { method: "GET" } },
    },
    counter,
  );
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "live" });

  const unavailable = await handleIntegrationTargetRequest(
    {
      rawPath: "/status/503",
      cookies: ["first=one", "second=two"],
      requestContext: { requestId: "status", http: { method: "GET" } },
    },
    counter,
  );
  assert.equal(unavailable.statusCode, 503);
  assert.equal(JSON.parse(unavailable.body).cookie, "first=one; second=two");

  const redirect = await handleIntegrationTargetRequest(
    {
      rawPath: "/redirect",
      rawQueryString: "to=%2Fcaller-owned",
      requestContext: { requestId: "redirect", http: { method: "GET" } },
    },
    counter,
  );
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, "/caller-owned");

  const oversized = await handleIntegrationTargetRequest(
    {
      rawPath: "/echo",
      body: "x".repeat(1024 * 1024 + 1),
      requestContext: { requestId: "oversized", http: { method: "POST" } },
    },
    counter,
  );
  assert.equal(oversized.statusCode, 413);

  const simulated = await handleIntegrationTargetRequest(
    {
      rawPath: "/simulate",
      rawQueryString: "responseStatus=418&responseHeader=x-simulated%3Ayes&responseBody=caller-owned&delayMs=1",
      requestContext: { requestId: "simulated", http: { method: "GET" } },
    },
    counter,
  );
  assert.equal(simulated.statusCode, 418);
  assert.equal(simulated.headers["x-simulated"], "yes");
  assert.equal(JSON.parse(simulated.body), "caller-owned");

  const unsupportedConnection = await handleIntegrationTargetRequest(
    {
      rawPath: "/simulate",
      rawQueryString: "connection=reset",
      requestContext: { requestId: "reset", http: { method: "GET" } },
    },
    counter,
  );
  assert.equal(unsupportedConnection.statusCode, 501);
});
