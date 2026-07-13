const REDACTED_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "proxyurl",
]);

function sanitize(value: unknown, key?: string): unknown {
  if (key !== undefined && REDACTED_KEYS.has(key.toLowerCase())) {
    return "[REDACTED]";
  }
  if (value instanceof URL) {
    return `${value.origin}${value.pathname}`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        sanitize(child, childKey),
      ]),
    );
  }
  return value;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createLogger(write: (line: string) => void = console.log): Logger {
  const log = (level: string, message: string, context?: Record<string, unknown>): void => {
    write(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        message,
        ...(context === undefined ? {} : { context: sanitize(context) }),
      }),
    );
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
