import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "../logger.js";
import { closeServer, listen } from "../net-utils.js";
import type { ListenAddress } from "../types.js";
import { BrightDataSimulator } from "./bright-data.js";
import { type MockIdentity, type SimulatorFailure } from "./mock-forward-proxy.js";
import { ProxidizeSimulator } from "./proxidize.js";

export interface ProviderSimulatorServiceOptions {
  host: string;
  brightDataPort: number;
  proxidizeControlPort: number;
  proxidizeDataPort: number;
  adminPort: number;
  adminToken: string;
  brightDataCustomerId: string;
  brightDataZone: string;
  brightDataPassword: string;
  proxidizeApiToken: string;
  proxidizeAdvertisedDataHost?: string;
  proxidizeAdvertisedDataPort?: number;
  logger: Logger;
}

export interface ProviderSimulatorAddresses {
  brightData: ListenAddress;
  proxidize: { control: ListenAddress; data: ListenAddress };
  admin: ListenAddress;
}

export interface ProviderSimulatorDeviceState {
  id: string;
  country: string;
  region: string;
  city: string;
  carrier: string;
  healthy: boolean;
  exitIp: string;
  rotationIntervalSeconds?: number;
  lastRotatedAt: number;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 64 * 1024) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Object required");
  return parsed as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

function failure(value: unknown): SimulatorFailure | undefined {
  return value === null || value === "auth" || value === "unavailable" || value === "rate_limit" || value === "timeout" ? value : undefined;
}

function deviceState(device: ReturnType<ProxidizeSimulator["devices"]>[number]): ProviderSimulatorDeviceState {
  return {
    id: device.id,
    country: device.country,
    region: device.region,
    city: device.city,
    carrier: device.carrier,
    healthy: device.healthy,
    exitIp: device.exitIp,
    ...(device.rotationIntervalSeconds === undefined ? {} : { rotationIntervalSeconds: device.rotationIntervalSeconds }),
    lastRotatedAt: device.lastRotatedAt,
  };
}

export class ProviderSimulatorService {
  readonly brightData: BrightDataSimulator;
  readonly proxidize: ProxidizeSimulator;
  readonly #adminServer;
  #addresses?: ProviderSimulatorAddresses;

  constructor(private readonly options: ProviderSimulatorServiceOptions) {
    this.brightData = new BrightDataSimulator({
      host: options.host,
      port: options.brightDataPort,
      customerId: options.brightDataCustomerId,
      zone: options.brightDataZone,
      password: options.brightDataPassword,
      logger: options.logger,
    });
    this.proxidize = new ProxidizeSimulator({
      host: options.host,
      controlPort: options.proxidizeControlPort,
      dataPort: options.proxidizeDataPort,
      apiToken: options.proxidizeApiToken,
      ...(options.proxidizeAdvertisedDataHost === undefined ? {} : { advertisedDataHost: options.proxidizeAdvertisedDataHost }),
      ...(options.proxidizeAdvertisedDataPort === undefined ? {} : { advertisedDataPort: options.proxidizeAdvertisedDataPort }),
      logger: options.logger,
    });
    this.#adminServer = createServer((request, response) => {
      void this.#handleAdmin(request, response);
    });
  }

  async start(): Promise<ProviderSimulatorAddresses> {
    try {
      const [brightData, proxidize] = await Promise.all([this.brightData.start(), this.proxidize.start()]);
      const admin = await listen(this.#adminServer, this.options.host, this.options.adminPort);
      this.#addresses = { brightData, proxidize, admin };
      this.options.logger.info("Provider simulator service started", { brightData, proxidize, admin });
      return this.#addresses;
    } catch (error) {
      await Promise.allSettled([closeServer(this.#adminServer), this.brightData.stop(), this.proxidize.stop()]);
      throw error;
    }
  }

  addresses(): ProviderSimulatorAddresses {
    if (this.#addresses === undefined) throw new Error("Provider simulator service has not started");
    return this.#addresses;
  }

  async stop(): Promise<void> {
    await Promise.allSettled([closeServer(this.#adminServer), this.brightData.stop(), this.proxidize.stop()]);
  }

  async #handleAdmin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://provider-simulators.local");
    if (request.method === "GET" && (url.pathname === "/health/live" || url.pathname === "/health/ready")) {
      json(response, 200, { status: url.pathname.endsWith("ready") ? "ready" : "live" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.options.adminToken}`) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/providers/bright-data/last-identity") {
      json(response, 200, { identity: this.brightData.lastIdentity() ?? null });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/providers/proxidize/last-identity") {
      json(response, 200, { identity: this.proxidize.lastIdentity() ?? null });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/providers/proxidize/devices") {
      json(response, 200, { devices: this.proxidize.devices().map(deviceState) });
      return;
    }
    const failureMatch = url.pathname.match(/^\/v1\/providers\/(bright-data|proxidize)\/failure$/);
    if (request.method === "PUT" && failureMatch?.[1] !== undefined) {
      try {
        const body = await readJson(request);
        const nextFailure = failure(body.failure);
        if (nextFailure === undefined) {
          json(response, 400, { error: "invalid_failure" });
          return;
        }
        if (failureMatch[1] === "bright-data") this.brightData.setFailure(nextFailure);
        else this.proxidize.setFailure(nextFailure);
        response.writeHead(204);
        response.end();
      } catch {
        json(response, 400, { error: "invalid_json" });
      }
      return;
    }
    const healthMatch = url.pathname.match(/^\/v1\/providers\/proxidize\/devices\/([^/]+)\/health$/);
    if (request.method === "PUT" && healthMatch?.[1] !== undefined) {
      try {
        const body = await readJson(request);
        if (typeof body.healthy !== "boolean") {
          json(response, 400, { error: "invalid_health" });
          return;
        }
        this.proxidize.setDeviceHealth(decodeURIComponent(healthMatch[1]), body.healthy);
        response.writeHead(204);
        response.end();
      } catch (error) {
        json(response, error instanceof SyntaxError ? 400 : 404, { error: "device_not_found" });
      }
      return;
    }
    const ageMatch = url.pathname.match(/^\/v1\/providers\/proxidize\/devices\/([^/]+)\/age-rotation$/);
    if (request.method === "POST" && ageMatch?.[1] !== undefined) {
      try {
        const body = await readJson(request);
        if (typeof body.milliseconds !== "number" || !Number.isFinite(body.milliseconds) || body.milliseconds < 0) {
          json(response, 400, { error: "invalid_milliseconds" });
          return;
        }
        this.proxidize.ageDeviceRotation(decodeURIComponent(ageMatch[1]), body.milliseconds);
        response.writeHead(204);
        response.end();
      } catch (error) {
        json(response, error instanceof SyntaxError ? 400 : 404, { error: "device_not_found" });
      }
      return;
    }
    json(response, 404, { error: "not_found" });
  }
}

export class ProviderSimulatorAdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async setFailure(provider: "bright-data" | "proxidize", nextFailure: SimulatorFailure): Promise<void> {
    await this.#request(`/v1/providers/${provider}/failure`, {
      method: "PUT",
      body: JSON.stringify({ failure: nextFailure }),
    });
  }

  async setDeviceHealth(id: string, healthy: boolean): Promise<void> {
    await this.#request(`/v1/providers/proxidize/devices/${encodeURIComponent(id)}/health`, {
      method: "PUT",
      body: JSON.stringify({ healthy }),
    });
  }

  async ageDeviceRotation(id: string, milliseconds: number): Promise<void> {
    await this.#request(`/v1/providers/proxidize/devices/${encodeURIComponent(id)}/age-rotation`, {
      method: "POST",
      body: JSON.stringify({ milliseconds }),
    });
  }

  async devices(): Promise<ProviderSimulatorDeviceState[]> {
    const body = await this.#request<{ devices: ProviderSimulatorDeviceState[] }>("/v1/providers/proxidize/devices");
    return body.devices;
  }

  async lastIdentity(provider: "bright-data" | "proxidize"): Promise<MockIdentity | null> {
    const body = await this.#request<{ identity: MockIdentity | null }>(`/v1/providers/${provider}/last-identity`);
    return body.identity;
  }

  async #request<T = void>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`Provider simulator administration returned ${response.status}`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
