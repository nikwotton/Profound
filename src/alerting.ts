import { createHash, createHmac } from "node:crypto";
import { isUnknownRecord } from "./decoding.js";
import type { Logger } from "./logger.js";
import type { HealthAlertRepository } from "./store.js";
import type {
  CapabilityHealthSnapshot,
  CapabilityName,
  CapabilityStatus,
  HealthAlertDelivery,
  HealthAlertEvent,
  HealthAlertState,
} from "./types.js";

export interface HealthAlertDestination {
  id: string;
  url: string;
  secret: string;
}

export interface HealthAlertDestinationConfig {
  version: string;
  destinations: HealthAlertDestination[];
}

export interface HealthAlertEvidence {
  conflicting: boolean;
  staleCapabilities: CapabilityName[];
}

export interface HealthAlertEvaluator {
  evaluate(snapshot: CapabilityHealthSnapshot, evidence: HealthAlertEvidence): Promise<void>;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function parseHealthAlertDestinationConfig(raw: string | undefined): HealthAlertDestinationConfig {
  if (raw === undefined || raw.trim() === "") return { version: "unconfigured", destinations: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("HEALTH_ALERT_DESTINATIONS_JSON must be valid JSON");
  }
  if (!isUnknownRecord(value)) {
    throw new Error("HEALTH_ALERT_DESTINATIONS_JSON must be an object");
  }
  if (typeof value["version"] !== "string" || value["version"].trim() === "") {
    throw new Error("Health alert destination configuration requires a non-empty version");
  }
  if (!Array.isArray(value["destinations"]) || value["destinations"].length > 20) {
    throw new Error("Health alert destination configuration requires at most 20 destinations");
  }
  const ids = new Set<string>();
  const destinations = value["destinations"].map((entry): HealthAlertDestination => {
    if (!isUnknownRecord(entry)) {
      throw new Error("Each health alert destination must be an object");
    }
    if (typeof entry["id"] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(entry["id"])) {
      throw new Error("Each health alert destination requires a valid id");
    }
    if (ids.has(entry["id"])) throw new Error(`Duplicate health alert destination id: ${entry["id"]}`);
    ids.add(entry["id"]);
    if (typeof entry["url"] !== "string" || typeof entry["secret"] !== "string" || entry["secret"].length < 16) {
      throw new Error(`Health alert destination ${entry["id"]} requires a URL and a secret of at least 16 characters`);
    }
    const url = new URL(entry["url"]);
    if (url.username !== "" || url.password !== "" || (url.protocol !== "https:" && !isLocalHost(url.hostname))) {
      throw new Error(`Health alert destination ${entry["id"]} must use HTTPS without URL credentials`);
    }
    return { id: entry["id"], url: url.toString(), secret: entry["secret"] };
  });
  return { version: value["version"], destinations };
}

export interface WebhookNotificationAdapterOptions {
  timeoutMs: number;
  maxAttempts: number;
  initialBackoffMs: number;
  batchSize?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

export class WebhookNotificationAdapter {
  readonly #destinations: Map<string, HealthAlertDestination>;

  constructor(
    private readonly store: HealthAlertRepository,
    destinations: readonly HealthAlertDestination[],
    private readonly options: WebhookNotificationAdapterOptions,
    private readonly logger: Logger,
  ) {
    this.#destinations = new Map(destinations.map((destination) => [destination.id, destination]));
  }

  async flush(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const deliveries = await this.store.pendingHealthAlertDeliveries(new Date(now).toISOString(), this.options.batchSize ?? 100);
    for (const delivery of deliveries) await this.#deliver(delivery, now);
  }

  async #deliver(delivery: HealthAlertDelivery, now: number): Promise<void> {
    const destination = this.#destinations.get(delivery.destinationId);
    if (destination === undefined) {
      await this.store.saveHealthAlertDelivery({
        ...delivery,
        status: "failed",
        attemptCount: delivery.attemptCount + 1,
        lastAttemptAt: new Date(now).toISOString(),
        error: "destination_not_configured",
      });
      return;
    }
    const body = JSON.stringify(delivery.event);
    const timestamp = new Date(now).toISOString();
    const signature = createHmac("sha256", destination.secret).update(`${timestamp}.${body}`).digest("hex");
    let responseStatus: number | undefined;
    let error: string | undefined;
    try {
      const request = this.options.fetch ?? fetch;
      const response = await request(destination.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-profound-event-id": delivery.event.id,
          "x-profound-timestamp": timestamp,
          "x-profound-signature": `sha256=${signature}`,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      responseStatus = response.status;
      if (!response.ok) error = `http_${response.status}`;
    } catch (cause) {
      error = cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "request_failed";
    }
    const attemptCount = delivery.attemptCount + 1;
    if (error === undefined) {
      await this.store.saveHealthAlertDelivery({
        ...delivery,
        status: "delivered",
        attemptCount,
        lastAttemptAt: timestamp,
        deliveredAt: timestamp,
        ...(responseStatus === undefined ? {} : { responseStatus }),
      });
      this.logger.info("Health alert webhook delivered", {
        "event.name": "profound.health.alert_delivery",
        alertId: delivery.alertId,
        destinationId: delivery.destinationId,
        attemptCount,
      });
      return;
    }
    const exhausted = attemptCount >= this.options.maxAttempts;
    const backoffMs = this.options.initialBackoffMs * 2 ** Math.max(0, attemptCount - 1);
    await this.store.saveHealthAlertDelivery({
      ...delivery,
      status: exhausted ? "failed" : "pending",
      attemptCount,
      lastAttemptAt: timestamp,
      nextAttemptAt: new Date(now + backoffMs).toISOString(),
      ...(responseStatus === undefined ? {} : { responseStatus }),
      error,
    });
    this.logger.warn("Health alert webhook delivery failed", {
      "event.name": "profound.health.alert_delivery",
      alertId: delivery.alertId,
      destinationId: delivery.destinationId,
      attemptCount,
      exhausted,
      error,
    });
  }
}

export interface HealthAlertCoordinatorOptions {
  configurationVersion: string;
  destinationIds: readonly string[];
  degradedDelayMs: number;
  notifier?: Pick<WebhookNotificationAdapter, "flush">;
}

function eventSeverity(status: CapabilityStatus): HealthAlertEvent["severity"] {
  return status === "unavailable" ? "critical" : status === "degraded" ? "warning" : "info";
}

export class HealthAlertCoordinator implements HealthAlertEvaluator {
  constructor(
    private readonly store: HealthAlertRepository,
    private readonly options: HealthAlertCoordinatorOptions,
    private readonly logger: Logger,
  ) {}

  async evaluate(snapshot: CapabilityHealthSnapshot, evidence: HealthAlertEvidence): Promise<void> {
    for (const capability of snapshot.capabilities) await this.#evaluateCapability(snapshot, capability.capability, capability.status);
    if (evidence.conflicting || evidence.staleCapabilities.length > 0) {
      this.logger.info("Health evidence needs attention", {
        "event.name": "profound.health.evidence",
        severity: "low",
        conflicting: evidence.conflicting,
        staleCapabilities: evidence.staleCapabilities,
        snapshotId: snapshot.id,
      });
    }
    await this.options.notifier?.flush();
  }

  async #evaluateCapability(snapshot: CapabilityHealthSnapshot, capability: CapabilityName, status: CapabilityStatus): Promise<void> {
    const prior = await this.store.getHealthAlertState(capability);
    const observedSince = prior === undefined || prior.observedStatus !== status ? snapshot.generatedAt : prior.observedSince;
    let state: HealthAlertState = {
      capability,
      observedStatus: status,
      observedSince,
      ...(prior?.alertedStatus === undefined ? {} : { alertedStatus: prior.alertedStatus }),
      ...(prior?.alertedAt === undefined ? {} : { alertedAt: prior.alertedAt }),
      updatedAt: snapshot.generatedAt,
    };
    // Persist the episode boundary before emitting. If the process stops between
    // event creation and the final state write, the same dedupe key is retried.
    await this.store.saveHealthAlertState(state);
    if (status === "operational" && state.alertedStatus !== undefined) {
      const previousStatus = state.alertedStatus;
      await this.#emit(snapshot, capability, status, "recovery", observedSince, previousStatus);
      state = { capability, observedStatus: status, observedSince, updatedAt: snapshot.generatedAt };
    } else if (status !== "operational") {
      const delaySatisfied =
        status === "unavailable" || Date.parse(snapshot.generatedAt) - Date.parse(observedSince) >= this.options.degradedDelayMs;
      if (delaySatisfied && state.alertedStatus !== status) {
        await this.#emit(snapshot, capability, status, "alert", observedSince);
        state = { ...state, alertedStatus: status, alertedAt: snapshot.generatedAt };
      }
    }
    await this.store.saveHealthAlertState(state);
  }

  async #emit(
    snapshot: CapabilityHealthSnapshot,
    capability: CapabilityName,
    status: CapabilityStatus,
    kind: HealthAlertEvent["kind"],
    episodeStartedAt: string,
    previousStatus?: Exclude<CapabilityStatus, "operational">,
  ): Promise<void> {
    const dedupeKey = `${capability}:${kind}:${status}:${episodeStartedAt}`;
    const event: HealthAlertEvent = {
      id: createHash("sha256").update(dedupeKey).digest("hex"),
      dedupeKey,
      kind,
      capability,
      status,
      ...(previousStatus === undefined ? {} : { previousStatus }),
      severity: eventSeverity(status),
      createdAt: snapshot.generatedAt,
      snapshotId: snapshot.id,
      configurationVersion: this.options.configurationVersion,
      geographies: snapshot.geographies.filter((geography) => geography.status !== "operational"),
    };
    const created = await this.store.createHealthAlertEvent(event, this.options.destinationIds);
    if (!created) return;
    const log =
      event.severity === "critical"
        ? this.logger.error.bind(this.logger)
        : event.severity === "warning"
          ? this.logger.warn.bind(this.logger)
          : this.logger.info.bind(this.logger);
    log("Health alert finalized", {
      "event.name": "profound.health.alert",
      alertId: event.id,
      kind: event.kind,
      capability: event.capability,
      status: event.status,
      previousStatus: event.previousStatus ?? "none",
      severity: event.severity,
      snapshotId: event.snapshotId,
      configurationVersion: event.configurationVersion,
      affectedGeographies: event.geographies,
    });
  }
}
