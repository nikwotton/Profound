import type { Logger } from "../logger.js";
import type { ListenAddress } from "../types.js";
import { MockForwardProxy, type MockIdentity, type SimulatorFailure } from "./mock-forward-proxy.js";

export interface BrightDataSimulatorOptions {
  host: string;
  port: number;
  customerId: string;
  zone: string;
  password: string;
  logger: Logger;
}

export class BrightDataSimulator {
  readonly #proxy: MockForwardProxy;
  readonly #sessions = new Map<string, string>();
  #sequence = 10;
  #failure: SimulatorFailure = null;
  #lastIdentity?: MockIdentity;

  constructor(private readonly options: BrightDataSimulatorOptions) {
    this.#proxy = new MockForwardProxy({
      host: options.host,
      port: options.port,
      logger: options.logger,
      failure: () => this.#failure,
      authorize: (username, password) => this.#authorize(username, password),
    });
  }

  async start(): Promise<ListenAddress> {
    return this.#proxy.start();
  }

  async stop(): Promise<void> {
    await this.#proxy.stop();
  }

  setFailure(failure: SimulatorFailure): void {
    this.#failure = failure;
  }

  lastIdentity(): MockIdentity | undefined {
    return this.#lastIdentity;
  }

  #nextIp(): string {
    this.#sequence = this.#sequence >= 250 ? 10 : this.#sequence + 1;
    return `198.51.100.${this.#sequence}`;
  }

  #authorize(username: string, password: string): MockIdentity | undefined {
    const prefix = `brd-customer-${this.options.customerId.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase()}-zone-${this.options.zone.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase()}`;
    if (password !== this.options.password || !username.startsWith(prefix)) return undefined;
    const suffix = username.slice(prefix.length).replace(/^-/, "");
    const parts = suffix === "" ? [] : suffix.split("-");
    const values = new Map<string, string>();
    for (let index = 0; index < parts.length; index += 2) {
      const key = parts[index];
      const value = parts[index + 1];
      if (key !== undefined && value !== undefined) values.set(key, value);
    }
    const session = values.get("session");
    let exitIp: string;
    if (session === undefined) {
      exitIp = this.#nextIp();
    } else {
      const existing = this.#sessions.get(session);
      exitIp = existing ?? this.#nextIp();
      this.#sessions.set(session, exitIp);
    }
    const region = values.get("state");
    const city = values.get("city");
    const carrier = values.get("carrier");
    const postalCode = values.get("zip");
    const asn = values.get("asn");
    const identity: MockIdentity = {
      id: "bright-data-superproxy",
      exitIp,
      country: (values.get("country") ?? "us").toUpperCase(),
      ...(region === undefined ? {} : { region }),
      ...(city === undefined ? {} : { city }),
      ...(carrier === undefined ? {} : { carrier }),
      extraHeaders: {
        ...(postalCode === undefined ? {} : { "x-mock-postal-code": postalCode }),
        ...(asn === undefined ? {} : { "x-mock-asn": asn }),
        "x-mock-session": session ?? "per-request",
      },
    };
    this.#lastIdentity = identity;
    return identity;
  }
}
