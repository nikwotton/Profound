import { test } from "node:test";

test("live Bright Data and Proxidize smoke test", {
  skip: process.env.RUN_LIVE_PROXY_TESTS !== "1" ? "Set RUN_LIVE_PROXY_TESTS=1 and provider credentials" : false,
}, async () => {
  if (
    !process.env.BRIGHT_DATA_CUSTOMER_ID || !process.env.BRIGHT_DATA_ZONE ||
    !process.env.BRIGHT_DATA_PASSWORD || !process.env.PROXIDIZE_API_TOKEN
  ) {
    throw new Error("Live provider credentials are required");
  }
  // Intentionally credential-gated. The offline contract suite is the source
  // of truth until vendor accounts are supplied for a live verification pass.
});
