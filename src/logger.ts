import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { isUnknownRecord } from "./decoding.js";

const REDACTED_KEYS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "password", "token", "proxyurl"]);
const EMBEDDED_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const LABELED_SECRET = /\b(authorization|proxy-authorization|cookie|set-cookie|password|token)\s*[:=]\s*([^\s,;]+)/gi;

function sanitizeString(value: string): string {
  return value
    .replace(EMBEDDED_URL, (candidate) => {
      try {
        const url = new URL(candidate);
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        return candidate;
      }
    })
    .replace(LABELED_SECRET, "$1=[REDACTED]");
}

function sanitizeError(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  if (seen.has(error)) return { name: error.name, cause: "[Circular]" };
  seen.add(error);
  const code = "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? error.code : undefined;
  const retryable = "retryable" in error && typeof error.retryable === "boolean" ? error.retryable : undefined;
  const retryAfterMs = "retryAfterMs" in error && typeof error.retryAfterMs === "number" ? error.retryAfterMs : undefined;
  return {
    name: error.name,
    message: sanitizeString(error.message),
    ...(code === undefined ? {} : { code }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(error.cause === undefined ? {} : { cause: sanitize(error.cause, "cause", seen) }),
  };
}

function sanitize(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key !== undefined) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      REDACTED_KEYS.has(key.toLowerCase()) ||
      normalized.endsWith("authorization") ||
      normalized.endsWith("cookie") ||
      normalized.endsWith("password") ||
      normalized.endsWith("token") ||
      normalized.endsWith("proxyurl")
    ) {
      return "[REDACTED]";
    }
  }
  if (value instanceof URL) {
    return `${value.origin}${value.pathname}`;
  }
  if (value instanceof Error) return sanitizeError(value, seen);
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => sanitize(item, undefined, seen));
  }
  if (isUnknownRecord(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return sanitizeRecord(value, seen);
  }
  return value;
}

function sanitizeRecord(value: Readonly<Record<string, unknown>>, seen = new WeakSet<object>()): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey, seen)]));
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type ConsoleLogMode = "all" | "errors" | "none";

export interface LoggerOptions {
  write?: (line: string) => void;
  consoleMode?: ConsoleLogMode;
  instrumentationScope?: string;
  defaultAttributes?: Record<string, string | number | boolean>;
}

export function createLogger(options?: LoggerOptions | ((line: string) => void)): Logger {
  const write = typeof options === "function" ? options : (options?.write ?? console.error);
  const consoleMode = typeof options === "function" ? "all" : (options?.consoleMode ?? "all");
  const defaultAttributes = typeof options === "function" ? undefined : options?.defaultAttributes;
  const otelLogger = logs.getLogger(
    typeof options === "function" ? "profound-proxy-router" : (options?.instrumentationScope ?? "profound-proxy-router"),
  );
  const log = (level: string, message: string, context?: Record<string, unknown>): void => {
    const safeContext = context === undefined ? undefined : sanitizeRecord(context, new WeakSet<object>([context]));
    const time = new Date().toISOString();
    if (consoleMode === "all" || (consoleMode === "errors" && level === "error")) {
      write(
        JSON.stringify({
          level,
          time,
          message,
          ...(safeContext === undefined ? {} : { context: safeContext }),
        }),
      );
    }
    const contextAttributes =
      safeContext === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(safeContext).map(([key, value]) => [
              key,
              typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value),
            ]),
          );
    const attributes =
      defaultAttributes === undefined && contextAttributes === undefined ? undefined : { ...defaultAttributes, ...contextAttributes };
    otelLogger.emit({
      severityText: level.toUpperCase(),
      severityNumber: level === "error" ? SeverityNumber.ERROR : level === "warn" ? SeverityNumber.WARN : SeverityNumber.INFO,
      body: message,
      timestamp: new Date(time),
      ...(attributes === undefined ? {} : { attributes }),
    });
  };
  return {
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context),
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
