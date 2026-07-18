import type { AppConfig } from "./config.js";
import { ForwardProxyServer } from "./forward-proxy.js";
import type { Logger } from "./logger.js";
import type { RouteService } from "./route-service.js";
import { Socks5ProxyServer } from "./socks5-proxy.js";
import type { TargetValidator } from "./target-security.js";
import type { Telemetry } from "./telemetry.js";
import type { ListenAddress } from "./types.js";

export interface DataPlaneRuntime {
  start(): Promise<{ forwardAddress: ListenAddress; socks5Address: ListenAddress }>;
  stop(): Promise<void>;
}

export function createDataPlaneRuntime(
  routes: RouteService,
  config: AppConfig,
  logger: Logger,
  telemetry: Telemetry,
  targetValidator: TargetValidator,
): DataPlaneRuntime {
  const common = {
    attemptEstablishmentTimeoutMs: config.attemptEstablishmentTimeoutMs,
    operationEstablishmentTimeoutMs: config.operationEstablishmentTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    streamBufferBytes: config.streamBufferBytes,
    targetValidator,
    logger,
    telemetry,
  };
  const forward = new ForwardProxyServer(routes, {
    ...common,
    host: config.forwardHost,
    port: config.forwardPort,
    maxHeaderBytes: config.maxHeaderBytes,
  });
  const socks5 = new Socks5ProxyServer(routes, {
    ...common,
    host: config.socks5Host,
    port: config.socks5Port,
    maxHandshakeBytes: config.maxHeaderBytes,
  });
  return {
    start: async () => {
      const forwardAddress = await forward.start();
      try {
        const socks5Address = await socks5.start();
        return { forwardAddress, socks5Address };
      } catch (error) {
        await forward.stop();
        throw error;
      }
    },
    stop: async () => {
      await Promise.allSettled([forward.stop(), socks5.stop()]);
    },
  };
}
