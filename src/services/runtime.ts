import type { AppConfig } from "../config.js";
import { expectRecord } from "../decoding.js";
import { callDynamicExport } from "../dynamic-module.js";
import { DynamoRouteStore } from "../dynamo-store.js";
import type { Logger } from "../logger.js";
import type { BrightDataConfig } from "../providers/bright-data.js";
import type { MobileProviderAdapter, ProviderAdapter } from "../providers/provider.js";
import type { ProxidizeConfig } from "../providers/proxidize.js";
import { createProviderRuntime } from "../provider-runtime.js";
import type { RouteStore } from "../store.js";

export interface RunningService {
  stop(): Promise<void>;
}

export async function startDynamicService(modulePath: string, exportName: string, args: readonly unknown[]): Promise<RunningService> {
  const value = expectRecord(await callDynamicExport(modulePath, exportName, args), `${exportName} result`);
  const stop = value["stop"];
  if (typeof stop !== "function") throw new TypeError(`${exportName} must return a stoppable service`);
  return {
    stop: async () => {
      const result: unknown = Reflect.apply(stop, value, []);
      await Promise.resolve(result);
    },
  };
}

export interface RuntimePersistenceConfig {
  routeTableName: string;
}

export interface RuntimeServiceDependencies {
  storeFactory?: (config: RuntimePersistenceConfig) => RouteStore;
  brightDataFactory?: (config: BrightDataConfig) => ProviderAdapter<"bright_data">;
  mobileProviderFactory?: (config: ProxidizeConfig) => MobileProviderAdapter;
  fetchImplementation?: typeof fetch;
}

export function integer(value: string | undefined, fallback: number, name: string, minimum = 1): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
  return parsed;
}

export function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function nonnegativeNumber(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

export function persistenceConfig(env: NodeJS.ProcessEnv): RuntimePersistenceConfig {
  return { routeTableName: required(env["ROUTE_TABLE_NAME"], "ROUTE_TABLE_NAME") };
}

export function appPersistenceConfig(config: AppConfig): RuntimePersistenceConfig {
  return { routeTableName: config.routeTableName };
}

export function createStore(config: RuntimePersistenceConfig, dependencies: RuntimeServiceDependencies): RouteStore {
  return dependencies.storeFactory?.(config) ?? new DynamoRouteStore(config.routeTableName);
}

export async function createHealthProviders(
  config: AppConfig,
  logger: Logger,
  dependencies: RuntimeServiceDependencies,
): Promise<{ providers: ProviderAdapter[]; stop(): Promise<void> }> {
  const runtime = await createProviderRuntime(config, logger, dependencies);
  return {
    providers: [runtime.brightData, runtime.proxidize],
    stop: () => runtime.stop(),
  };
}
