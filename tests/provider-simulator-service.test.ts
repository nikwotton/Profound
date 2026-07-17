import assert from "node:assert/strict";
import { test } from "node:test";
import { silentLogger } from "../src/logger.js";
import { ProviderSimulatorAdminClient, ProviderSimulatorService } from "../src/simulators/provider-simulator-service.js";

test("provider simulators run as one independently administered service", async (t) => {
  const service = new ProviderSimulatorService({
    host: "127.0.0.1",
    brightDataPort: 0,
    proxidizeControlPort: 0,
    proxidizeDataPort: 0,
    adminPort: 0,
    adminToken: "simulator-admin",
    brightDataCustomerId: "mock-customer",
    brightDataZone: "residential",
    brightDataPassword: "mock-bright-password",
    proxidizeApiToken: "mock-proxidize-token",
    proxidizeAdvertisedDataHost: "provider-simulators.internal",
    proxidizeAdvertisedDataPort: 8_093,
    logger: silentLogger,
  });
  const addresses = await service.start();
  t.after(() => service.stop());

  const baseUrl = `http://${addresses.admin.host}:${addresses.admin.port}`;
  assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/v1/providers/proxidize/devices`)).status, 401);

  const client = new ProviderSimulatorAdminClient(baseUrl, "simulator-admin");
  assert.equal((await client.devices()).length, 3);
  await client.setDeviceHealth("px-us-ny-1", false);
  assert.equal((await client.devices()).find(({ id }) => id === "px-us-ny-1")?.healthy, false);

  const inventory = await fetch(
    `http://${addresses.proxidize.control.host}:${addresses.proxidize.control.port}/api/v1/perproxy/proxies/mock-account`,
    { headers: { authorization: "Bearer mock-proxidize-token" } },
  );
  const body = (await inventory.json()) as { data: Array<{ host: string; port: number }> };
  assert.equal(body.data[0]?.host, "provider-simulators.internal");
  assert.equal(body.data[0]?.port, 8_093);
});
