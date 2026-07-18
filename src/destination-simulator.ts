export type DestinationConnectionBehavior = "respond" | "close" | "reset" | "timeout";

export interface DestinationResponsePlan {
  status: number;
  headers: Record<string, string>;
  body?: string;
  delayMs: number;
  connection: DestinationConnectionBehavior;
}

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function destinationResponsePlan(url: URL): DestinationResponsePlan {
  const statusText = url.searchParams.get("responseStatus") ?? url.pathname.match(/^\/status\/(\d{3})$/)?.[1];
  const status = statusText === undefined ? 200 : Number(statusText);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("invalid_response_status");
  const delayMs = Number(url.searchParams.get("delayMs") ?? "0");
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5_000) throw new Error("invalid_delay");
  const connection = url.searchParams.get("connection") ?? "respond";
  if (!(["respond", "close", "reset", "timeout"] as const).includes(connection as DestinationConnectionBehavior)) {
    throw new Error("invalid_connection_behavior");
  }
  const headers: Record<string, string> = {};
  for (const value of url.searchParams.getAll("responseHeader")) {
    const separator = value.indexOf(":");
    if (separator <= 0) throw new Error("invalid_response_header");
    const name = value.slice(0, separator).trim().toLowerCase();
    const headerValue = value.slice(separator + 1).trim();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || FORBIDDEN_RESPONSE_HEADERS.has(name) || /[\r\n]/.test(headerValue)) {
      throw new Error("invalid_response_header");
    }
    headers[name] = headerValue;
  }
  const body = url.searchParams.get("responseBody");
  return {
    status,
    headers,
    ...(body === null ? {} : { body }),
    delayMs,
    connection: connection as DestinationConnectionBehavior,
  };
}

export async function waitForDestinationDelay(delayMs: number): Promise<void> {
  if (delayMs === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
