import { createHash } from "node:crypto";
import { connect } from "node:net";
import { ProviderUnavailableError } from "../errors.js";
import type { ProviderAdapter } from "./provider.js";
import type { ProviderHealth, StoredRoute, UpstreamEndpoint } from "../types.js";

export interface BrightDataConfig {
  host: string;
  port: number;
  customerId: string;
  zone: string;
  password: string;
  connectTimeoutMs: number;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function sessionId(route: StoredRoute, now: number): string | undefined {
  if (route.rotation.mode === "per_request") return undefined;
  const bucket = route.rotation.mode === "interval"
    ? Math.floor(now / (route.rotation.intervalSeconds * 1_000))
    : 0;
  return createHash("sha256")
    .update(`${route.id}:${route.rotationEpoch}:${bucket}`)
    .digest("hex")
    .slice(0, 20);
}

export function buildBrightDataUsername(
  config: Pick<BrightDataConfig, "customerId" | "zone">,
  route: StoredRoute,
  now = Date.now(),
): string {
  const fields = [
    "brd",
    "customer",
    compact(config.customerId),
    "zone",
    compact(config.zone),
    "country",
    route.targeting.country.toLowerCase(),
  ];
  if (route.targeting.region !== undefined) fields.push("state", compact(route.targeting.region));
  if (route.targeting.city !== undefined) fields.push("city", compact(route.targeting.city));
  if (route.targeting.postalCode !== undefined) fields.push("zip", route.targeting.postalCode);
  if (route.targeting.asn !== undefined) fields.push("asn", String(route.targeting.asn));
  if (route.targeting.carrier !== undefined) fields.push("carrier", compact(route.targeting.carrier));
  const session = sessionId(route, now);
  if (session !== undefined) fields.push("session", session);
  return fields.join("-");
}

export class BrightDataAdapter implements ProviderAdapter {
  readonly provider = "bright_data" as const;

  constructor(private readonly config: BrightDataConfig) {}

  async resolve(route: StoredRoute): Promise<UpstreamEndpoint> {
    if (route.kind !== "residential") {
      throw new ProviderUnavailableError("Bright Data adapter received a non-residential route");
    }
    return {
      provider: this.provider,
      endpointId: "bright-data-superproxy",
      host: this.config.host,
      port: this.config.port,
      username: buildBrightDataUsername(this.config, route),
      password: this.config.password,
    };
  }

  async rotate(_route: StoredRoute): Promise<void> {
    // The route service increments rotationEpoch. That changes Bright Data's
    // session parameter without requiring a separate control-plane request.
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(this.config.port, this.config.host);
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("Connection timed out"));
        }, this.config.connectTimeoutMs);
        socket.once("connect", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      return { provider: this.provider, state: "healthy", checkedAt };
    } catch {
      return {
        provider: this.provider,
        state: "unhealthy",
        checkedAt,
        message: "Bright Data gateway is unreachable",
      };
    }
  }
}
