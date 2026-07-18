import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CAPACITY_POLICY, recommendCapacity, type CapacityRecommendation } from "./capacity-policy.js";
import { expectIsoTimestamp } from "./decoding.js";
import type { Logger } from "./logger.js";
import { ROUTING_POLICY } from "./routing-policy.js";
import { toPublicAccessGrant, toPublicLogicalSession, type RouteStore } from "./store.js";
import type { CapabilityHealthSnapshot } from "./domain/health.js";
import type {
  CapacityCircuitState,
  ProviderInventorySnapshot,
  PublicAccessGrant,
  PublicLogicalSession,
  StoredRoute,
} from "./domain/routing.js";
import type { ListenAddress } from "./domain/network.js";
import type { UsageGroupBy, UsageInterval, UsageRollup } from "./domain/usage.js";
import { summarizeUsage, type UsageQuery } from "./usage-accounting.js";

export interface StatusApplicationOptions {
  host: string;
  port: number;
  staleAfterMs: number;
  historyLimit: number;
  healthAggregatorUrl?: string;
  healthAggregatorToken?: string;
  now?: () => number;
  fetchImplementation?: typeof fetch;
}

const LABELS = {
  all_traffic: "All Traffic",
  managed_sessions: "Managed Sessions",
  stateless_traffic: "Stateless Traffic",
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

function capacityRecommendation(
  usage: readonly UsageRollup[],
  now: number,
  provisionedSlots?: number,
  monthlyPricePerSlotUsd = 0,
): { latest?: UsageRollup; recommendation?: CapacityRecommendation } {
  const latest = usage.filter((rollup) => rollup.provisionedSlots > 0).at(-1);
  if (latest === undefined) return {};
  return {
    latest,
    recommendation: recommendCapacity(
      {
        provisionedSlots: provisionedSlots ?? latest.provisionedSlots,
        peakConcurrentConnections: latest.peakConcurrentConnections,
        observedMbps: latest.throughputUtilization * latest.provisionedSlots * CAPACITY_POLICY.plannedMbpsPerSlot,
        prioritizedGbForecast: latest.prioritizedGbForecast,
        ...(latest.capacityConstraint === undefined ? {} : { limitingConstraint: latest.capacityConstraint }),
        monthlyPricePerSlotUsd,
      },
      CAPACITY_POLICY,
      () => now,
    ),
  };
}

function mostRecentInventory(inventories: readonly ProviderInventorySnapshot[]): ProviderInventorySnapshot | undefined {
  return [...inventories].sort(
    (left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt) || left.provider.localeCompare(right.provider),
  )[0];
}

function page(
  snapshot: CapabilityHealthSnapshot | undefined,
  usage: readonly UsageRollup[],
  capacityUsage: readonly UsageRollup[],
  inventory: ProviderInventorySnapshot | undefined,
  profiles: readonly StoredRoute[],
  accessGrants: readonly PublicAccessGrant[],
  logicalSessions: readonly PublicLogicalSession[],
  capacityCircuits: readonly CapacityCircuitState[],
  now: number,
  staleAfterMs: number,
): string {
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
      operations: total.operations + rollup.operationCount,
      bytes: total.bytes + rollup.bytesSent + rollup.bytesReceived,
      connectionMs: total.connectionMs + rollup.activeConnectionMs,
      provisionedMs: total.provisionedMs + rollup.provisionedSlotMs,
      unhealthyMs: total.unhealthyMs + rollup.unhealthySlotMs,
      cost: total.cost + rollup.attributedCostUsd,
    }),
    { operations: 0, bytes: 0, connectionMs: 0, provisionedMs: 0, unhealthyMs: 0, cost: 0 },
  );
  const capacity = capacityRecommendation(capacityUsage, now, inventory?.slots.length, inventory?.monthlyPricePerSlotUsd);
  const latestCapacity = capacity.latest;
  const recommendation = capacity.recommendation;
  const usageStatus = usage.length > 0 && usage.every((rollup) => rollup.costStatus === "reconciled") ? "Reconciled" : "Estimated";
  const overrides = profiles
    .filter((profile) => profile.providerOverride !== undefined)
    .map(
      (profile) =>
        `<tr><td>${escaped(profile.id)}</td><td>${escaped(profile.customerId)}</td><td>${escaped(profile.providerOverride)}</td><td>${escaped(profile.status)}</td></tr>`,
    )
    .join("");
  const circuits = capacityCircuits
    .map(
      (circuit) =>
        `<tr><td>${escaped(circuit.provider)}</td><td>${escaped(circuit.candidateKey)}</td><td>${escaped(circuit.status)}</td><td>${escaped(circuit.reason ?? "None")}</td><td>${escaped(circuit.cooldownUntil ?? "Ready")}</td></tr>`,
    )
    .join("");
  const credentials = accessGrants
    .flatMap((grant) =>
      grant.credentials.map(
        (credential) =>
          `<tr><td>${escaped(credential.credentialId)}</td><td>${escaped(grant.profileId)}</td><td>${escaped(credential.sessionMode)}</td><td>${escaped(credential.sessionId ?? "Stateless")}</td><td>${escaped(credential.status)}</td><td>${escaped(credential.lastUsedAt ?? "Never")}</td><td>${escaped(credential.expiresAt)}</td></tr>`,
      ),
    )
    .join("");
  const sessions = logicalSessions
    .map(
      (session) =>
        `<tr><td>${escaped(session.sessionId)}</td><td>${escaped(session.profileId)}</td><td>${escaped(session.grantId)}</td><td>${escaped(session.status)}</td><td>${escaped(session.lastUsedAt ?? "Never")}</td><td>${escaped(session.closedAt ?? "Open")}</td></tr>`,
    )
    .join("");
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
<div class="metric"><span>Operations</span><strong>${usageTotal.operations.toLocaleString("en-US")}</strong></div>
<div class="metric"><span>Transfer</span><strong>${(usageTotal.bytes / 1024 ** 3).toFixed(3)} GiB</strong></div>
<div class="metric"><span>Upstream connection time</span><strong>${(usageTotal.connectionMs / 3_600_000).toFixed(1)} h</strong></div>
<div class="metric"><span>Proxy-slot occupancy</span><strong>${((latestCapacity?.slotOccupancy ?? 0) * 100).toFixed(1)}%</strong><small>current ${((latestCapacity?.currentSlotOccupancy ?? 0) * 100).toFixed(1)}%</small></div>
<div class="metric"><span>Provisioned slots</span><strong>${inventory?.slots.length ?? latestCapacity?.provisionedSlots ?? 0}</strong><small>${inventory?.slots.filter((slot) => !slot.healthy).length ?? 0} unhealthy</small></div>
<div class="metric"><span>Active connections</span><strong>${latestCapacity?.activeConnections ?? 0}</strong><small>peak ${latestCapacity?.peakConcurrentConnections ?? 0} · p95 ${latestCapacity?.p95ConcurrentConnections ?? 0}</small></div>
<div class="metric"><span>Unhealthy paid slot capacity</span><strong>${(usageTotal.unhealthyMs / 3_600_000).toFixed(1)} h</strong></div>
<div class="metric"><span>Attributed cost</span><strong>$${usageTotal.cost.toFixed(2)}</strong><small>${usageStatus}</small></div>
<div class="metric"><span>Capacity recommendation</span><strong>${recommendation === undefined ? "No data" : `${recommendation.slotDelta >= 0 ? "+" : ""}${recommendation.slotDelta} slots`}</strong><small>${recommendation?.suppressed === true ? "suppressed by location constraint" : `operator action · ${CAPACITY_POLICY.version}`}</small></div>
</section><p>Use <code>/v1/usage</code> to change the interval, time range, grouping, or filters.</p>
<h2>Credential and session lifecycle</h2>
<p>Credentials and logical sessions remain provider-neutral. No provider assignment or provider affinity is exposed here.</p>
<h3>Credentials</h3>
<table><thead><tr><th>Credential</th><th>Profile</th><th>Session mode</th><th>Logical session</th><th>Status</th><th>Last used</th><th>Expires</th></tr></thead><tbody>${credentials || '<tr><td colspan="7">No credentials</td></tr>'}</tbody></table>
<h3>Managed sessions</h3>
<table><thead><tr><th>Session</th><th>Profile</th><th>Grant</th><th>Status</th><th>Last used</th><th>Closed</th></tr></thead><tbody>${sessions || '<tr><td colspan="6">No managed sessions</td></tr>'}</tbody></table>
<h2>Capability health</h2>
<p>Validation freshness is reported separately from availability. Quiet traffic can leave validation stale without creating an outage.</p>
<section class="grid">${cards}</section><h2>Geography validation</h2>
<table><thead><tr><th>Country</th><th>City</th><th>Status</th><th>Validated</th><th>Source</th></tr></thead><tbody>${geographies}</tbody></table>
<h2>Explicit provider overrides</h2>
<p>Only profiles with an explicit override are listed; ordinary profiles remain provider-neutral.</p>
<table><thead><tr><th>Profile</th><th>Customer</th><th>Override</th><th>Status</th></tr></thead><tbody>${overrides || '<tr><td colspan="4">No provider overrides</td></tr>'}</tbody></table>
<h2>Hard-capacity circuits</h2>
<p>Open circuits are excluded from routing until their cooldown permits one half-open probe.</p>
<table><thead><tr><th>Provider</th><th>Candidate</th><th>State</th><th>Failure class</th><th>Cooldown</th></tr></thead><tbody>${circuits || '<tr><td colspan="5">No capacity circuits</td></tr>'}</tbody></table>
</main></body></html>`;
}

const USAGE_INTERVALS = ["hour", "day", "week", "month"] as const satisfies readonly UsageInterval[];
const USAGE_GROUPS = [
  "provider",
  "customer",
  "user",
  "route",
  "job",
  "session_mode",
  "destination_domain",
  "destination_host",
  "destination_path_template",
  "country",
  "city",
  "outcome",
] as const satisfies readonly UsageGroupBy[];
type UsageQueryErrorCode =
  | "invalid_capacity_query_parameter"
  | "invalid_session_mode"
  | "invalid_status_query_parameter"
  | "invalid_usage_group"
  | "invalid_usage_interval"
  | "invalid_usage_preset"
  | "invalid_usage_provider"
  | "invalid_usage_query_parameter"
  | "invalid_usage_time_range";

class UsageQueryError extends Error {
  constructor(readonly code: UsageQueryErrorCode) {
    super(code);
  }
}

function includes<const Values extends readonly string[]>(values: Values, value: string): value is Values[number] {
  return values.some((candidate) => candidate === value);
}

const TIME_RANGE_PARAMETERS = ["preset", "from", "to"] as const;
const USAGE_QUERY_PARAMETERS = [
  ...TIME_RANGE_PARAMETERS,
  "interval",
  "groupBy",
  "provider",
  "sessionMode",
  "customerId",
  "userId",
  "routeId",
  "jobId",
  "logicalOperationId",
  "destinationDomain",
  "destinationHost",
  "destinationPathTemplate",
  "country",
  "city",
  "outcome",
] as const;

function assertQueryParameters(url: URL, allowed: readonly string[], error: UsageQueryErrorCode): void {
  const allowedNames = new Set(allowed);
  for (const name of url.searchParams.keys()) {
    if (!allowedNames.has(name)) throw new UsageQueryError(error);
  }
}

function timeRange(url: URL, now: number): { from: string; to: string } {
  const preset = url.searchParams.get("preset");
  const explicitFrom = url.searchParams.get("from");
  const explicitTo = url.searchParams.get("to");
  if (preset !== null && (explicitFrom !== null || explicitTo !== null)) throw new UsageQueryError("invalid_usage_time_range");
  const presetMs = preset === "day" ? 86_400_000 : preset === "week" ? 7 * 86_400_000 : preset === "month" ? 30 * 86_400_000 : undefined;
  if (preset !== null && presetMs === undefined) throw new UsageQueryError("invalid_usage_preset");
  let from: string;
  let to: string;
  try {
    from = expectIsoTimestamp(explicitFrom ?? new Date(now - (presetMs ?? 30 * 86_400_000)).toISOString(), "usage query from");
    to = expectIsoTimestamp(explicitTo ?? new Date(now).toISOString(), "usage query to");
  } catch {
    throw new UsageQueryError("invalid_usage_time_range");
  }
  if (Date.parse(from) >= Date.parse(to)) throw new UsageQueryError("invalid_usage_time_range");
  return { from, to };
}

function dateRangeQuery(url: URL, now: number): { from: string; to: string } {
  assertQueryParameters(url, TIME_RANGE_PARAMETERS, "invalid_usage_query_parameter");
  return timeRange(url, now);
}

function usageQuery(url: URL, now: number): UsageQuery {
  assertQueryParameters(url, USAGE_QUERY_PARAMETERS, "invalid_usage_query_parameter");
  const { from, to } = timeRange(url, now);
  const intervalValue = url.searchParams.get("interval") ?? "day";
  if (!includes(USAGE_INTERVALS, intervalValue)) throw new UsageQueryError("invalid_usage_interval");
  const groupValue = url.searchParams.get("groupBy") ?? undefined;
  if (groupValue !== undefined && !includes(USAGE_GROUPS, groupValue)) throw new UsageQueryError("invalid_usage_group");
  const providerValue = url.searchParams.get("provider") ?? undefined;
  if (providerValue !== undefined && providerValue.trim().length === 0) throw new UsageQueryError("invalid_usage_provider");
  const sessionMode = url.searchParams.get("sessionMode") ?? undefined;
  if (sessionMode !== undefined && sessionMode !== "managed" && sessionMode !== "stateless") {
    throw new UsageQueryError("invalid_session_mode");
  }
  return {
    from,
    to,
    interval: intervalValue,
    ...(groupValue === undefined ? {} : { groupBy: groupValue }),
    ...(providerValue === undefined ? {} : { provider: providerValue }),
    ...(sessionMode === undefined ? {} : { sessionMode }),
    ...Object.fromEntries(
      (
        [
          "customerId",
          "userId",
          "routeId",
          "jobId",
          "logicalOperationId",
          "destinationDomain",
          "destinationHost",
          "destinationPathTemplate",
          "country",
          "city",
          "outcome",
        ] as const
      ).flatMap((name) => {
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
    query.jobId === undefined &&
    query.logicalOperationId === undefined &&
    query.sessionMode === undefined &&
    query.destinationDomain === undefined &&
    query.destinationHost === undefined &&
    query.destinationPathTemplate === undefined &&
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
      if (url.pathname === "/v1/status") {
        json(response, 200, withFreshness(await this.store.latestCapabilityHealth(), now, this.options.staleAfterMs));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/usage") {
        const query = usageQuery(url, now);
        const persisted = canUsePersistedRollups(query) ? await this.store.listUsageRollups(query.from, query.to, query.interval) : [];
        const data = persisted.filter((rollup) =>
          query.groupBy === "customer" || query.customerId !== undefined
            ? rollup.group.customer !== undefined && (query.customerId === undefined || rollup.group.customer === query.customerId)
            : Object.keys(rollup.group).length === 0,
        );
        const rollups = data.length > 0 ? data : summarizeUsage(await this.store.listUsageRecords(query.from, query.to), query);
        json(response, 200, { from: query.from, to: query.to, interval: query.interval, groupBy: query.groupBy ?? null, data: rollups });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/usage/reconciliations") {
        const query = dateRangeQuery(url, now);
        json(response, 200, { from: query.from, to: query.to, data: await this.store.listUsageReconciliations(query.from, query.to) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/usage/events") {
        const query = dateRangeQuery(url, now);
        json(response, 200, { from: query.from, to: query.to, data: await this.store.listUsageAlertEvents(query.from, query.to) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/usage/capacity-pressure-evidence") {
        const query = dateRangeQuery(url, now);
        const data = (await this.store.listCapacityPressureEvidence(query.from)).filter((evidence) => evidence.observedAt < query.to);
        json(response, 200, { from: query.from, to: query.to, data });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/capacity") {
        assertQueryParameters(url, ["provider", "country", "city", "carrier"], "invalid_capacity_query_parameter");
        const to = new Date(now).toISOString();
        const from = new Date(now - 30 * 86_400_000).toISOString();
        const records = await this.store.listUsageRecords(from, to);
        const requestedProvider = url.searchParams.get("provider")?.trim() || undefined;
        const inventories = await this.store.listProviderInventories();
        const inventory =
          requestedProvider === undefined
            ? mostRecentInventory(inventories)
            : inventories.find((candidate) => candidate.provider === requestedProvider);
        const provider = requestedProvider ?? inventory?.provider;
        const data = summarizeUsage(records, {
          from,
          to,
          interval: "day",
          ...(provider === undefined ? {} : { provider }),
        });
        const capacityCircuits = await this.store.listCapacityCircuits(to);
        const activeConnections = (await this.store.listAllActiveTunnels(to)).filter(
          (connection) => connection.provider === provider && connection.endpointId !== undefined,
        );
        const slotLoads = new Map<string, number>();
        for (const connection of activeConnections) {
          if (connection.endpointId !== undefined) {
            slotLoads.set(connection.endpointId, (slotLoads.get(connection.endpointId) ?? 0) + 1);
          }
        }
        const compatibleSlots =
          inventory?.slots.filter(
            (slot) =>
              (url.searchParams.get("country") === null || slot.country === url.searchParams.get("country")?.toUpperCase()) &&
              (url.searchParams.get("city") === null || slot.city?.toLowerCase() === url.searchParams.get("city")?.toLowerCase()) &&
              (url.searchParams.get("carrier") === null || slot.carrier?.toLowerCase() === url.searchParams.get("carrier")?.toLowerCase()),
          ) ?? [];
        const capacity = capacityRecommendation(data, now, inventory?.slots.length, inventory?.monthlyPricePerSlotUsd);
        json(response, 200, {
          provider: provider ?? null,
          policy: CAPACITY_POLICY,
          routingPolicy: ROUTING_POLICY,
          recentCandidateScores: records
            .filter((record) => record.routingPolicyVersion !== undefined && record.routingScoreComponents !== undefined)
            .slice(-100)
            .map((record) => ({
              completedAt: record.completedAt,
              provider: record.provider,
              ...(record.proxySlotId === undefined ? {} : { proxySlotId: record.proxySlotId }),
              routingPolicyVersion: record.routingPolicyVersion,
              routingScore: record.routingScore,
              routingScoreComponents: record.routingScoreComponents,
              ...(record.providerOverride === undefined ? {} : { providerOverride: record.providerOverride }),
              ...(record.capacityCircuitState === undefined
                ? {}
                : {
                    capacityCircuitState: record.capacityCircuitState,
                    capacityCircuitReason: record.capacityCircuitReason,
                    capacityCircuitCooldownUntil: record.capacityCircuitCooldownUntil,
                  }),
            })),
          capacityCircuits,
          inventory:
            inventory === undefined
              ? null
              : {
                  ...inventory,
                  slots: inventory.slots.map((slot) => ({
                    ...slot,
                    activeConnections: slotLoads.get(slot.proxySlotId) ?? 0,
                    capacityPressure: (slotLoads.get(slot.proxySlotId) ?? 0) >= CAPACITY_POLICY.softConnectionsPerSlot,
                  })),
                },
          compatibleCapacity: {
            slots: compatibleSlots.length,
            healthySlots: compatibleSlots.filter((slot) => slot.healthy).length,
            unhealthySlots: compatibleSlots.filter((slot) => !slot.healthy).length,
            activeConnections: activeConnections.filter((connection) =>
              compatibleSlots.some((slot) => slot.proxySlotId === connection.endpointId),
            ).length,
          },
          current: capacity.latest ?? null,
          recommendation: capacity.recommendation ?? null,
          operatorActionRequired: capacity.recommendation !== undefined && capacity.recommendation.slotDelta !== 0,
        });
        return;
      }
      if (url.pathname === "/v1/status/history") {
        assertQueryParameters(url, ["limit"], "invalid_status_query_parameter");
        const requested = Number(url.searchParams.get("limit") ?? this.options.historyLimit);
        const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), this.options.historyLimit) : this.options.historyLimit;
        json(response, 200, { data: await this.store.capabilityHealthHistory(limit) });
        return;
      }
      if (url.pathname === "/v1/status/geographies") {
        assertQueryParameters(url, [], "invalid_status_query_parameter");
        const snapshot = await this.store.latestCapabilityHealth();
        json(response, 200, { data: snapshot?.geographies ?? [], generatedAt: snapshot?.generatedAt });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/status/validate") {
        assertQueryParameters(url, [], "invalid_status_query_parameter");
        if (this.options.healthAggregatorUrl === undefined || this.options.healthAggregatorToken === undefined) {
          json(response, 503, { error: "validation_unavailable" });
          return;
        }
        const result = await (this.options.fetchImplementation ?? fetch)(new URL("/v1/validate", this.options.healthAggregatorUrl), {
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
        const records = await this.store.listUsageRecords(from, to);
        const usage = storedUsage.length > 0 ? storedUsage : summarizeUsage(records, { from, to, interval: "day" });
        const inventory = mostRecentInventory(await this.store.listProviderInventories());
        const capacityUsage = summarizeUsage(records, {
          from,
          to,
          interval: "day",
          ...(inventory === undefined ? {} : { provider: inventory.provider }),
        });
        const profiles = await this.store.list();
        const accessGrants = (await Promise.all(profiles.map(async (profile) => this.store.listAccessGrants(profile.id)))).flat();
        const logicalSessions = (await Promise.all(accessGrants.map(async (grant) => this.store.listLogicalSessions(grant.id)))).flat();
        const html = Buffer.from(
          page(
            await this.store.latestCapabilityHealth(),
            usage,
            capacityUsage,
            inventory,
            profiles,
            accessGrants.map((grant) => toPublicAccessGrant(grant, now)),
            logicalSessions.map(toPublicLogicalSession),
            await this.store.listCapacityCircuits(to),
            now,
            this.options.staleAfterMs,
          ),
        );
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length, "cache-control": "no-store" });
        response.end(html);
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof UsageQueryError) {
        json(response, 400, { error: error.code });
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
