import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Schema } from "effect";
import { expectBufferChunk, isUnknownRecord, parseJson } from "./decoding.js";
import type { HealthAlertEvaluator } from "./alerting.js";
import type { Logger } from "./logger.js";
import type { ProviderAdapter } from "./providers/provider.js";
import type { CapabilityHealthRepository, ProviderHealthRepository, UsageRepository } from "./store.js";
import type {
  CapabilityHealth,
  CapabilityHealthSnapshot,
  CapabilityName,
  GeographyHealth,
  PassiveHealthSignal,
  ProviderHealth,
  SyntheticValidationResult,
} from "./domain/health.js";
import type { CapacityPressureEvidence } from "./domain/usage.js";
import type { ListenAddress } from "./domain/network.js";
import type { ProviderClass } from "./domain/routing.js";

export interface SyntheticValidationScope {
  capability?: Exclude<CapabilityName, "health_verification">;
  country?: string;
  city?: string;
}

const SyntheticValidationScopeSchema: Schema.Schema<SyntheticValidationScope> = Schema.Struct({
  capability: Schema.optionalWith(Schema.Literal("all_traffic", "managed_sessions", "stateless_traffic"), { exact: true }),
  country: Schema.optionalWith(Schema.String, { exact: true }),
  city: Schema.optionalWith(Schema.String, { exact: true }),
}).annotations({ identifier: "SyntheticValidationScope", parseOptions: { onExcessProperty: "error" } });

export function decodeSyntheticValidationScope(value: unknown): SyntheticValidationScope {
  return Schema.decodeUnknownSync(SyntheticValidationScopeSchema)(value);
}

export interface SyntheticValidator {
  validate(scope: SyntheticValidationScope): Promise<SyntheticValidationResult>;
}

export class CooldownSyntheticValidator implements SyntheticValidator {
  #inFlight: Promise<SyntheticValidationResult> | undefined;
  #lastCompletedAt = 0;
  #lastResult?: SyntheticValidationResult;

  constructor(
    private readonly probe: (scope: SyntheticValidationScope) => Promise<SyntheticValidationResult>,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async validate(scope: SyntheticValidationScope): Promise<SyntheticValidationResult> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    if (this.#lastResult !== undefined && this.now() - this.#lastCompletedAt < this.cooldownMs) {
      return this.#lastResult;
    }
    this.#inFlight = this.probe(scope).finally(() => {
      this.#lastCompletedAt = this.now();
      this.#inFlight = undefined;
    });
    this.#lastResult = await this.#inFlight;
    return this.#lastResult;
  }
}

export interface CapabilityHealthAggregatorOptions {
  passiveValidationMaxAgeMs: number;
  capacityPressureMaxAgeMs?: number;
  syntheticValidator?: SyntheticValidator;
  alerting?: HealthAlertEvaluator;
  now?: () => number;
}

type HealthAggregationStore = ProviderHealthRepository & CapabilityHealthRepository & Pick<UsageRepository, "listCapacityPressureEvidence">;

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  const timestamps = values.filter((value): value is string => value !== undefined).sort();
  return timestamps.at(-1);
}

function preferredClassStatus(
  providers: Array<{ providerClass: ProviderClass; health: ProviderHealth }>,
  preferredClass: ProviderClass,
  capacityPressureProviders: ReadonlySet<ProviderHealth["provider"]>,
): CapabilityHealth["status"] {
  const state = ({ health }: { health: ProviderHealth }): ProviderHealth["state"] =>
    health.state === "healthy" && capacityPressureProviders.has(health.provider) ? "degraded" : health.state;
  const preferred = providers.filter((provider) => provider.providerClass === preferredClass);
  if (preferred.some((provider) => state(provider) === "healthy")) return "operational";
  if (preferred.some((provider) => state(provider) === "degraded")) return "degraded";
  return providers.some((provider) => state(provider) !== "unhealthy") ? "degraded" : "unavailable";
}

function combinedTrafficStatus(managed: CapabilityHealth["status"], stateless: CapabilityHealth["status"]): CapabilityHealth["status"] {
  if (managed === "operational" && stateless === "operational") return "operational";
  if (managed === "unavailable" && stateless === "unavailable") return "unavailable";
  return "degraded";
}

function isPassiveSignal(value: unknown): value is PassiveHealthSignal {
  if (!isUnknownRecord(value)) return false;
  return (
    typeof value["provider"] === "string" &&
    value["provider"].length > 0 &&
    value["provider"] !== "unresolved" &&
    (value["capability"] === "all_traffic" || value["capability"] === "managed_sessions" || value["capability"] === "stateless_traffic") &&
    (value["outcome"] === "success" || value["outcome"] === "failure") &&
    typeof value["observedAt"] === "string" &&
    Number.isFinite(Date.parse(value["observedAt"]))
  );
}

function otlpScalar(value: unknown): string | number | boolean | undefined {
  if (!isUnknownRecord(value)) return undefined;
  if (typeof value["stringValue"] === "string") return value["stringValue"];
  if (typeof value["boolValue"] === "boolean") return value["boolValue"];
  if (typeof value["intValue"] === "string" || typeof value["intValue"] === "number") return value["intValue"];
  if (typeof value["doubleValue"] === "number") return value["doubleValue"];
  return undefined;
}

function otlpTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  try {
    return new Date(Number(BigInt(value) / 1_000_000n)).toISOString();
  } catch {
    return undefined;
  }
}

export function passiveSignalsFromOtlpJson(value: unknown): PassiveHealthSignal[] {
  if (!isUnknownRecord(value)) {
    throw new Error("invalid_otlp_logs");
  }
  const resourceLogs = value["resourceLogs"];
  if (!Array.isArray(resourceLogs)) throw new Error("invalid_otlp_logs");
  const signals: PassiveHealthSignal[] = [];
  for (const resourceLog of resourceLogs) {
    if (!isUnknownRecord(resourceLog)) continue;
    const scopeLogs = Array.isArray(resourceLog["scopeLogs"])
      ? resourceLog["scopeLogs"]
      : Array.isArray(resourceLog["instrumentationLibraryLogs"])
        ? resourceLog["instrumentationLibraryLogs"]
        : [];
    for (const scopeLog of scopeLogs) {
      if (!isUnknownRecord(scopeLog)) continue;
      const logRecords = scopeLog["logRecords"];
      if (!Array.isArray(logRecords)) continue;
      for (const logRecord of logRecords) {
        if (!isUnknownRecord(logRecord)) continue;
        const attributes = new Map<string, string | number | boolean>();
        if (Array.isArray(logRecord["attributes"])) {
          for (const attribute of logRecord["attributes"]) {
            if (!isUnknownRecord(attribute)) continue;
            const scalar = otlpScalar(attribute["value"]);
            if (typeof attribute["key"] === "string" && scalar !== undefined) attributes.set(attribute["key"], scalar);
          }
        }
        const body = otlpScalar(logRecord["body"]);
        const eventName = attributes.get("event.name");
        if (body !== "profound.proxy.passive_health" && eventName !== "profound.proxy.passive_health") continue;
        const signal = {
          provider: attributes.get("proxy.provider"),
          capability: attributes.get("proxy.capability"),
          outcome: attributes.get("proxy.outcome"),
          observedAt: attributes.get("proxy.observed_at") ?? otlpTimestamp(logRecord["timeUnixNano"]),
          ...(typeof attributes.get("proxy.country") === "string" ? { country: attributes.get("proxy.country") } : {}),
          ...(typeof attributes.get("proxy.city") === "string" ? { city: attributes.get("proxy.city") } : {}),
        };
        if (!isPassiveSignal(signal)) throw new Error("invalid_passive_signal");
        signals.push(signal);
      }
    }
  }
  return signals;
}

export class CapabilityHealthAggregator {
  readonly #passiveSignals = new Map<string, PassiveHealthSignal>();
  #lastSynthetic?: SyntheticValidationResult;

  constructor(
    private readonly store: HealthAggregationStore,
    private readonly providers: readonly ProviderAdapter[],
    private readonly options: CapabilityHealthAggregatorOptions,
    private readonly logger: Logger,
  ) {}

  recordPassiveSignal(signal: PassiveHealthSignal): void {
    if (!isPassiveSignal(signal)) throw new Error("Invalid passive health signal");
    const key = `${signal.provider}:${signal.capability}:${signal.country ?? "*"}:${signal.city ?? "*"}`;
    const existing = this.#passiveSignals.get(key);
    if (existing === undefined || existing.observedAt < signal.observedAt) this.#passiveSignals.set(key, signal);
  }

  async refresh(options: { forceSynthetic?: boolean; scope?: SyntheticValidationScope } = {}): Promise<CapabilityHealthSnapshot> {
    const now = this.options.now?.() ?? Date.now();
    const providerHealth = await Promise.all(this.providers.map((provider) => provider.health()));
    await Promise.all(providerHealth.map((health) => this.store.saveHealth(health)));
    const recentPassive = [...this.#passiveSignals.values()].filter(
      (signal) => now - Date.parse(signal.observedAt) <= this.options.passiveValidationMaxAgeMs,
    );
    const capacityPressureMaxAgeMs = this.options.capacityPressureMaxAgeMs ?? this.options.passiveValidationMaxAgeMs;
    const capacityPressure = (await this.store.listCapacityPressureEvidence(new Date(now - capacityPressureMaxAgeMs).toISOString())).filter(
      (evidence) => Date.parse(evidence.observedAt) <= now,
    );
    const conflict = recentPassive.some((signal) => {
      const provider = providerHealth.find((health) => health.provider === signal.provider);
      return provider !== undefined && (provider.state === "unhealthy") === (signal.outcome === "success");
    });
    if ((options.forceSynthetic === true || conflict) && this.options.syntheticValidator !== undefined) {
      this.#lastSynthetic = await this.options.syntheticValidator.validate(options.scope ?? {});
    }
    const previous = await this.store.latestCapabilityHealth();
    const previousGeneratedAt = previous === undefined ? Number.NaN : Date.parse(previous.generatedAt);
    const generatedAt = Number.isFinite(previousGeneratedAt) ? Math.max(now, previousGeneratedAt + 1) : now;
    const snapshot = this.#buildSnapshot(providerHealth, recentPassive, capacityPressure, this.#lastSynthetic, previous, generatedAt);
    await this.store.saveCapabilityHealth(snapshot);
    this.logger.info("Capability health snapshot saved", {
      snapshotId: snapshot.id,
      generatedAt: snapshot.generatedAt,
      capabilities: Object.fromEntries(snapshot.capabilities.map((capability) => [capability.capability, capability.status])),
      passiveSignals: recentPassive.length,
      capacityPressureEvidence: capacityPressure.length,
      capacityPressureProviders: [...new Set(capacityPressure.map((evidence) => evidence.provider))],
      syntheticOutcome: this.#lastSynthetic?.outcome ?? "not_run",
      syntheticGeoStatus: this.#lastSynthetic?.geoStatus ?? "not_observed",
      syntheticGeographyVerification: this.#lastSynthetic?.geographyVerification ?? "not_run",
    });
    if (this.options.alerting !== undefined) {
      const staleCapabilities = snapshot.capabilities
        .filter(
          (capability) =>
            capability.endToEndValidatedAt === undefined ||
            generatedAt - Date.parse(capability.endToEndValidatedAt) > this.options.passiveValidationMaxAgeMs,
        )
        .map((capability) => capability.capability);
      try {
        await this.options.alerting.evaluate(snapshot, { conflicting: conflict, staleCapabilities });
      } catch (error) {
        this.logger.error("Health alert processing failed", {
          "event.name": "profound.health.alerting_failure",
          snapshotId: snapshot.id,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return snapshot;
  }

  #buildSnapshot(
    providerHealth: ProviderHealth[],
    passive: PassiveHealthSignal[],
    capacityPressure: CapacityPressureEvidence[],
    synthetic: SyntheticValidationResult | undefined,
    previous: CapabilityHealthSnapshot | undefined,
    now: number,
  ): CapabilityHealthSnapshot {
    const healthByProvider = new Map(providerHealth.map((health) => [health.provider, health]));
    const providersFor = () =>
      this.providers
        .map((provider) => ({
          providerClass: provider.descriptor.providerClass,
          health: healthByProvider.get(provider.descriptor.id),
        }))
        .filter((provider): provider is { providerClass: ProviderClass; health: ProviderHealth } => provider.health !== undefined);
    const managedProviders = providersFor();
    const statelessProviders = providersFor();
    const capacityPressureProviders = new Set(capacityPressure.map((evidence) => evidence.provider));
    const managedStatus = preferredClassStatus(managedProviders, "device_backed", capacityPressureProviders);
    const statelessStatus = preferredClassStatus(statelessProviders, "residential", capacityPressureProviders);
    const validationAt = (capability: Exclude<CapabilityName, "health_verification">): string | undefined =>
      latestTimestamp([
        ...passive
          .filter((signal) => signal.capability === capability || signal.capability === "all_traffic")
          .map((signal) => signal.observedAt),
        synthetic?.outcome === "success" ? synthetic.checkedAt : undefined,
        previous?.capabilities.find((entry) => entry.capability === capability)?.endToEndValidatedAt,
      ]);
    const capability = (
      name: Exclude<CapabilityName, "health_verification">,
      statusFromProviders: CapabilityHealth["status"],
      providers: ProviderHealth[],
    ): CapabilityHealth => {
      let status = statusFromProviders;
      const failedPassive = passive.some(
        (signal) => (signal.capability === name || signal.capability === "all_traffic") && signal.outcome === "failure",
      );
      if (status === "operational" && (failedPassive || synthetic?.outcome === "proxy_failure")) status = "degraded";
      const providerStatusAt = latestTimestamp(providers.map((health) => health.checkedAt));
      const endToEndValidatedAt = validationAt(name);
      const capacityConstrained = status === "degraded" && providers.some((provider) => capacityPressureProviders.has(provider.provider));
      return {
        capability: name,
        status,
        ...(providerStatusAt === undefined ? {} : { providerStatusAt }),
        ...(endToEndValidatedAt === undefined ? {} : { endToEndValidatedAt }),
        ...(capacityConstrained ? { message: "Fresh capacity-pressure evidence constrained this capability" } : {}),
      };
    };
    const previousCanary = previous?.capabilities.find((entry) => entry.capability === "health_verification");
    const canaryStatus: CapabilityHealth =
      synthetic === undefined && previousCanary !== undefined
        ? { ...previousCanary }
        : {
            capability: "health_verification",
            status:
              synthetic === undefined
                ? "degraded"
                : synthetic.outcome === "inconclusive"
                  ? "degraded"
                  : synthetic.outcome === "success" && synthetic.geographyVerification !== "match"
                    ? "degraded"
                    : "operational",
            ...(synthetic === undefined
              ? { message: "No synthetic validation has run" }
              : {
                  endToEndValidatedAt: synthetic.checkedAt,
                  ...(synthetic.message === undefined ? {} : { message: synthetic.message }),
                }),
          };
    const managedCapability = capability(
      "managed_sessions",
      managedStatus,
      managedProviders.map(({ health }) => health),
    );
    const statelessCapability = capability(
      "stateless_traffic",
      statelessStatus,
      statelessProviders.map(({ health }) => health),
    );
    const allTrafficCapability = capability(
      "all_traffic",
      combinedTrafficStatus(managedCapability.status, statelessCapability.status),
      providerHealth,
    );
    const geographies = new Map<string, GeographyHealth>(
      previous?.geographies.map((geography) => [`${geography.country}:${geography.city ?? "*"}`, geography]) ?? [],
    );
    for (const signal of passive) {
      if (signal.country === undefined) continue;
      const key = `${signal.country}:${signal.city ?? "*"}`;
      geographies.set(key, {
        country: signal.country,
        ...(signal.city === undefined ? {} : { city: signal.city }),
        status: signal.outcome === "success" ? "operational" : "degraded",
        validatedAt: signal.observedAt,
        source: "passive",
      });
    }
    if (synthetic?.expectedCountry !== undefined && synthetic.geographyVerification !== "unverifiable") {
      const key = `${synthetic.expectedCountry}:${synthetic.expectedCity ?? "*"}`;
      geographies.set(key, {
        country: synthetic.expectedCountry,
        ...(synthetic.expectedCity === undefined ? {} : { city: synthetic.expectedCity }),
        status: synthetic.outcome === "success" && synthetic.geographyVerification === "match" ? "operational" : "degraded",
        validatedAt: synthetic.checkedAt,
        source: "synthetic",
      });
    }
    return {
      id: `${new Date(now).toISOString()}-${randomBytes(4).toString("hex")}`,
      generatedAt: new Date(now).toISOString(),
      capabilities: [allTrafficCapability, managedCapability, statelessCapability, canaryStatus],
      providers: providerHealth,
      geographies: [...geographies.values()],
    };
  }
}

export interface HealthAggregatorServerOptions {
  host: string;
  port: number;
  token: string;
  refreshIntervalMs: number;
  maximumBodyBytes?: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    "cache-control": "no-store",
  });
  response.end(encoded);
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = expectBufferChunk(chunk, "health-aggregator request chunk");
    size += buffer.length;
    if (size > maximumBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return parseJson(Buffer.concat(chunks).toString("utf8"), "health-aggregator request body");
}

export class HealthAggregatorServer {
  #server: Server | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly aggregator: CapabilityHealthAggregator,
    private readonly store: Pick<CapabilityHealthRepository, "latestCapabilityHealth">,
    private readonly options: HealthAggregatorServerOptions,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<ListenAddress> {
    if (this.#server !== undefined) throw new Error("Health aggregator is already running");
    await this.aggregator.refresh();
    this.#server = createServer((request, response) => void this.#handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.options.port, this.options.host, () => resolve());
    });
    this.#timer = setInterval(() => {
      void this.aggregator.refresh().catch((error: unknown) => {
        this.logger.warn("Capability health refresh failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      });
    }, this.options.refreshIntervalMs);
    this.#timer.unref();
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("Health aggregator did not bind a TCP address");
    return { host: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://aggregator.invalid").pathname;
    if (request.method === "GET" && path === "/health/live") {
      json(response, 200, { status: "live" });
      return;
    }
    if (request.method === "GET" && path === "/health/ready") {
      const snapshot = await this.store.latestCapabilityHealth();
      json(response, snapshot === undefined ? 503 : 200, { status: snapshot === undefined ? "not_ready" : "ready" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.options.token}`) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    try {
      if (request.method === "GET" && path === "/v1/status") {
        json(response, 200, { snapshot: await this.store.latestCapabilityHealth() });
        return;
      }
      if (request.method === "POST" && path === "/v1/passive-signals/otlp") {
        const body = await readJson(request, this.options.maximumBodyBytes ?? 1_048_576);
        const signals = passiveSignalsFromOtlpJson(body);
        for (const signal of signals) this.aggregator.recordPassiveSignal(signal);
        if (signals.length > 0) await this.aggregator.refresh();
        json(response, 200, {});
        return;
      }
      if (request.method === "POST" && path === "/v1/validate") {
        const body = decodeSyntheticValidationScope(await readJson(request, this.options.maximumBodyBytes ?? 16_384));
        json(response, 200, { snapshot: await this.aggregator.refresh({ forceSynthetic: true, scope: body }) });
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      this.logger.warn("Health aggregator request failed", {
        method: request.method,
        path,
        error: error instanceof Error ? error.message : "unknown",
      });
      json(response, 400, { error: "invalid_request" });
    }
  }
}

export function newSyntheticTestId(): string {
  return randomUUID();
}
