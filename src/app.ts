import { ControlApiServer } from "./control-api.js";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { AppConfig } from "./config.js";
import { DynamoRouteStore } from "./dynamo-store.js";
import { ForwardProxyServer } from "./forward-proxy.js";
import type { Logger } from "./logger.js";
import type { BrightDataConfig } from "./providers/bright-data.js";
import type { MobileProviderAdapter, ProviderAdapter } from "./providers/provider.js";
import type { ProxidizeConfig } from "./providers/proxidize.js";
import { createProviderRuntime } from "./provider-runtime.js";
import { RouteService } from "./route-service.js";
import { Socks5ProxyServer } from "./socks5-proxy.js";
import type { BrightDataSimulator } from "./simulators/bright-data.js";
import type { ProxidizeSimulator } from "./simulators/proxidize.js";
import type { RouteStore } from "./store.js";
import { Telemetry } from "./telemetry.js";
import { createTargetValidator, type TargetValidator } from "./target-security.js";
import type { ListenAddress } from "./types.js";

export interface RunningApplication {
  forwardAddress: ListenAddress;
  socks5Address: ListenAddress;
  controlAddress: ListenAddress;
  routes: RouteService;
  simulators?: {
    brightData: BrightDataSimulator;
    proxidize: ProxidizeSimulator;
  };
  stop(): Promise<void>;
}

export interface RunningDataPlaneApplication {
  forwardAddress: ListenAddress;
  socks5Address: ListenAddress;
  routes: RouteService;
  stop(): Promise<void>;
}

export interface RunningControlPlaneApplication {
  controlAddress: ListenAddress;
  routes: RouteService;
  stop(): Promise<void>;
}

export interface ApplicationDependencies {
  targetValidator?: TargetValidator;
  now?: () => number;
  telemetry?: Telemetry;
  storeFactory?: (config: AppConfig) => RouteStore;
  brightDataFactory?: (config: BrightDataConfig) => ProviderAdapter<"bright_data">;
  mobileProviderFactory?: (config: ProxidizeConfig) => MobileProviderAdapter;
  fetchImplementation?: typeof fetch;
}

interface RoutingRuntime {
  routes: RouteService;
  simulators?: RunningApplication["simulators"];
  stop(): Promise<void>;
}

class RoutingRuntimeService extends Context.Tag("Profound/RoutingRuntime")<RoutingRuntimeService, RoutingRuntime>() {}

async function createUnmanagedRoutingRuntime(
  config: AppConfig,
  logger: Logger,
  telemetry: Telemetry,
  proxyAddresses: () => { http: ListenAddress; socks5: ListenAddress },
  dependencies: Pick<
    ApplicationDependencies,
    "now" | "storeFactory" | "brightDataFactory" | "mobileProviderFactory" | "fetchImplementation"
  >,
): Promise<RoutingRuntime> {
  let store: RouteStore;
  if (dependencies.storeFactory !== undefined) store = dependencies.storeFactory(config);
  else store = new DynamoRouteStore(config.routeTableName);
  let providerRuntime: Awaited<ReturnType<typeof createProviderRuntime>> | undefined;

  try {
    providerRuntime = await createProviderRuntime(config, logger, dependencies);
    const routes = new RouteService({
      store,
      brightData: providerRuntime.brightData,
      proxidize: providerRuntime.proxidize,
      proxyAddresses,
      advertisedProxyHost: config.advertisedProxyHost,
      advertisedHttpProxyProtocol: config.advertisedHttpProxyProtocol,
      logger,
      telemetry,
      retryDefaults: config.retryDefaults,
      deploymentId: config.deploymentId,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    return {
      routes,
      ...(providerRuntime.simulators === undefined ? {} : { simulators: providerRuntime.simulators }),
      stop: async () => {
        await providerRuntime?.stop();
        await store.close();
      },
    };
  } catch (error) {
    await providerRuntime?.stop();
    await store.close();
    throw error;
  }
}

async function createRoutingRuntime(
  config: AppConfig,
  logger: Logger,
  telemetry: Telemetry,
  proxyAddresses: () => { http: ListenAddress; socks5: ListenAddress },
  dependencies: Pick<
    ApplicationDependencies,
    "now" | "storeFactory" | "brightDataFactory" | "mobileProviderFactory" | "fetchImplementation"
  >,
): Promise<RoutingRuntime> {
  const managed = ManagedRuntime.make(
    Layer.scoped(
      RoutingRuntimeService,
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => createUnmanagedRoutingRuntime(config, logger, telemetry, proxyAddresses, dependencies),
          catch: (error) => error,
        }),
        (runtime) => Effect.promise(() => runtime.stop()),
      ),
    ),
  );
  try {
    const runtime = await managed.runPromise(RoutingRuntimeService);
    let stopped = false;
    return {
      ...runtime,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await managed.dispose();
      },
    };
  } catch (error) {
    await managed.dispose();
    throw error;
  }
}

/** Offline integration-test harness; production and SST development start split service modes. */
export async function startTestApplication(
  config: AppConfig,
  logger: Logger,
  dependencies: ApplicationDependencies = {},
): Promise<RunningApplication> {
  const ownsTelemetry = dependencies.telemetry === undefined;
  const telemetry =
    dependencies.telemetry ??
    new Telemetry({
      serviceName: config.telemetry.serviceName,
      serviceVersion: config.telemetry.serviceVersion,
      environment: process.env,
    });
  let forwardAddress: ListenAddress | undefined;
  let socks5Address: ListenAddress | undefined;
  const runtime = await createRoutingRuntime(
    config,
    logger,
    telemetry,
    () => {
      if (forwardAddress === undefined || socks5Address === undefined) throw new Error("Data-plane proxies have not started");
      return { http: forwardAddress, socks5: socks5Address };
    },
    dependencies,
  );
  const routes = runtime.routes;
  const forward = new ForwardProxyServer(routes, {
    host: config.forwardHost,
    port: config.forwardPort,
    attemptEstablishmentTimeoutMs: config.attemptEstablishmentTimeoutMs,
    operationEstablishmentTimeoutMs: config.operationEstablishmentTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    streamBufferBytes: config.streamBufferBytes,
    maxHeaderBytes: config.maxHeaderBytes,
    targetValidator:
      dependencies.targetValidator ?? createTargetValidator(config.allowedTargetPorts, undefined, config.blockedTargetHostnames),
    logger,
    telemetry,
  });
  const socks5 = new Socks5ProxyServer(routes, {
    host: config.socks5Host,
    port: config.socks5Port,
    attemptEstablishmentTimeoutMs: config.attemptEstablishmentTimeoutMs,
    operationEstablishmentTimeoutMs: config.operationEstablishmentTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    streamBufferBytes: config.streamBufferBytes,
    maxHandshakeBytes: config.maxHeaderBytes,
    targetValidator:
      dependencies.targetValidator ?? createTargetValidator(config.allowedTargetPorts, undefined, config.blockedTargetHostnames),
    logger,
    telemetry,
  });
  const control = new ControlApiServer(routes, {
    host: config.controlHost,
    port: config.controlPort,
    adminToken: config.adminToken,
    adminUserId: config.adminUserId,
    controlIdentities: config.controlIdentities,
    advertisedProxyHostFromRequest: config.advertisedProxyHost === "request-host",
    logger,
    telemetry,
  });

  try {
    forwardAddress = await forward.start();
    socks5Address = await socks5.start();
    const controlAddress = await control.start();
    await routes.refreshHealth();
    logger.info("Proxy router started", {
      providerMode: config.providerMode,
      forwardAddress,
      socks5Address,
      controlAddress,
    });

    let stopped = false;
    return {
      forwardAddress,
      socks5Address,
      controlAddress,
      routes,
      ...(runtime.simulators === undefined ? {} : { simulators: runtime.simulators }),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await Promise.allSettled([control.stop(), forward.stop(), socks5.stop()]);
        await runtime.stop();
        logger.info("Proxy router stopped");
        if (ownsTelemetry) await telemetry.shutdown();
      },
    };
  } catch (error) {
    await Promise.allSettled([control.stop(), forward.stop(), socks5.stop()]);
    await runtime.stop();
    if (ownsTelemetry) await telemetry.shutdown();
    throw error;
  }
}

export async function startDataPlaneApplication(
  config: AppConfig,
  logger: Logger,
  dependencies: ApplicationDependencies = {},
): Promise<RunningDataPlaneApplication> {
  const ownsTelemetry = dependencies.telemetry === undefined;
  const telemetry =
    dependencies.telemetry ??
    new Telemetry({
      serviceName: config.telemetry.serviceName,
      serviceVersion: config.telemetry.serviceVersion,
      environment: process.env,
    });
  let forwardAddress: ListenAddress | undefined;
  let socks5Address: ListenAddress | undefined;
  const runtime = await createRoutingRuntime(
    config,
    logger,
    telemetry,
    () => {
      if (forwardAddress === undefined || socks5Address === undefined) throw new Error("Data-plane proxies have not started");
      return { http: forwardAddress, socks5: socks5Address };
    },
    dependencies,
  );
  const forward = new ForwardProxyServer(runtime.routes, {
    host: config.forwardHost,
    port: config.forwardPort,
    attemptEstablishmentTimeoutMs: config.attemptEstablishmentTimeoutMs,
    operationEstablishmentTimeoutMs: config.operationEstablishmentTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    streamBufferBytes: config.streamBufferBytes,
    maxHeaderBytes: config.maxHeaderBytes,
    targetValidator:
      dependencies.targetValidator ?? createTargetValidator(config.allowedTargetPorts, undefined, config.blockedTargetHostnames),
    logger,
    telemetry,
  });
  const socks5 = new Socks5ProxyServer(runtime.routes, {
    host: config.socks5Host,
    port: config.socks5Port,
    attemptEstablishmentTimeoutMs: config.attemptEstablishmentTimeoutMs,
    operationEstablishmentTimeoutMs: config.operationEstablishmentTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    streamBufferBytes: config.streamBufferBytes,
    maxHandshakeBytes: config.maxHeaderBytes,
    targetValidator:
      dependencies.targetValidator ?? createTargetValidator(config.allowedTargetPorts, undefined, config.blockedTargetHostnames),
    logger,
    telemetry,
  });
  try {
    forwardAddress = await forward.start();
    socks5Address = await socks5.start();
    await runtime.routes.refreshHealth();
    logger.info("Proxy data plane started", { providerMode: config.providerMode, forwardAddress, socks5Address });
    let stopped = false;
    return {
      forwardAddress,
      socks5Address,
      routes: runtime.routes,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await Promise.allSettled([forward.stop(), socks5.stop()]);
        await runtime.stop();
        if (ownsTelemetry) await telemetry.shutdown();
      },
    };
  } catch (error) {
    await Promise.allSettled([forward.stop(), socks5.stop()]);
    await runtime.stop();
    if (ownsTelemetry) await telemetry.shutdown();
    throw error;
  }
}

export async function startControlPlaneApplication(
  config: AppConfig,
  logger: Logger,
  dependencies: ApplicationDependencies = {},
): Promise<RunningControlPlaneApplication> {
  const ownsTelemetry = dependencies.telemetry === undefined;
  const telemetry =
    dependencies.telemetry ??
    new Telemetry({
      serviceName: config.telemetry.serviceName,
      serviceVersion: config.telemetry.serviceVersion,
      environment: process.env,
    });
  const runtime = await createRoutingRuntime(
    config,
    logger,
    telemetry,
    () => ({
      http: { host: config.advertisedProxyHost, port: config.forwardPort },
      socks5: { host: config.advertisedProxyHost, port: config.socks5Port },
    }),
    dependencies,
  );
  const control = new ControlApiServer(runtime.routes, {
    host: config.controlHost,
    port: config.controlPort,
    adminToken: config.adminToken,
    adminUserId: config.adminUserId,
    controlIdentities: config.controlIdentities,
    advertisedProxyHostFromRequest: config.advertisedProxyHost === "request-host",
    logger,
    telemetry,
  });
  try {
    const controlAddress = await control.start();
    await runtime.routes.refreshHealth();
    logger.info("Proxy control plane started", { providerMode: config.providerMode, controlAddress });
    let stopped = false;
    return {
      controlAddress,
      routes: runtime.routes,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await control.stop();
        await runtime.stop();
        if (ownsTelemetry) await telemetry.shutdown();
      },
    };
  } catch (error) {
    await control.stop();
    await runtime.stop();
    if (ownsTelemetry) await telemetry.shutdown();
    throw error;
  }
}
