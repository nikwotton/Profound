import assert from "node:assert/strict";
import { test } from "node:test";
import { usageDestination } from "../src/usage-destination.js";

test("usage destination dimensions omit queries and template identifiers conservatively", () => {
  assert.deepEqual(usageDestination("API.Example.COM.", 80, "/users/123/orders/550e8400-e29b-41d4-a716-446655440000"), {
    destinationDomain: "example.com",
    destinationHost: "api.example.com",
    destinationPort: 80,
    destinationPathTemplate: "/users/:id/orders/:id",
  });
  assert.equal(usageDestination("api.example.com", 443).destinationPathTemplate, undefined);
  assert.equal(usageDestination("api.example.com", 80, "/unsafe/%2Fsecret").destinationPathTemplate, undefined);
});
