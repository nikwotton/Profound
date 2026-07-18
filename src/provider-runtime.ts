import type { AppConfig } from "./config.js";
import { expectInteger, expectRecord, expectString, isUnknownRecord } from "./decoding.js";
import { callDynamicExport } from "./dynamic-module.js";
import type { Logger } from "./logger.js";
import { BrightDataAdapter, type BrightDataConfig } from "./providers/bright-data.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { ProxidizeAdapter, type ProxidizeConfig } from "./providers/proxidize.js";
import type { BrightDataSimulatorControl, ProxidizeSimulatorControl } from "./provider-simulator-contracts.js";
export type { BrightDataSimulatorControl, ProxidizeSimulatorControl } from "./provider-simulator-contracts.js";

export type ProviderRuntimeConfig = Pick<
  AppConfig,
  "providerMode" | "attemptEstablishmentTimeoutMs" | "proxidizeExactCity" | "brightData" | "proxidize"
>;

export interface ProviderRuntimeDependencies {
  brightDataFactory?: (config: BrightDataConfig) => ProviderAdapter<"bright_data">;
  proxidizeFactory?: (config: ProxidizeConfig) => ProviderAdapter<"proxidize">;
  fetchImplementation?: typeof fetch;
}

export interface ProviderRuntime {
  providers: readonly ProviderAdapter[];
  simulators?: {
    brightData: BrightDataSimulatorControl;
    proxidize: ProxidizeSimulatorControl;
  };
  stop(): Promise<void>;
}

export type ProviderCatalog = Pick<ProviderRuntime, "providers">;

function hasMethod(value: Record<string, unknown>, name: string): boolean {
  return typeof value[name] === "function";
}

function isBrightDataSimulator(value: unknown): value is BrightDataSimulatorControl {
  if (!isUnknownRecord(value)) return false;
  return hasMethod(value, "start") && hasMethod(value, "stop") && hasMethod(value, "setFailure") && hasMethod(value, "lastIdentity");
}

function isProxidizeSimulator(value: unknown): value is ProxidizeSimulatorControl {
  if (!isUnknownRecord(value)) return false;
  return (
    hasMethod(value, "start") &&
    hasMethod(value, "stop") &&
    hasMethod(value, "setFailure") &&
    hasMethod(value, "setDeviceHealth") &&
    hasMethod(value, "devices") &&
    hasMethod(value, "lastIdentity")
  );
}

function decodeProviderSimulatorSetup(value: unknown): {
  simulators: NonNullable<ProviderRuntime["simulators"]>;
  brightAddress: { host: string; port: number };
  proxidizeAddresses: { control: { host: string; port: number } };
} {
  const setup = expectRecord(value, "Provider simulator setup");
  const simulatorValues = expectRecord(setup["simulators"], "Provider simulator controls");
  const brightData = simulatorValues["brightData"];
  const proxidize = simulatorValues["proxidize"];
  if (!isBrightDataSimulator(brightData) || !isProxidizeSimulator(proxidize)) {
    throw new TypeError("Provider simulator setup returned invalid controls");
  }
  const brightAddress = expectRecord(setup["brightAddress"], "Bright Data simulator address");
  const proxidizeAddresses = expectRecord(setup["proxidizeAddresses"], "Proxidize simulator addresses");
  const controlAddress = expectRecord(proxidizeAddresses["control"], "Proxidize control address");
  return {
    simulators: { brightData, proxidize },
    brightAddress: {
      host: expectString(brightAddress["host"], "Bright Data simulator host"),
      port: expectInteger(brightAddress["port"], "Bright Data simulator port", 0, 65_535),
    },
    proxidizeAddresses: {
      control: {
        host: expectString(controlAddress["host"], "Proxidize control host"),
        port: expectInteger(controlAddress["port"], "Proxidize control port", 0, 65_535),
      },
    },
  };
}

export function createProviderCatalog(config: ProviderRuntimeConfig, dependencies: ProviderRuntimeDependencies = {}): ProviderCatalog {
  const brightDataConfig: BrightDataConfig = {
    ...config.brightData,
    connectTimeoutMs: config.attemptEstablishmentTimeoutMs,
    ...(dependencies.fetchImplementation === undefined ? {} : { fetchImplementation: dependencies.fetchImplementation }),
  };
  const proxidizeConfig: ProxidizeConfig = {
    ...config.proxidize,
    requestTimeoutMs: config.attemptEstablishmentTimeoutMs,
    exactCity: config.proxidizeExactCity,
    ...(dependencies.fetchImplementation === undefined ? {} : { fetchImplementation: dependencies.fetchImplementation }),
  };
  return {
    providers: [
      dependencies.brightDataFactory?.(brightDataConfig) ?? new BrightDataAdapter(brightDataConfig),
      dependencies.proxidizeFactory?.(proxidizeConfig) ?? new ProxidizeAdapter(proxidizeConfig),
    ],
  };
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
      const setup = decodeProviderSimulatorSetup(
        await callDynamicExport("./simulators/" + "runtime.js", "startProviderSimulators", [
          {
            logger,
            brightData: config.brightData,
            proxidize: config.proxidize,
          },
        ]),
      );
      simulators = setup.simulators;
      const { brightAddress, proxidizeAddresses } = setup;
      brightConfig = { ...brightConfig, host: brightAddress.host, port: brightAddress.port };
      proxidizeConfig = {
        ...proxidizeConfig,
        apiBaseUrl: `http://${proxidizeAddresses.control.host}:${proxidizeAddresses.control.port}`,
      };
    }

    const { providers } = createProviderCatalog({ ...config, brightData: brightConfig, proxidize: proxidizeConfig }, dependencies);
    let stopped = false;
    return {
      providers,
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
