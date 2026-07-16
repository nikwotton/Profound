import { createHash } from "node:crypto";
import { connect } from "node:net";
import { ProviderUnavailableError } from "../errors.js";
import type { ProviderAdapter, ResolveOptions } from "./provider.js";
import type { ProviderHealth, StoredRoute, Targeting, UpstreamEndpoint } from "../types.js";

export interface BrightDataConfig {
  host: string;
  port: number;
  customerId: string;
  zone: string;
  password: string;
  connectTimeoutMs: number;
  statusApiUrl?: string;
  apiKey?: string;
  fetchImplementation?: typeof fetch;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function sessionId(
  route: StoredRoute,
  now: number,
  logicalOperationId = route.id,
  candidateIndex = 0,
): string {
  const bucket = route.rotation.mode === "interval"
    ? Math.floor(now / (route.rotation.intervalSeconds * 1_000))
    : 0;
  const scope = route.rotation.mode === "per_request"
    ? logicalOperationId
    : `${route.session.mode === "sticky" ? route.session.id ?? route.id : route.id}:${bucket}`;
  return createHash("sha256")
    .update(`${scope}:${route.rotationEpoch}:candidate-${candidateIndex}`)
    .digest("hex")
    .slice(0, 20);
}

export function buildBrightDataUsername(
  config: Pick<BrightDataConfig, "customerId" | "zone">,
  route: StoredRoute,
  now = Date.now(),
  assignment: { logicalOperationId?: string; candidateIndex?: number } = {},
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
  const session = sessionId(route, now, assignment.logicalOperationId, assignment.candidateIndex);
  fields.push("session", session);
  return fields.join("-");
}

export class BrightDataAdapter implements ProviderAdapter {
  readonly descriptor = {
    id: "bright_data" as const,
    providerClass: "residential" as const,
    capabilities: {
      clientProtocols: new Set(["http", "https", "socks5"] as const),
      upstreamProtocols: new Set(["http"] as const),
      authenticatedTraffic: true,
      unauthenticatedTraffic: true,
      geography: new Set<keyof Targeting>(["country", "region", "city", "postalCode", "asn", "carrier"]),
      sessions: true,
      exactCity: "provider_guaranteed" as const,
      assignmentControl: {
        providerManagedReassignment: "disabled" as const,
        providerManagedRotation: "disabled" as const,
      },
      rotation: new Set(["per_request", "interval", "manual"] as const),
      targetPorts: "any_public" as const,
      dnsResolution: {
        http: "provider_configurable" as const,
        socks5: "provider_configurable" as const,
      },
    },
    pricing: {
      source: "versioned_config" as const,
      version: "2026-07-13",
      model: "per_gib" as const,
      amountUsd: 8,
    },
    usageDimensions: {
      common: ["bytes_sent", "bytes_received"] as const,
      providerSpecific: ["bandwidth_bytes"] as const,
    },
    costRank: 1,
  };

  constructor(private readonly config: BrightDataConfig) {}

  async resolve(route: StoredRoute, options: ResolveOptions): Promise<UpstreamEndpoint> {
    if (options.signal.aborted) throw new ProviderUnavailableError("Candidate establishment was cancelled");
    const username = buildBrightDataUsername(this.config, route, Date.now(), options);
    const providerSessionId = username.match(/-session-([a-z0-9]+)$/)?.[1] ?? "unknown";
    const candidateId = `bright-data:${providerSessionId}`;
    return {
      provider: this.descriptor.id,
      endpointId: candidateId,
      protocol: "http",
      host: this.config.host,
      port: this.config.port,
      username,
      password: this.config.password,
      assignment: {
        candidateId,
        providerSessionId,
        peerId: candidateId,
        assignmentMode: "provider_guaranteed",
        providerManagedReassignmentDisabled: true,
        changeReason: options.candidateIndex === 0 ? "selection" : "retry",
        ...(route.targeting.city === undefined ? {} : {
          expectedCity: route.targeting.city,
          observedCity: route.targeting.city,
          verificationSource: "provider_guarantee",
        }),
      },
    };
  }

  async rotate(_route: StoredRoute, _signal?: AbortSignal): Promise<void> {
    // The route service increments rotationEpoch. That changes Bright Data's
    // session parameter without requiring a separate control-plane request.
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (this.config.statusApiUrl !== undefined && this.config.apiKey !== undefined) {
      try {
        const timeout = AbortSignal.timeout(this.config.connectTimeoutMs);
        const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
        const response = await (this.config.fetchImplementation ?? fetch)(this.config.statusApiUrl, {
          headers: { authorization: `Bearer ${this.config.apiKey}` },
          signal: requestSignal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { status?: unknown };
        return body.status === true
          ? { provider: this.descriptor.id, state: "healthy", checkedAt }
          : {
              provider: this.descriptor.id,
              state: "unhealthy",
              checkedAt,
              message: "Bright Data reports the residential network unavailable",
            };
      } catch {
        return {
          provider: this.descriptor.id,
          state: "unhealthy",
          checkedAt,
          message: "Bright Data network-status API is unreachable",
        };
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(this.config.port, this.config.host);
        const abort = (): void => {
          socket.destroy(new Error("Health check cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("Connection timed out"));
        }, this.config.connectTimeoutMs);
        socket.once("connect", () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          reject(error);
        });
      });
      return { provider: this.descriptor.id, state: "healthy", checkedAt };
    } catch {
      return {
        provider: this.descriptor.id,
        state: "unhealthy",
        checkedAt,
        message: "Bright Data gateway is unreachable",
      };
    }
  }
}
