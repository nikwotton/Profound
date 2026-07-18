import { metrics, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";
import * as OtelResource from "@effect/opentelemetry/Resource";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { Layer } from "effect";
import { safeErrorMessage } from "./errors.js";
import { assignmentAttributes } from "./assignment-evidence.js";
import type { AssignmentEvidence, ProviderId, SessionMode } from "./domain/routing.js";
import type { PassiveHealthSignal } from "./domain/health.js";

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion: string;
  environment: NodeJS.ProcessEnv;
}

export interface PassiveAttemptContext {
  sessionMode: SessionMode;
  country?: string;
  city?: string;
}

export function isTelemetryExportConfigured(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment["OTEL_SDK_DISABLED"] !== "true" &&
    (environment["OTEL_EXPORTER_OTLP_ENDPOINT"] !== undefined ||
      environment["OTEL_TRACES_EXPORTER"] !== undefined ||
      environment["OTEL_METRICS_EXPORTER"] !== undefined ||
      environment["OTEL_LOGS_EXPORTER"] !== undefined)
  );
}

/** v0 retains every trace; future outcome-based sampling belongs downstream. */
export const v0TraceSampler = new AlwaysOnSampler();

export class Telemetry {
  readonly effectLayer;
  readonly #sdk: NodeSDK;
  readonly #tracer;
  readonly #operations;
  readonly #duration;
  readonly #rotations;
  readonly #attempts;
  readonly #attemptDuration;
  readonly #candidateChanges;
  readonly #geographicVerification;
  readonly #healthLogger;
  readonly exporting: boolean;

  constructor(options: TelemetryOptions) {
    this.exporting = isTelemetryExportConfigured(options.environment);
    this.#sdk = new NodeSDK(
      this.exporting
        ? { serviceName: options.serviceName, sampler: v0TraceSampler }
        : {
            serviceName: options.serviceName,
            sampler: v0TraceSampler,
            spanProcessors: [],
            metricReaders: [],
            logRecordProcessors: [],
          },
    );
    this.#sdk.start();

    this.#tracer = trace.getTracer(options.serviceName, options.serviceVersion);
    this.#healthLogger = logs.getLogger(options.serviceName, options.serviceVersion);
    const meter = metrics.getMeter(options.serviceName, options.serviceVersion);
    this.#operations = meter.createCounter("profound.proxy.operations", {
      description: "Logical operations handled by the proxy and control planes",
      unit: "{operation}",
    });
    this.#duration = meter.createHistogram("profound.proxy.operation.duration", {
      description: "Proxy and control operation duration",
      unit: "ms",
    });
    this.#rotations = meter.createCounter("profound.proxy.rotations", {
      description: "Route rotation operations",
      unit: "{operation}",
    });
    this.#attempts = meter.createCounter("profound.proxy.upstream_attempts", {
      description: "Upstream provider attempts, including failover",
      unit: "{attempt}",
    });
    this.#attemptDuration = meter.createHistogram("profound.proxy.upstream_attempt.duration", {
      description: "Upstream provider attempt duration",
      unit: "ms",
    });
    this.#candidateChanges = meter.createCounter("profound.proxy.candidate_changes", {
      description: "Candidate identity changes by provider and normalized reason",
      unit: "{change}",
    });
    this.#geographicVerification = meter.createCounter("profound.proxy.geographic_verification", {
      description: "Exact-city verification outcomes",
      unit: "{verification}",
    });
    this.effectLayer = OtelTracer.layerGlobal.pipe(
      Layer.provide(
        OtelResource.layer({
          serviceName: options.serviceName,
          serviceVersion: options.serviceVersion,
        }),
      ),
    );
  }

  startSpan(name: string, attributes: Attributes = {}): Span {
    return this.#tracer.startSpan(name, { attributes });
  }

  finishSpan(span: Span, startedAt: number, attributes: Attributes, error?: unknown): void {
    span.setAttributes(attributes);
    if (error !== undefined) {
      const message = safeErrorMessage(error);
      span.recordException({ name: error instanceof Error ? error.name : "Error", message });
      span.setStatus({ code: SpanStatusCode.ERROR, message });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
    const metricAttributes: Attributes = {
      plane: attributes["plane"] ?? "unknown",
      protocol: attributes["protocol"] ?? "unknown",
      outcome: attributes["outcome"] ?? (error === undefined ? "success" : "failure"),
    };
    this.#operations.add(1, metricAttributes);
    this.#duration.record(Date.now() - startedAt, metricAttributes);
  }

  finishAttempt(span: Span, startedAt: number, attributes: Attributes, error?: unknown, passive?: PassiveAttemptContext): void {
    span.setAttributes(attributes);
    if (error !== undefined) {
      const message = safeErrorMessage(error);
      span.recordException({ name: error instanceof Error ? error.name : "Error", message });
      span.setStatus({ code: SpanStatusCode.ERROR, message });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
    const metricAttributes: Attributes = {
      provider: attributes["provider"] ?? "unknown",
      protocol: attributes["protocol"] ?? "unknown",
      outcome: attributes["outcome"] ?? (error === undefined ? "success" : "failure"),
    };
    this.#attempts.add(1, metricAttributes);
    this.#attemptDuration.record(Date.now() - startedAt, metricAttributes);
    const provider = attributes["provider"];
    if ((provider === "bright_data" || provider === "proxidize") && passive !== undefined) {
      const attemptOutcome = attributes["outcome"];
      this.recordPassiveHealthSignal({
        provider,
        capability: passive.sessionMode === "managed" ? "managed_sessions" : "stateless_traffic",
        outcome: attemptOutcome === "success" || attemptOutcome === "http_error" ? "success" : "failure",
        observedAt: new Date().toISOString(),
        ...(passive.country === undefined ? {} : { country: passive.country }),
        ...(passive.city === undefined ? {} : { city: passive.city }),
      });
    }
  }

  recordPassiveHealthSignal(signal: PassiveHealthSignal): void {
    this.#healthLogger.emit({
      severityText: "INFO",
      severityNumber: SeverityNumber.INFO,
      body: "profound.proxy.passive_health",
      timestamp: new Date(signal.observedAt),
      attributes: {
        "event.name": "profound.proxy.passive_health",
        "proxy.provider": signal.provider satisfies ProviderId,
        "proxy.capability": signal.capability,
        "proxy.outcome": signal.outcome,
        "proxy.observed_at": signal.observedAt,
        ...(signal.country === undefined ? {} : { "proxy.country": signal.country }),
        ...(signal.city === undefined ? {} : { "proxy.city": signal.city }),
      },
    });
  }

  recordRotation(provider: string, outcome: "success" | "failure"): void {
    this.#rotations.add(1, { provider, outcome });
  }

  recordCandidateEvent(
    span: Span,
    provider: string,
    event: "selected" | "identity_observed" | "changed" | "verification",
    evidence: AssignmentEvidence,
  ): void {
    span.addEvent(`proxy.candidate.${event}`, assignmentAttributes(evidence));
    if (event === "changed") {
      this.#candidateChanges.add(1, { provider, reason: evidence.changeReason });
    }
    if (event === "verification") {
      const outcome =
        evidence.assignmentMode === "unverified"
          ? "unverified"
          : evidence.expectedCity === undefined || evidence.observedCity === undefined
            ? "unknown"
            : evidence.expectedCity.toLowerCase() === evidence.observedCity.toLowerCase()
              ? "match"
              : "mismatch";
      this.#geographicVerification.add(1, { provider, outcome });
    }
  }

  async shutdown(): Promise<void> {
    await this.#sdk.shutdown();
  }
}
