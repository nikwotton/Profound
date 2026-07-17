import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "./logger.js";
import type { RouteStore } from "./store.js";
import type { CapabilityHealthSnapshot, ListenAddress, UsageGroupBy, UsageInterval, UsageProvider, UsageRollup } from "./types.js";
import { summarizeUsage, type UsageQuery } from "./usage-accounting.js";

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
      providerStatusStale: capability.providerStatusAt === undefined || now - Date.parse(capability.providerStatusAt) > staleAfterMs,
      endToEndValidationStale:
        capability.endToEndValidatedAt === undefined || now - Date.parse(capability.endToEndValidatedAt) > staleAfterMs,
    })),
  };
}

function page(snapshot: CapabilityHealthSnapshot | undefined, usage: readonly UsageRollup[], now: number, staleAfterMs: number): string {
  const ageMs = snapshot === undefined ? undefined : Math.max(0, now - Date.parse(snapshot.generatedAt));
  const stale = ageMs === undefined || ageMs > staleAfterMs;
  const cards =
    snapshot?.capabilities
      .map((capability) => {
        const providerStale = capability.providerStatusAt === undefined || now - Date.parse(capability.providerStatusAt) > staleAfterMs;
        const validationStale =
          capability.endToEndValidatedAt === undefined || now - Date.parse(capability.endToEndValidatedAt) > staleAfterMs;
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
      })
      .join("") ?? "<p>No health snapshot is available yet.</p>";
  const geographies =
    snapshot?.geographies
      .map(
        (geography) => `
    <tr><td>${escaped(geography.country)}</td><td>${escaped(geography.city ?? "All")}</td>
      <td>${escaped(geography.status)}</td><td>${escaped(geography.validatedAt)}</td><td>${escaped(geography.source)}</td></tr>`,
      )
      .join("") ?? "";
  const usageTotal = usage.reduce(
    (total, rollup) => ({
      requests: total.requests + rollup.requestCount,
      bytes: total.bytes + rollup.bytesSent + rollup.bytesReceived,
      leaseMs: total.leaseMs + rollup.deviceLeaseMs,
      provisionedMs: total.provisionedMs + (rollup.provisionedDeviceMs ?? rollup.deviceLeaseMs),
      unhealthyMs: total.unhealthyMs + (rollup.unhealthyDeviceMs ?? 0),
      cost: total.cost + rollup.attributedCostUsd,
    }),
    { requests: 0, bytes: 0, leaseMs: 0, provisionedMs: 0, unhealthyMs: 0, cost: 0 },
  );
  const latestUsage = usage.at(-1);
  const usageStatus = usage.length > 0 && usage.every((rollup) => rollup.costStatus === "reconciled") ? "Reconciled" : "Estimated";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy routing dashboard</title><style>
body{font:16px system-ui,sans-serif;margin:0;background:#f6f7f9;color:#18202a}main{max-width:1100px;margin:auto;padding:32px}
.summary{padding:12px 16px;border-radius:8px;background:${stale ? "#fff3cd" : "#e7f6ed"};margin-bottom:24px}
.grid,.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.metric,article{background:white;border:1px solid #d9dee7;border-radius:10px;padding:18px}.metric strong{display:block;font-size:24px}
article[data-status=operational] strong{color:#147a3d}article[data-status=degraded] strong{color:#936300}article[data-status=unavailable] strong{color:#b42318}
dl{display:grid;grid-template-columns:1fr;gap:4px}dt{font-size:12px;color:#667085;margin-top:8px}dd{margin:0;font-size:13px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;background:white;margin-top:16px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e4e7ec}
</style></head><body><main><h1>Proxy routing dashboard</h1>
<div class="summary">${stale ? "Status data is stale" : "Status data is current"}${ageMs === undefined ? "" : ` · updated ${Math.round(ageMs / 1000)} seconds ago`}</div>
<h2>Usage and cost · last 30 days</h2><section class="metrics">
<div class="metric"><span>Requests</span><strong>${usageTotal.requests.toLocaleString("en-US")}</strong></div>
<div class="metric"><span>Transfer</span><strong>${(usageTotal.bytes / 1024 ** 3).toFixed(3)} GiB</strong></div>
<div class="metric"><span>Device lease time</span><strong>${(usageTotal.leaseMs / 3_600_000).toFixed(1)} h</strong></div>
<div class="metric"><span>Allocation utilization</span><strong>${(usageTotal.provisionedMs === 0 ? 0 : (usageTotal.leaseMs / usageTotal.provisionedMs) * 100).toFixed(1)}%</strong><small>current ${((latestUsage?.currentAllocationUtilization ?? 0) * 100).toFixed(1)}%</small></div>
<div class="metric"><span>Unhealthy paid capacity</span><strong>${(usageTotal.unhealthyMs / 3_600_000).toFixed(1)} h</strong></div>
<div class="metric"><span>Attributed cost</span><strong>$${usageTotal.cost.toFixed(2)}</strong><small>${usageStatus}</small></div>
</section><p>Use <code>/api/usage</code> to change the interval, time range, grouping, or filters.</p>
<h2>Capability health</h2>
<p>Validation freshness is reported separately from availability. Quiet traffic can leave validation stale without creating an outage.</p>
<section class="grid">${cards}</section><h2>Geography validation</h2>
<table><thead><tr><th>Country</th><th>City</th><th>Status</th><th>Validated</th><th>Source</th></tr></thead><tbody>${geographies}</tbody></table>
</main></body></html>`;
}

const USAGE_INTERVALS = new Set<UsageInterval>(["hour", "day", "week", "month"]);
const USAGE_GROUPS = new Set<UsageGroupBy>(["provider", "customer", "user", "route", "country", "city", "outcome"]);
const USAGE_PROVIDERS = new Set<UsageProvider>(["bright_data", "proxidize", "unresolved"]);

function usageQuery(url: URL, now: number): UsageQuery {
  const preset = url.searchParams.get("preset");
  const presetMs = preset === "day" ? 86_400_000 : preset === "week" ? 7 * 86_400_000 : preset === "month" ? 30 * 86_400_000 : undefined;
  if (preset !== null && presetMs === undefined) throw new Error("invalid_usage_preset");
  const from = url.searchParams.get("from") ?? new Date(now - (presetMs ?? 30 * 86_400_000)).toISOString();
  const to = url.searchParams.get("to") ?? new Date(now).toISOString();
  const intervalValue = url.searchParams.get("interval") ?? "day";
  if (!USAGE_INTERVALS.has(intervalValue as UsageInterval)) throw new Error("invalid_usage_interval");
  const groupValue = url.searchParams.get("groupBy") ?? undefined;
  if (groupValue !== undefined && !USAGE_GROUPS.has(groupValue as UsageGroupBy)) throw new Error("invalid_usage_group");
  const providerValue = url.searchParams.get("provider") ?? undefined;
  if (providerValue !== undefined && !USAGE_PROVIDERS.has(providerValue as UsageProvider)) throw new Error("invalid_usage_provider");
  return {
    from,
    to,
    interval: intervalValue as UsageInterval,
    ...(groupValue === undefined ? {} : { groupBy: groupValue as UsageGroupBy }),
    ...(providerValue === undefined ? {} : { provider: providerValue as UsageProvider }),
    ...Object.fromEntries(
      (["customerId", "userId", "routeId", "country", "city", "outcome"] as const).flatMap((name) => {
        const value = url.searchParams.get(name);
        return value === null ? [] : [[name, value]];
      }),
    ),
  };
}

function canUsePersistedRollups(query: UsageQuery): boolean {
  return (
    (query.groupBy === undefined || query.groupBy === "customer") &&
    query.provider === undefined &&
    query.userId === undefined &&
    query.routeId === undefined &&
    query.country === undefined &&
    query.city === undefined &&
    query.outcome === undefined
  );
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
    await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
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
      if (request.method === "GET" && url.pathname === "/api/usage") {
        const query = usageQuery(url, now);
        const persisted = canUsePersistedRollups(query) ? await this.store.listUsageRollups(query.from, query.to, query.interval) : [];
        const data = persisted.filter((rollup) =>
          query.groupBy === "customer" || query.customerId !== undefined
            ? rollup.group.customer !== undefined && (query.customerId === undefined || rollup.group.customer === query.customerId)
            : Object.keys(rollup.group).length === 0,
        );
        const recordFrom = new Date(Date.parse(query.from) - 15 * 60_000).toISOString();
        const rollups = data.length > 0 ? data : summarizeUsage(await this.store.listUsageRecords(recordFrom, query.to), query);
        json(response, 200, { from: query.from, to: query.to, interval: query.interval, groupBy: query.groupBy ?? null, data: rollups });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/usage/reconciliations") {
        const query = usageQuery(url, now);
        json(response, 200, { from: query.from, to: query.to, data: await this.store.listUsageReconciliations(query.from, query.to) });
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
        const to = new Date(now).toISOString();
        const from = new Date(now - 30 * 86_400_000).toISOString();
        const storedUsage = (await this.store.listUsageRollups(from, to, "day")).filter((rollup) => Object.keys(rollup.group).length === 0);
        const usage =
          storedUsage.length > 0
            ? storedUsage
            : summarizeUsage(await this.store.listUsageRecords(new Date(Date.parse(from) - 15 * 60_000).toISOString(), to), {
                from,
                to,
                interval: "day",
              });
        const html = Buffer.from(page(await this.store.latestCapabilityHealth(), usage, now, this.options.staleAfterMs));
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length, "cache-control": "no-store" });
        response.end(html);
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid_usage_")) {
        json(response, 400, { error: error.message });
        return;
      }
      this.logger.error("Status application request failed", {
        path: url.pathname,
        error: error instanceof Error ? error.message : "unknown",
      });
      json(response, 500, { error: "internal_error" });
    }
  }
}
