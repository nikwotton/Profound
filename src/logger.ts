import { logs, SeverityNumber } from "@opentelemetry/api-logs";

const REDACTED_KEYS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "password", "token", "proxyurl"]);

function sanitize(value: unknown, key?: string): unknown {
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
  if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, sanitize(child, childKey)]),
    );
  }
  return value;
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
    const safeContext = context === undefined ? undefined : (sanitize(context) as Record<string, unknown>);
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
