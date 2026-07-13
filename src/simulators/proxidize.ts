import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "../logger.js";
import { closeServer, listen } from "../net-utils.js";
import type { ListenAddress } from "../types.js";
import { MockForwardProxy, type MockIdentity, type SimulatorFailure } from "./mock-forward-proxy.js";

export interface SimulatedMobileDevice {
  id: string;
  username: string;
  password: string;
  country: string;
  region: string;
  city: string;
  carrier: string;
  publicKey: string;
  healthy: boolean;
  exitIp: string;
  rotationIntervalSeconds?: number;
  lastRotatedAt: number;
}

export interface ProxidizeSimulatorOptions {
  host: string;
  controlPort: number;
  dataPort: number;
  apiToken: string;
  logger: Logger;
  devices?: SimulatedMobileDevice[];
}

const DEFAULT_DEVICES: SimulatedMobileDevice[] = [
  {
    id: "px-us-ny-1",
    username: "mobile-ny-tmobile",
    password: "mock-mobile-password-1",
    country: "US",
    region: "NY",
    city: "New York",
    carrier: "T-Mobile",
    publicKey: "rotate-ny-tmobile",
    healthy: true,
    exitIp: "203.0.113.11",
    lastRotatedAt: Date.now(),
  },
  {
    id: "px-us-ny-2",
    username: "mobile-ny-verizon",
    password: "mock-mobile-password-2",
    country: "US",
    region: "NY",
    city: "New York",
    carrier: "Verizon",
    publicKey: "rotate-ny-verizon",
    healthy: true,
    exitIp: "203.0.113.21",
    lastRotatedAt: Date.now(),
  },
  {
    id: "px-us-ca-1",
    username: "mobile-ca-att",
    password: "mock-mobile-password-3",
    country: "US",
    region: "CA",
    city: "Los Angeles",
    carrier: "AT&T",
    publicKey: "rotate-ca-att",
    healthy: true,
    exitIp: "203.0.113.31",
    lastRotatedAt: Date.now(),
  },
];

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

export class ProxidizeSimulator {
  readonly #controlServer;
  readonly #dataProxy: MockForwardProxy;
  readonly #devices: SimulatedMobileDevice[];
  #controlAddress?: ListenAddress;
  #dataAddress?: ListenAddress;
  #failure: SimulatorFailure = null;
  #lastIdentity?: MockIdentity;
  #rotationSequence = 40;

  constructor(private readonly options: ProxidizeSimulatorOptions) {
    this.#devices = structuredClone(options.devices ?? DEFAULT_DEVICES);
    this.#controlServer = createServer((request, response) => {
      void this.#handleControl(request, response);
    });
    this.#dataProxy = new MockForwardProxy({
      host: options.host,
      port: options.dataPort,
      logger: options.logger,
      failure: () => this.#failure,
      authorize: (username, password) => this.#authorizeProxy(username, password),
    });
  }

  async start(): Promise<{ control: ListenAddress; data: ListenAddress }> {
    this.#dataAddress = await this.#dataProxy.start();
    this.#controlAddress = await listen(this.#controlServer, this.options.host, this.options.controlPort);
    return { control: this.#controlAddress, data: this.#dataAddress };
  }

  async stop(): Promise<void> {
    await Promise.all([closeServer(this.#controlServer), this.#dataProxy.stop()]);
  }

  controlAddress(): ListenAddress {
    if (this.#controlAddress === undefined) throw new Error("Proxidize simulator has not started");
    return this.#controlAddress;
  }

  dataAddress(): ListenAddress {
    if (this.#dataAddress === undefined) throw new Error("Proxidize simulator has not started");
    return this.#dataAddress;
  }

  setFailure(failure: SimulatorFailure): void {
    this.#failure = failure;
  }

  setDeviceHealth(id: string, healthy: boolean): void {
    const device = this.#devices.find((candidate) => candidate.id === id);
    if (device === undefined) throw new Error(`Unknown device ${id}`);
    device.healthy = healthy;
  }

  ageDeviceRotation(id: string, milliseconds: number): void {
    const device = this.#devices.find((candidate) => candidate.id === id);
    if (device === undefined) throw new Error(`Unknown device ${id}`);
    device.lastRotatedAt -= milliseconds;
  }

  devices(): SimulatedMobileDevice[] {
    return structuredClone(this.#devices);
  }

  lastIdentity(): MockIdentity | undefined {
    return this.#lastIdentity;
  }

  #rotateDevice(device: SimulatedMobileDevice): void {
    this.#rotationSequence = this.#rotationSequence >= 250 ? 40 : this.#rotationSequence + 1;
    device.exitIp = `203.0.113.${this.#rotationSequence}`;
    device.lastRotatedAt = Date.now();
  }

  #authorizeProxy(username: string, password: string): MockIdentity | undefined {
    const device = this.#devices.find(
      (candidate) => candidate.username === username && candidate.password === password,
    );
    if (device === undefined || !device.healthy) return undefined;
    if (
      device.rotationIntervalSeconds !== undefined &&
      Date.now() - device.lastRotatedAt >= device.rotationIntervalSeconds * 1_000
    ) {
      this.#rotateDevice(device);
    }
    const identity: MockIdentity = {
      id: device.id,
      exitIp: device.exitIp,
      country: device.country,
      region: device.region,
      city: device.city,
      carrier: device.carrier,
    };
    this.#lastIdentity = identity;
    return identity;
  }

  async #handleControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.options.apiToken}`) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://mock.proxidize.local");
    if (request.method === "GET" && url.pathname === "/api/v1/subscription" && url.searchParams.get("type") === "per_proxy") {
      json(response, 200, { data: [{ meta_data: { username: "mock-account" } }] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/perproxy/proxies/mock-account") {
      const dataAddress = this.dataAddress();
      json(response, 200, {
        data: this.#devices.map((device) => ({
          id: device.id,
          session_id: device.id,
          username: device.username,
          password: device.password,
          host: dataAddress.host,
          port: dataAddress.port,
          country: device.country,
          region: device.region,
          city: device.city,
          carrier: device.carrier,
          public_key: device.publicKey,
          healthy: device.healthy,
          status: device.healthy ? "active" : "offline",
        })),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/perproxy/set-rotation-interval") {
      try {
        const body = await readJson(request);
        const device = this.#devices.find(
          (candidate) => candidate.username === body.username && candidate.publicKey === body.public_key,
        );
        if (device === undefined || typeof body.interval !== "number") {
          json(response, 400, { error: "invalid_request" });
          return;
        }
        if (body.interval === -1) delete device.rotationIntervalSeconds;
        else device.rotationIntervalSeconds = body.interval;
        response.writeHead(204);
        response.end();
      } catch {
        json(response, 400, { error: "invalid_json" });
      }
      return;
    }
    const rotation = url.pathname.match(/^\/api\/v1\/perproxy\/rotate-url\/([^/]+)\/?$/);
    if (request.method === "GET" && rotation?.[1] !== undefined) {
      const device = this.#devices.find((candidate) => candidate.publicKey === decodeURIComponent(rotation[1] as string));
      if (device === undefined || !device.healthy) {
        json(response, 404, { error: "proxy_not_found" });
        return;
      }
      this.#rotateDevice(device);
      response.writeHead(204);
      response.end();
      return;
    }
    json(response, 404, { error: "not_found" });
  }
}
