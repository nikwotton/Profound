import { metrics, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import * as OtelResource from "@effect/opentelemetry/Resource";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { Layer } from "effect";

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion: string;
  environment: NodeJS.ProcessEnv;
}

export class Telemetry {
  readonly effectLayer;
  readonly #sdk: NodeSDK;
  readonly #tracer;
  readonly #requests;
  readonly #duration;
  readonly #rotations;

  constructor(options: TelemetryOptions) {
    const explicitlyConfigured =
      options.environment.OTEL_SDK_DISABLED !== "true" &&
      (
        options.environment.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined ||
        options.environment.OTEL_TRACES_EXPORTER !== undefined ||
        options.environment.OTEL_METRICS_EXPORTER !== undefined
      );
    this.#sdk = new NodeSDK(explicitlyConfigured
      ? { serviceName: options.serviceName }
      : {
          serviceName: options.serviceName,
          spanProcessors: [],
          metricReaders: [],
          logRecordProcessors: [],
        });
    this.#sdk.start();

    this.#tracer = trace.getTracer(options.serviceName, options.serviceVersion);
    const meter = metrics.getMeter(options.serviceName, options.serviceVersion);
    this.#requests = meter.createCounter("profound.proxy.requests", {
      description: "Requests handled by the proxy and control planes",
      unit: "{request}",
    });
    this.#duration = meter.createHistogram("profound.proxy.request.duration", {
      description: "Proxy and control request duration",
      unit: "ms",
    });
    this.#rotations = meter.createCounter("profound.proxy.rotations", {
      description: "Route rotation operations",
      unit: "{operation}",
    });
    this.effectLayer = OtelTracer.layerGlobal.pipe(
      Layer.provide(OtelResource.layer({
        serviceName: options.serviceName,
        serviceVersion: options.serviceVersion,
      })),
    );
  }

  startSpan(name: string, attributes: Attributes = {}): Span {
    return this.#tracer.startSpan(name, { attributes });
  }

  finishSpan(span: Span, startedAt: number, attributes: Attributes, error?: unknown): void {
    span.setAttributes(attributes);
    if (error !== undefined) {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : "Unknown error" });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
    this.#requests.add(1, attributes);
    this.#duration.record(Date.now() - startedAt, attributes);
  }

  recordRotation(provider: string, outcome: "success" | "failure"): void {
    this.#rotations.add(1, { provider, outcome });
  }

  async shutdown(): Promise<void> {
    await this.#sdk.shutdown();
  }
}
