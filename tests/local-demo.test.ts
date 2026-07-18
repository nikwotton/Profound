import assert from "node:assert/strict";
import test from "node:test";
import { expectArray, expectRecord, parseJson } from "../src/decoding.js";
import { startDemo } from "../src/demo.js";
import { silentLogger } from "../src/logger.js";

test("local demo exercises the principal flows with no external services", async (t) => {
  let output = "";
  const pauses: string[] = [];
  const demo = await startDemo({
    forwardPort: 0,
    socks5Port: 0,
    controlPort: 0,
    statusPort: 0,
    logger: silentLogger,
    write: (line) => {
      output += line;
    },
    pauseBeforeStep: async ({ number, title }) => {
      pauses.push(`${number}:${title}`);
    },
  });
  t.after(() => demo.stop());

  assert.ok(demo.application.forwardAddress.port > 0);
  assert.ok(demo.application.socks5Address.port > 0);
  assert.ok(demo.application.controlAddress.port > 0);
  assert.deepEqual(pauses, [
    "1:Control-plane readiness",
    "2:Public-data profile → Bright Data residential routing",
    "3:Managed-session profile → stable Proxidize mobile device",
    "4:HTTPS CONNECT retry/failover and SOCKS5 tunnelling",
    "5:Usage events → accounting aggregation → analytics queries",
    "6:One-time credential rotation and revocation",
  ]);
  assert.match(output, /both simulated providers are healthy/);
  assert.match(output, /fresh exits/);
  assert.match(output, /stable Proxidize mobile device/);
  assert.match(output, /HTTPS CONNECT retry\/failover and SOCKS5/);
  assert.match(output, /immutable upstream-attempt events/);
  assert.match(output, /accounting worker persisted \d+ hourly\/daily and per-customer rollups/);
  assert.match(output, /groupBy=provider/);
  assert.match(output, /groupBy=customer/);
  assert.match(output, /groupBy=job/);
  assert.match(output, /groupBy=outcome/);
  assert.match(output, /"averageLatencyMs":\d+/);
  assert.match(output, /"retryCount":[1-9]\d*/);
  assert.match(output, /"failoverCount":[1-9]\d*/);
  assert.match(output, /"pricingModel":"per_gib"/);
  assert.match(output, /"pricingModel":"per_device_month"/);
  assert.match(output, /"job":"job-public-catalog"/);
  assert.match(output, /"job":"job-authenticated-collection"/);
  assert.match(output, /headers, bodies, URL queries, cookies, authorization, and proxy credentials are absent/);
  assert.match(output, /revoked credential now receives HTTP 407/);
  assert.match(output, /→ GET \/health\/ready/);
  assert.match(output, /request body: {"customerId":"demo-public-data"/);
  assert.match(output, /response body: {"profileId":"[^"]+"}/);
  assert.match(output, /response headers: {[^\n]*"x-mock-exit-ip":"198\.51\.100\./);
  assert.match(
    output,
    /response body: {"method":"GET","path":"\/audit","demoHeader":"proxy-router-review","authorizationReceived":true,"cookieReceived":true}/,
  );
  assert.match(output, /→ CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.1/);
  assert.match(output, /method negotiation: {"requestHex":"050102","responseHex":"0502"}/);
  assert.match(output, /← HTTP 407/);
  assert.match(output, /\?\[REDACTED\]/);
  assert.doesNotMatch(output, /demo-query-secret|demo-target-secret|demo-cookie-secret|connect-demo|socks5-demo/);
  assert.doesNotMatch(output, /"(?:username|password)":"(?!\[REDACTED\])[^"]+"/);

  const profiles = await fetch(`http://127.0.0.1:${demo.application.controlAddress.port}/v1/profiles`, {
    headers: { authorization: `Bearer ${demo.application.controlToken}` },
  });
  assert.equal(profiles.status, 200);
  const body = expectRecord(parseJson(await profiles.text(), "profiles response"), "profiles response");
  assert.equal(expectArray(body["data"], "profiles response.data").length, 2);
});
