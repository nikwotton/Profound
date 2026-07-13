import { ControlApiServer } from "./control-api.js";
import type { AppConfig } from "./config.js";
import { ForwardProxyServer } from "./forward-proxy.js";
import type { Logger } from "./logger.js";
import { BrightDataAdapter } from "./providers/bright-data.js";
import { ProxidizeAdapter } from "./providers/proxidize.js";
import { RouteService } from "./route-service.js";
import { BrightDataSimulator } from "./simulators/bright-data.js";
import { ProxidizeSimulator } from "./simulators/proxidize.js";
import { RouteStore } from "./store.js";
import { Telemetry } from "./telemetry.js";
import type { ListenAddress } from "./types.js";

export interface RunningApplication {
  forwardAddress: ListenAddress;
  controlAddress: ListenAddress;
  routes: RouteService;
  simulators?: {
    brightData: BrightDataSimulator;
    proxidize: ProxidizeSimulator;
  };
  stop(): Promise<void>;
}

export async function startApplication(config: AppConfig, logger: Logger): Promise<RunningApplication> {
  const telemetry = new Telemetry({
    serviceName: config.telemetry.serviceName,
    serviceVersion: config.telemetry.serviceVersion,
    environment: process.env,
  });
  const store = new RouteStore(config.sqlitePath);
  let simulators: RunningApplication["simulators"];
  let brightConfig = config.brightData;
  let proxidizeConfig = config.proxidize;

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
    const [brightAddress, proxidizeAddresses] = await Promise.all([
      brightData.start(),
      proxidize.start(),
    ]);
    simulators = { brightData, proxidize };
    brightConfig = {
      ...config.brightData,
      host: brightAddress.host,
      port: brightAddress.port,
    };
    proxidizeConfig = {
      ...config.proxidize,
      apiBaseUrl: `http://${proxidizeAddresses.control.host}:${proxidizeAddresses.control.port}`,
    };
  }

  const brightData = new BrightDataAdapter({
    ...brightConfig,
    connectTimeoutMs: config.connectTimeoutMs,
  });
  const proxidize = new ProxidizeAdapter({
    ...proxidizeConfig,
    requestTimeoutMs: config.connectTimeoutMs,
  });

  let forwardAddress: ListenAddress | undefined;
  const routes = new RouteService(
    store,
    brightData,
    proxidize,
    () => {
      if (forwardAddress === undefined) throw new Error("Forward proxy has not started");
      return forwardAddress;
    },
    config.advertisedProxyHost,
    logger,
    telemetry,
  );
  const forward = new ForwardProxyServer(routes, {
    host: config.forwardHost,
    port: config.forwardPort,
    allowedTargetPorts: config.allowedTargetPorts,
    connectTimeoutMs: config.connectTimeoutMs,
    logger,
    telemetry,
  });
  const control = new ControlApiServer(routes, {
    host: config.controlHost,
    port: config.controlPort,
    adminToken: config.adminToken,
    logger,
    telemetry,
  });

  try {
    forwardAddress = await forward.start();
    const controlAddress = await control.start();
    await routes.refreshHealth();
    logger.info("Proxy router started", {
      providerMode: config.providerMode,
      forwardAddress,
      controlAddress,
    });

    let stopped = false;
    return {
      forwardAddress,
      controlAddress,
      routes,
      ...(simulators === undefined ? {} : { simulators }),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await Promise.allSettled([
          control.stop(),
          forward.stop(),
          ...(simulators === undefined
            ? []
            : [simulators.brightData.stop(), simulators.proxidize.stop()]),
        ]);
        store.close();
        await telemetry.shutdown();
        logger.info("Proxy router stopped");
      },
    };
  } catch (error) {
    await Promise.allSettled([
      control.stop(),
      forward.stop(),
      ...(simulators === undefined ? [] : [simulators.brightData.stop(), simulators.proxidize.stop()]),
    ]);
    store.close();
    await telemetry.shutdown();
    throw error;
  }
}
