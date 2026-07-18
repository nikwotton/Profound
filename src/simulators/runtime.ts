import type { Logger } from "../logger.js";
import { BrightDataSimulator } from "./bright-data.js";
import { ProxidizeSimulator } from "./proxidize.js";

export async function startProviderSimulators(options: {
  logger: Logger;
  brightData: { customerId: string; zone: string; password: string };
  proxidize: { apiToken: string };
}) {
  const brightData = new BrightDataSimulator({
    host: "127.0.0.1",
    port: 0,
    customerId: options.brightData.customerId,
    zone: options.brightData.zone,
    password: options.brightData.password,
    logger: options.logger,
  });
  const proxidize = new ProxidizeSimulator({
    host: "127.0.0.1",
    controlPort: 0,
    dataPort: 0,
    apiToken: options.proxidize.apiToken,
    logger: options.logger,
  });
  const brightAddress = await brightData.start();
  const proxidizeAddresses = await proxidize.start();
  return { simulators: { brightData, proxidize }, brightAddress, proxidizeAddresses };
}
