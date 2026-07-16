import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { LocalGeoIpResolver } from "./geoip.js";
import { createLogger, type Logger } from "./logger.js";
import { PublicCanary } from "./public-canary.js";

interface ApiGatewayV2Event {
  rawPath?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string; path?: string; sourceIp?: string } };
}

interface ApiGatewayV2Result {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

interface BufferedLog {
  level: string;
  time: string;
  message: string;
  context?: Record<string, unknown>;
}

const bufferedLines: string[] = [];
const securityLogger: Logger = createLogger({
  consoleMode: "all",
  instrumentationScope: "profound-proxy-canary.security",
  defaultAttributes: { "log.category": "security" },
  write: (line) => {
    bufferedLines.push(line);
    console.error(line);
  },
});

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function integer(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const runtime = (async () => {
  const geoIp = new LocalGeoIpResolver({
    databasePath: resolve(process.env.GEOIP_DATABASE_PATH ?? "./data/GeoLite2-City.mmdb"),
    maximumAccuracyRadiusKm: integer(
      process.env.GEOIP_MAX_ACCURACY_RADIUS_KM,
      100,
      "GEOIP_MAX_ACCURACY_RADIUS_KM",
    ),
  }, securityLogger);
  await geoIp.load();
  return new PublicCanary({
    signingSecret: required(process.env.CANARY_SIGNING_SECRET, "CANARY_SIGNING_SECRET"),
    requestsPerMinute: integer(process.env.CANARY_REQUESTS_PER_MINUTE, 60, "CANARY_REQUESTS_PER_MINUTE"),
  }, securityLogger, geoIp);
})();

function otlpValue(value: unknown): { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  return { stringValue: typeof value === "string" ? value : JSON.stringify(value) };
}

function attributes(values: Record<string, unknown>): Array<{ key: string; value: ReturnType<typeof otlpValue> }> {
  return Object.entries(values).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

function unixNano(value: number | string): string {
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  return (BigInt(milliseconds) * 1_000_000n).toString();
}

async function postOtlp(path: "/v1/logs" | "/v1/traces" | "/v1/metrics", payload: unknown): Promise<void> {
  const endpoint = required(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, "OTEL_EXPORTER_OTLP_ENDPOINT");
  const response = await fetch(new URL(path, endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`OTLP collector returned HTTP ${response.status}`);
}

async function exportInvocationTelemetry(
  startedAt: number,
  finishedAt: number,
  statusCode: number,
  lines: readonly string[],
): Promise<void> {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? "profound-proxy-canary";
  const resource = {
    attributes: attributes({
      "service.name": serviceName,
      "service.version": "0.3.0",
      "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "unknown",
      "cloud.provider": "aws",
      "cloud.platform": "aws_lambda",
    }),
  };
  const parsedLogs = lines.flatMap((line): BufferedLog[] => {
    try {
      return [JSON.parse(line) as BufferedLog];
    } catch {
      return [];
    }
  });
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const commonAttributes = {
    "http.response.status_code": statusCode,
    "proxy.outcome": statusCode < 500 ? "success" : "failure",
  };
  const requests = [
    postOtlp("/v1/logs", {
      resourceLogs: [{
        resource,
        scopeLogs: [{
          scope: { name: `${serviceName}.security`, version: "0.3.0" },
          logRecords: parsedLogs.map((entry) => ({
            timeUnixNano: unixNano(entry.time),
            severityText: entry.level.toUpperCase(),
            body: { stringValue: entry.message },
            attributes: attributes({ "log.category": "security", ...(entry.context ?? {}) }),
          })),
        }],
      }],
    }),
    postOtlp("/v1/traces", {
      resourceSpans: [{
        resource,
        scopeSpans: [{
          scope: { name: serviceName, version: "0.3.0" },
          spans: [{
            traceId,
            spanId,
            name: "canary.http",
            kind: 2,
            startTimeUnixNano: unixNano(startedAt),
            endTimeUnixNano: unixNano(finishedAt),
            attributes: attributes(commonAttributes),
            status: { code: statusCode < 500 ? 1 : 2 },
          }],
        }],
      }],
    }),
    postOtlp("/v1/metrics", {
      resourceMetrics: [{
        resource,
        scopeMetrics: [{
          scope: { name: serviceName, version: "0.3.0" },
          metrics: [{
            name: "profound.canary.requests",
            unit: "{request}",
            sum: {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: [{
                startTimeUnixNano: unixNano(startedAt),
                timeUnixNano: unixNano(finishedAt),
                asInt: "1",
                attributes: attributes(commonAttributes),
              }],
            },
          }],
        }],
      }],
    }),
  ];
  const results = await Promise.allSettled(requests);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(JSON.stringify({
        level: "error",
        time: new Date().toISOString(),
        message: "Canary OTLP export failed",
        context: { error: result.reason instanceof Error ? result.reason.message : "unknown" },
      }));
    }
  }
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result> {
  bufferedLines.length = 0;
  const startedAt = Date.now();
  const canary = await runtime;
  const bodyText = event.body ?? "";
  const body = event.isBase64Encoded ? Buffer.from(bodyText, "base64") : Buffer.from(bodyText, "utf8");
  const userAgent = event.headers?.["user-agent"] ?? event.headers?.["User-Agent"];
  const result = await canary.handle({
    method: event.requestContext?.http?.method ?? "UNKNOWN",
    path: event.rawPath ?? event.requestContext?.http?.path ?? "/",
    sourceIp: event.requestContext?.http?.sourceIp ?? "unknown",
    ...(userAgent === undefined ? {} : { userAgent }),
    requestSize: Number(event.headers?.["content-length"] ?? event.headers?.["Content-Length"] ?? body.length),
    body,
  });
  await exportInvocationTelemetry(startedAt, Date.now(), result.statusCode, [...bufferedLines]);
  return { ...result, isBase64Encoded: false };
}
