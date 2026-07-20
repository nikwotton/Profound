import assert from "node:assert/strict";
import { test } from "node:test";
import { BrightDataAdapter } from "../../src/providers/bright-data.js";
import { ProxidizeAdapter } from "../../src/providers/proxidize.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

test(
  "live Bright Data and Proxidize smoke test",
  {
    skip: process.env["RUN_LIVE_PROXY_TESTS"] !== "1" ? "Set RUN_LIVE_PROXY_TESTS=1 and provider credentials" : false,
  },
  async () => {
    const timeoutMs = 15_000;
    const brightData = new BrightDataAdapter({
      host: process.env["BRIGHT_DATA_HOST"]?.trim() || "brd.superproxy.io",
      port: Number(process.env["BRIGHT_DATA_PORT"]?.trim() || "33335"),
      customerId: required("BRIGHT_DATA_CUSTOMER_ID"),
      zone: required("BRIGHT_DATA_ZONE"),
      password: required("BRIGHT_DATA_PASSWORD"),
      apiKey: required("BRIGHT_DATA_API_KEY"),
      statusApiUrl: process.env["BRIGHT_DATA_STATUS_API_URL"]?.trim() || "https://api.brightdata.com/network_status/res",
      connectTimeoutMs: timeoutMs,
    });
    const brightDataHealth = await brightData.health();
    assert.equal(brightDataHealth.state, "healthy", brightDataHealth.message);

    const proxidize = new ProxidizeAdapter({
      apiBaseUrl: process.env["PROXIDIZE_API_BASE_URL"]?.trim() || "https://api.proxidize.com",
      apiToken: required("PROXIDIZE_API_TOKEN"),
      requestTimeoutMs: timeoutMs,
      exactCity: "verifiable",
    });
    assert.ok((await proxidize.listEndpoints(true)).length > 0, "Proxidize returned no usable proxy endpoints");
  },
);
