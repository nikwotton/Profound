import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { BrightDataAdapter, type BrightDataConfig } from "./providers/bright-data.js";
import type { MobileProviderAdapter, ProviderAdapter } from "./providers/provider.js";
import { ProxidizeAdapter, type ProxidizeConfig } from "./providers/proxidize.js";
import { BrightDataSimulator } from "./simulators/bright-data.js";
import { ProxidizeSimulator } from "./simulators/proxidize.js";

export type ProviderRuntimeConfig = Pick<
  AppConfig,
  "providerMode" | "attemptEstablishmentTimeoutMs" | "proxidizeExactCity" | "brightData" | "proxidize"
>;

export interface ProviderRuntimeDependencies {
  brightDataFactory?: (config: BrightDataConfig) => ProviderAdapter<"bright_data">;
  mobileProviderFactory?: (config: ProxidizeConfig) => MobileProviderAdapter;
  fetchImplementation?: typeof fetch;
}

export interface ProviderRuntime {
  brightData: ProviderAdapter<"bright_data">;
  proxidize: MobileProviderAdapter;
  simulators?: {
    brightData: BrightDataSimulator;
    proxidize: ProxidizeSimulator;
  };
  stop(): Promise<void>;
}

/**
 * Acquires provider adapters and their optional local simulators as one scope.
 * Partial startup is cleaned up before an error is returned to the caller.
 */
export async function createProviderRuntime(
  config: ProviderRuntimeConfig,
  logger: Logger,
  dependencies: ProviderRuntimeDependencies = {},
): Promise<ProviderRuntime> {
  let simulators: ProviderRuntime["simulators"];
  let brightConfig = config.brightData;
  let proxidizeConfig = config.proxidize;

  try {
    if (config.providerMode === "mock") {
      const brightData = new BrightDataSimulator({
        host: "127.0.0.1",
        port: 0,
        customerId: config.brightData.customerId,
        zone: config.brightData.zone,
        password: config.brightData.password,
        logger,
      });
      const proxidize = new ProxidizeSimulator({
        host: "127.0.0.1",
        controlPort: 0,
        dataPort: 0,
        apiToken: config.proxidize.apiToken,
        logger,
      });
      simulators = { brightData, proxidize };
      const brightAddress = await brightData.start();
      const proxidizeAddresses = await proxidize.start();
      brightConfig = { ...brightConfig, host: brightAddress.host, port: brightAddress.port };
      proxidizeConfig = {
        ...proxidizeConfig,
        apiBaseUrl: `http://${proxidizeAddresses.control.host}:${proxidizeAddresses.control.port}`,
      };
    }

    const brightDataAdapterConfig: BrightDataConfig = {
      ...brightConfig,
      connectTimeoutMs: config.attemptEstablishmentTimeoutMs,
      ...(dependencies.fetchImplementation === undefined ? {} : { fetchImplementation: dependencies.fetchImplementation }),
    };
    const proxidizeAdapterConfig: ProxidizeConfig = {
      ...proxidizeConfig,
      requestTimeoutMs: config.attemptEstablishmentTimeoutMs,
      exactCity: config.proxidizeExactCity,
      ...(dependencies.fetchImplementation === undefined ? {} : { fetchImplementation: dependencies.fetchImplementation }),
    };
    const brightData = dependencies.brightDataFactory?.(brightDataAdapterConfig) ?? new BrightDataAdapter(brightDataAdapterConfig);
    const proxidize = dependencies.mobileProviderFactory?.(proxidizeAdapterConfig) ?? new ProxidizeAdapter(proxidizeAdapterConfig);
    let stopped = false;
    return {
      brightData,
      proxidize,
      ...(simulators === undefined ? {} : { simulators }),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await Promise.allSettled([...(simulators === undefined ? [] : [simulators.brightData.stop(), simulators.proxidize.stop()])]);
      },
    };
  } catch (error) {
    await Promise.allSettled([...(simulators === undefined ? [] : [simulators.brightData.stop(), simulators.proxidize.stop()])]);
    throw error;
  }
}
