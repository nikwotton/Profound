import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "./logger.js";
import type { RouteStore } from "./store.js";
import type { CapabilityHealthSnapshot, ListenAddress } from "./types.js";

export interface StatusApplicationOptions {
  host: string;
  port: number;
  staleAfterMs: number;
  historyLimit: number;
  healthAggregatorUrl?: string;
  healthAggregatorToken?: string;
  now?: () => number;
}

const LABELS = {
  all_traffic: "All Traffic",
  authenticated_traffic: "Authenticated Traffic",
  unauthenticated_traffic: "Unauthenticated Traffic",
  health_verification: "Health Verification",
} as const;

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    "cache-control": "no-store",
  });
  response.end(encoded);
}

function escaped(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function withFreshness(snapshot: CapabilityHealthSnapshot | undefined, now: number, staleAfterMs: number): unknown {
  if (snapshot === undefined) return { snapshot: null, stale: true, ageMs: null };
  const ageMs = Math.max(0, now - Date.parse(snapshot.generatedAt));
  return {
    snapshot,
    stale: ageMs > staleAfterMs,
    ageMs,
    capabilityFreshness: snapshot.capabilities.map((capability) => ({
      capability: capability.capability,
      providerStatusStale: capability.providerStatusAt === undefined ||
        now - Date.parse(capability.providerStatusAt) > staleAfterMs,
      endToEndValidationStale: capability.endToEndValidatedAt === undefined ||
        now - Date.parse(capability.endToEndValidatedAt) > staleAfterMs,
    })),
  };
}

function page(snapshot: CapabilityHealthSnapshot | undefined, now: number, staleAfterMs: number): string {
  const ageMs = snapshot === undefined ? undefined : Math.max(0, now - Date.parse(snapshot.generatedAt));
  const stale = ageMs === undefined || ageMs > staleAfterMs;
  const cards = snapshot?.capabilities.map((capability) => {
    const providerStale = capability.providerStatusAt === undefined || now - Date.parse(capability.providerStatusAt) > staleAfterMs;
    const validationStale = capability.endToEndValidatedAt === undefined || now - Date.parse(capability.endToEndValidatedAt) > staleAfterMs;
    return `
    <article data-status="${escaped(capability.status)}">
      <h2>${escaped(LABELS[capability.capability])}</h2>
      <strong>${escaped(capability.status)}</strong>
      <dl>
        <dt>Provider status</dt><dd>${escaped(capability.providerStatusAt ?? "No provider result")} · ${providerStale ? "stale" : "current"}</dd>
        <dt>End-to-end validation</dt><dd>${escaped(capability.endToEndValidatedAt ?? "No recent validation")} · ${validationStale ? "stale" : "current"}</dd>
      </dl>
      ${capability.message === undefined ? "" : `<p>${escaped(capability.message)}</p>`}
    </article>`;
  }).join("") ?? "<p>No health snapshot is available yet.</p>";
  const geographies = snapshot?.geographies.map((geography) => `
    <tr><td>${escaped(geography.country)}</td><td>${escaped(geography.city ?? "All")}</td>
      <td>${escaped(geography.status)}</td><td>${escaped(geography.validatedAt)}</td><td>${escaped(geography.source)}</td></tr>`)
    .join("") ?? "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy capability status</title><style>
body{font:16px system-ui,sans-serif;margin:0;background:#f6f7f9;color:#18202a}main{max-width:1100px;margin:auto;padding:32px}
.summary{padding:12px 16px;border-radius:8px;background:${stale ? "#fff3cd" : "#e7f6ed"};margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}article{background:white;border:1px solid #d9dee7;border-radius:10px;padding:18px}
article[data-status=operational] strong{color:#147a3d}article[data-status=degraded] strong{color:#936300}article[data-status=unavailable] strong{color:#b42318}
dl{display:grid;grid-template-columns:1fr;gap:4px}dt{font-size:12px;color:#667085;margin-top:8px}dd{margin:0;font-size:13px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;background:white;margin-top:16px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e4e7ec}
</style></head><body><main><h1>Proxy capability status</h1>
<div class="summary">${stale ? "Status data is stale" : "Status data is current"}${ageMs === undefined ? "" : ` · updated ${Math.round(ageMs / 1000)} seconds ago`}</div>
<p>Validation freshness is reported separately from availability. Quiet traffic can leave validation stale without creating an outage.</p>
<section class="grid">${cards}</section><h2>Geography validation</h2>
<table><thead><tr><th>Country</th><th>City</th><th>Status</th><th>Validated</th><th>Source</th></tr></thead><tbody>${geographies}</tbody></table>
</main></body></html>`;
}

export class StatusApplicationServer {
  #server: Server | undefined;

  constructor(
    private readonly store: RouteStore,
    private readonly options: StatusApplicationOptions,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<ListenAddress> {
    if (this.#server !== undefined) throw new Error("Status application is already running");
    this.#server = createServer((request, response) => void this.#handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.options.port, this.options.host, () => resolve());
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("Status application did not bind a TCP address");
    return { host: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const url = new URL(request.url ?? "/", "http://status.invalid");
    try {
      if (url.pathname === "/health/live") {
        json(response, 200, { status: "live" });
        return;
      }
      if (url.pathname === "/api/status") {
        json(response, 200, withFreshness(await this.store.latestCapabilityHealth(), now, this.options.staleAfterMs));
        return;
      }
      if (url.pathname === "/api/status/history") {
        const requested = Number(url.searchParams.get("limit") ?? this.options.historyLimit);
        const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), this.options.historyLimit) : this.options.historyLimit;
        json(response, 200, { data: await this.store.capabilityHealthHistory(limit) });
        return;
      }
      if (url.pathname === "/api/status/geographies") {
        const snapshot = await this.store.latestCapabilityHealth();
        json(response, 200, { data: snapshot?.geographies ?? [], generatedAt: snapshot?.generatedAt });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/status/validate") {
        if (this.options.healthAggregatorUrl === undefined || this.options.healthAggregatorToken === undefined) {
          json(response, 503, { error: "validation_unavailable" });
          return;
        }
        const result = await fetch(new URL("/v1/validate", this.options.healthAggregatorUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.healthAggregatorToken}`,
            "content-type": "application/json",
          },
          body: "{}",
        });
        const body = await result.text();
        response.writeHead(result.status, {
          "content-type": result.headers.get("content-type") ?? "application/json",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/") {
        const html = Buffer.from(page(await this.store.latestCapabilityHealth(), now, this.options.staleAfterMs));
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length, "cache-control": "no-store" });
        response.end(html);
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      this.logger.error("Status application request failed", {
        path: url.pathname,
        error: error instanceof Error ? error.message : "unknown",
      });
      json(response, 500, { error: "internal_error" });
    }
  }
}
