import { expectEnum, expectIsoTimestamp, expectNonNegativeNumber, expectOptionalString, expectRecord, expectString } from "./decoding.js";
import { CAPACITY_POLICY } from "./capacity-policy.js";
import type { UsageGroupBy, UsageInterval, UsageProvider, UsageRecord, UsageRollup } from "./types.js";

export { UsageAccountingWorker } from "./usage-accounting-worker.js";

const GIB = 1024 ** 3;
const SLOT_MONTH_MS = (365.25 / 12) * 24 * 60 * 60_000;

export interface ProviderCostTotal {
  provider: Exclude<UsageProvider, "unresolved">;
  periodStartedAt: string;
  periodEndsAt: string;
  amountUsd: number;
  sourceVersion: string;
}

export interface UsageQuery {
  from: string;
  to: string;
  interval: UsageInterval;
  groupBy?: UsageGroupBy;
  customerId?: string;
  provider?: UsageProvider;
  userId?: string;
  routeId?: string;
  jobId?: string;
  logicalOperationId?: string;
  sessionMode?: "managed" | "none";
  destinationDomain?: string;
  destinationHost?: string;
  destinationPathTemplate?: string;
  country?: string;
  city?: string;
  outcome?: string;
}

export interface ProvisionedProxySlotCapacity {
  id: string;
  proxySlotId: string;
  periodStartedAt: string;
  periodEndsAt: string;
  priceUsd: number;
  pricingVersion: string;
  country?: string;
  city?: string;
  health?: "healthy" | "unhealthy";
}

export function decodeProviderCostTotal(value: unknown, context = "provider cost total"): ProviderCostTotal {
  const total = expectRecord(value, context);
  const result = {
    provider: expectEnum(total["provider"], ["bright_data", "proxidize"] as const, `${context}.provider`),
    periodStartedAt: expectIsoTimestamp(total["periodStartedAt"], `${context}.periodStartedAt`),
    periodEndsAt: expectIsoTimestamp(total["periodEndsAt"], `${context}.periodEndsAt`),
    amountUsd: expectNonNegativeNumber(total["amountUsd"], `${context}.amountUsd`),
    sourceVersion: expectString(total["sourceVersion"], `${context}.sourceVersion`),
  };
  if (result.periodStartedAt >= result.periodEndsAt) throw new TypeError(`${context} must have a positive time range`);
  return result;
}

export function decodeProvisionedProxySlotCapacity(
  value: unknown,
  context = "provisioned proxy-slot capacity",
): ProvisionedProxySlotCapacity {
  const capacity = expectRecord(value, context);
  const healthValue = capacity["health"];
  const health = healthValue === undefined ? undefined : expectEnum(healthValue, ["healthy", "unhealthy"] as const, `${context}.health`);
  const country = expectOptionalString(capacity["country"], `${context}.country`);
  const city = expectOptionalString(capacity["city"], `${context}.city`);
  const result = {
    id: expectString(capacity["id"], `${context}.id`),
    proxySlotId: expectString(capacity["proxySlotId"], `${context}.proxySlotId`),
    periodStartedAt: expectIsoTimestamp(capacity["periodStartedAt"], `${context}.periodStartedAt`),
    periodEndsAt: expectIsoTimestamp(capacity["periodEndsAt"], `${context}.periodEndsAt`),
    priceUsd: expectNonNegativeNumber(capacity["priceUsd"], `${context}.priceUsd`),
    pricingVersion: expectString(capacity["pricingVersion"], `${context}.pricingVersion`),
    ...(country === undefined ? {} : { country }),
    ...(city === undefined ? {} : { city }),
    ...(health === undefined ? {} : { health }),
  };
  if (result.periodStartedAt >= result.periodEndsAt) throw new TypeError(`${context} must have a positive time range`);
  return result;
}

export function provisionedProxySlotCapacityRecord(capacity: ProvisionedProxySlotCapacity): UsageRecord {
  if (
    !Number.isFinite(Date.parse(capacity.periodStartedAt)) ||
    !Number.isFinite(Date.parse(capacity.periodEndsAt)) ||
    capacity.periodStartedAt >= capacity.periodEndsAt ||
    !Number.isFinite(capacity.priceUsd) ||
    capacity.priceUsd < 0
  ) {
    throw new Error("invalid_capacity_period");
  }
  return {
    kind: "capacity",
    id: `capacity:${capacity.id}`,
    logicalOperationId: `capacity:${capacity.id}`,
    accessGrantId: "Unallocated",
    routeId: "Unallocated",
    userId: "Unallocated",
    customerId: "Unallocated",
    provider: "proxidize",
    protocol: "socks5",
    outcome: "success",
    retryIndex: 0,
    failover: false,
    bytesSent: 0,
    bytesReceived: 0,
    endpointId: capacity.proxySlotId,
    proxySlotId: capacity.proxySlotId,
    ...(capacity.country === undefined ? { country: "US" } : { country: capacity.country }),
    ...(capacity.city === undefined ? {} : { city: capacity.city }),
    pricingVersion: capacity.pricingVersion,
    pricingModel: "per_device_month",
    priceUsd: capacity.priceUsd,
    capacityState: capacity.health === "unhealthy" ? "unhealthy" : "healthy_idle",
    capacityPolicyVersion: CAPACITY_POLICY.version,
    startedAt: capacity.periodStartedAt,
    completedAt: capacity.periodEndsAt,
  };
}

export interface UsageVarianceThresholds {
  absoluteFloorUsd: number;
  warningRelative: number;
  errorRelative: number;
}

function periodStart(value: string, interval: UsageInterval): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_usage_timestamp");
  date.setUTCMinutes(interval === "hour" ? 0 : date.getUTCMinutes(), 0, 0);
  if (interval !== "hour") date.setUTCHours(0, 0, 0, 0);
  if (interval === "week") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (interval === "month") date.setUTCDate(1);
  return date;
}

function nextPeriod(start: Date, interval: UsageInterval): Date {
  const next = new Date(start);
  if (interval === "hour") next.setUTCHours(next.getUTCHours() + 1);
  else if (interval === "day") next.setUTCDate(next.getUTCDate() + 1);
  else if (interval === "week") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function groupValue(record: UsageRecord, groupBy: UsageGroupBy | undefined): string {
  if (groupBy === undefined) return "all";
  if (groupBy === "provider") return record.provider;
  if (groupBy === "customer") return record.customerId;
  if (groupBy === "user") return record.userId;
  if (groupBy === "route") return record.routeId;
  if (groupBy === "job") return record.jobId ?? "Unallocated";
  if (groupBy === "session_mode") return record.sessionMode ?? "Unallocated";
  if (groupBy === "destination_domain") return record.destinationDomain ?? "Unknown";
  if (groupBy === "destination_host") return record.destinationHost ?? "Unknown";
  if (groupBy === "destination_path_template") return record.destinationPathTemplate ?? "Unknown";
  if (groupBy === "country") return record.country ?? "Unknown";
  if (groupBy === "city") return record.city ?? "Unknown";
  return record.outcome;
}

function matches(record: UsageRecord, query: UsageQuery): boolean {
  return (
    (query.customerId === undefined || record.customerId === query.customerId) &&
    (query.provider === undefined || record.provider === query.provider) &&
    (query.userId === undefined || record.userId === query.userId) &&
    (query.routeId === undefined || record.routeId === query.routeId) &&
    (query.jobId === undefined || record.jobId === query.jobId) &&
    (query.logicalOperationId === undefined || record.logicalOperationId === query.logicalOperationId) &&
    (query.sessionMode === undefined || record.sessionMode === query.sessionMode) &&
    (query.destinationDomain === undefined || record.destinationDomain === query.destinationDomain) &&
    (query.destinationHost === undefined || record.destinationHost === query.destinationHost) &&
    (query.destinationPathTemplate === undefined || record.destinationPathTemplate === query.destinationPathTemplate) &&
    (query.country === undefined || record.country === query.country) &&
    (query.city === undefined || record.city === query.city) &&
    (query.outcome === undefined || record.outcome === query.outcome)
  );
}

function unionDuration(windows: Array<{ start: number; end: number }>): number {
  const ordered = windows.filter((window) => window.end > window.start).sort((a, b) => a.start - b.start);
  let duration = 0;
  let currentStart = 0;
  let currentEnd = 0;
  for (const window of ordered) {
    if (window.start > currentEnd) {
      duration += Math.max(0, currentEnd - currentStart);
      currentStart = window.start;
      currentEnd = window.end;
    } else currentEnd = Math.max(currentEnd, window.end);
  }
  return duration + Math.max(0, currentEnd - currentStart);
}

function clippedWindow(
  startedAt: string | undefined,
  endedAt: string | undefined,
  periodStartMs: number,
  periodEndMs: number,
): { start: number; end: number } | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const start = Math.max(periodStartMs, Date.parse(startedAt));
  const end = Math.min(periodEndMs, Date.parse(endedAt));
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : undefined;
}

function peakConcurrency(windows: Array<{ start: number; end: number }>): number {
  const events = windows.flatMap((window) => [
    { at: window.start, delta: 1 },
    { at: window.end, delta: -1 },
  ]);
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function concurrencyPercentile(
  windows: Array<{ start: number; end: number }>,
  periodStartMs: number,
  periodEndMs: number,
  percentile: number,
): number {
  const events = [
    { at: periodStartMs, delta: 0 },
    { at: periodEndMs, delta: 0 },
    ...windows.flatMap((window) => [
      { at: window.start, delta: 1 },
      { at: window.end, delta: -1 },
    ]),
  ].sort((left, right) => left.at - right.at || left.delta - right.delta);
  const durations = new Map<number, number>();
  let current = 0;
  let previousAt = periodStartMs;
  for (const event of events) {
    if (event.at > previousAt) durations.set(current, (durations.get(current) ?? 0) + event.at - previousAt);
    current += event.delta;
    previousAt = event.at;
  }
  const target = Math.max(0, periodEndMs - periodStartMs) * percentile;
  let cumulative = 0;
  for (const [value, duration] of [...durations.entries()].sort((left, right) => left[0] - right[0])) {
    cumulative += duration;
    if (cumulative >= target) return value;
  }
  return 0;
}

function capacityMetrics(
  records: UsageRecord[],
  periodStartedAt: string,
  periodEndsAt: string,
): {
  activeConnectionMs: number;
  provisionedSlotMs: number;
  healthyIdleSlotMs: number;
  unhealthySlotMs: number;
  slotOccupancy: number;
  currentSlotOccupancy: number;
  provisionedSlots: number;
  activeConnections: number;
  peakConcurrentConnections: number;
  p95ConcurrentConnections: number;
  concurrencyUtilization: number;
  throughputUtilization: number;
  prioritizedGbUsed: number;
  prioritizedGbForecast: number;
  capacityDrivenFallbackCount: number;
  capacityFailureCount: number;
  capacityWaitMs: number;
  capacityConstraint?: "slot_exhaustion" | "geography" | "carrier" | "hard_limit" | "capacity_circuit";
} {
  const periodStartMs = Date.parse(periodStartedAt);
  const periodEndMs = Date.parse(periodEndsAt);
  const slots = new Map<
    string,
    {
      connections: Array<{ start: number; end: number }>;
      healthy: Array<{ start: number; end: number }>;
      unhealthy: Array<{ start: number; end: number }>;
    }
  >();
  for (const record of records) {
    if (record.proxySlotId === undefined) continue;
    const entry = slots.get(record.proxySlotId) ?? { connections: [], healthy: [], unhealthy: [] };
    const window =
      record.kind === "attempt"
        ? clippedWindow(record.connectionStartedAt, record.connectionEndedAt, periodStartMs, periodEndMs)
        : clippedWindow(record.startedAt, record.completedAt, periodStartMs, periodEndMs);
    if (window === undefined) continue;
    if (record.kind === "attempt") entry.connections.push(window);
    else if (record.capacityState === "unhealthy") entry.unhealthy.push(window);
    else entry.healthy.push(window);
    slots.set(record.proxySlotId, entry);
  }
  let activeConnectionMs = 0;
  let occupiedSlotMs = 0;
  let provisionedSlotMs = 0;
  let healthyIdleSlotMs = 0;
  let unhealthySlotMs = 0;
  let currentOccupied = 0;
  let currentConnections = 0;
  let currentProvisioned = 0;
  const allConnections: Array<{ start: number; end: number }> = [];
  const currentAt = Math.min(Date.now(), periodEndMs) - 1;
  for (const entry of slots.values()) {
    allConnections.push(...entry.connections);
    activeConnectionMs += entry.connections.reduce((sum, window) => sum + window.end - window.start, 0);
    occupiedSlotMs += unionDuration(entry.connections);
    const provisioned = [...entry.healthy, ...entry.unhealthy];
    provisionedSlotMs += unionDuration(provisioned);
    unhealthySlotMs += unionDuration(entry.unhealthy);
    const healthyMs = unionDuration(entry.healthy);
    const healthyOccupiedMs = unionDuration(
      entry.connections.flatMap((connection) =>
        entry.healthy.flatMap((healthy) => {
          const start = Math.max(connection.start, healthy.start);
          const end = Math.min(connection.end, healthy.end);
          return end > start ? [{ start, end }] : [];
        }),
      ),
    );
    healthyIdleSlotMs += Math.max(0, healthyMs - healthyOccupiedMs);
    const activeNow = entry.connections.filter((window) => window.start <= currentAt && window.end > currentAt).length;
    const isProvisioned = provisioned.some((window) => window.start <= currentAt && window.end > currentAt);
    if (activeNow > 0) currentOccupied += 1;
    currentConnections += activeNow;
    if (isProvisioned) currentProvisioned += 1;
  }
  const periodDurationMs = Math.max(1, periodEndMs - periodStartMs);
  const averageProvisionedSlots = provisionedSlotMs / periodDurationMs;
  const bytes = records
    .filter((record) => record.kind === "attempt")
    .reduce((sum, record) => sum + record.bytesSent + record.bytesReceived, 0);
  const observedMbps = (bytes * 8) / periodDurationMs / 1_000;
  const prioritizedGbUsed = bytes / GIB;
  const peakConcurrentConnections = peakConcurrency(allConnections);
  const p95ConcurrentConnections = concurrencyPercentile(allConnections, periodStartMs, periodEndMs, 0.95);
  const capacityConstraints = new Set(
    records.flatMap((record) => (record.capacityConstraint === undefined ? [] : [record.capacityConstraint])),
  );
  const capacityConstraint = capacityConstraints.has("geography")
    ? "geography"
    : capacityConstraints.has("carrier")
      ? "carrier"
      : capacityConstraints.has("slot_exhaustion")
        ? "slot_exhaustion"
        : undefined;
  return {
    activeConnectionMs,
    provisionedSlotMs,
    healthyIdleSlotMs,
    unhealthySlotMs,
    slotOccupancy: provisionedSlotMs === 0 ? 0 : occupiedSlotMs / provisionedSlotMs,
    currentSlotOccupancy: currentProvisioned === 0 ? 0 : currentOccupied / currentProvisioned,
    provisionedSlots: Math.ceil(averageProvisionedSlots),
    activeConnections: currentConnections,
    peakConcurrentConnections,
    p95ConcurrentConnections,
    concurrencyUtilization: provisionedSlotMs === 0 ? 0 : activeConnectionMs / (provisionedSlotMs * CAPACITY_POLICY.softConnectionsPerSlot),
    throughputUtilization:
      averageProvisionedSlots === 0 ? 0 : observedMbps / (averageProvisionedSlots * CAPACITY_POLICY.plannedMbpsPerSlot),
    prioritizedGbUsed,
    prioritizedGbForecast: prioritizedGbUsed * (SLOT_MONTH_MS / periodDurationMs),
    capacityDrivenFallbackCount: records.filter(
      (record) => record.kind === "attempt" && record.failover && record.capacityPressure === true,
    ).length,
    capacityFailureCount: records.filter(
      (record) => record.kind === "attempt" && record.outcome === "failure" && record.capacityPressure === true,
    ).length,
    capacityWaitMs: records.reduce((sum, record) => sum + (record.establishmentWaitMs ?? 0), 0),
    ...(capacityConstraint === undefined ? {} : { capacityConstraint }),
  };
}

function estimatedCost(
  records: UsageRecord[],
  periodStartedAt: string,
  periodEndsAt: string,
  customerId?: string,
): { amount: number; connectionMs: number } {
  let amount = 0;
  let connectionMs = 0;
  const slotCosts = new Map<string, number>();
  const slotConnections = new Map<string, Map<string, number>>();
  const periodStartMs = Date.parse(periodStartedAt);
  const periodEndMs = Date.parse(periodEndsAt);
  for (const record of records) {
    if (
      record.pricingModel === "per_gib" &&
      record.priceUsd !== undefined &&
      record.completedAt >= periodStartedAt &&
      record.completedAt < periodEndsAt &&
      (customerId === undefined || record.customerId === customerId)
    ) {
      amount += ((record.bytesSent + record.bytesReceived) / GIB) * record.priceUsd;
    }
    if (record.proxySlotId === undefined) continue;
    if (record.kind === "capacity" && record.pricingModel === "per_device_month" && record.priceUsd !== undefined) {
      const window = clippedWindow(record.startedAt, record.completedAt, periodStartMs, periodEndMs);
      if (window !== undefined) {
        slotCosts.set(
          record.proxySlotId,
          (slotCosts.get(record.proxySlotId) ?? 0) + ((window.end - window.start) / SLOT_MONTH_MS) * record.priceUsd,
        );
      }
    } else if (record.kind === "attempt") {
      const window = clippedWindow(record.connectionStartedAt, record.connectionEndedAt, periodStartMs, periodEndMs);
      if (window !== undefined) {
        const duration = window.end - window.start;
        connectionMs += customerId === undefined || record.customerId === customerId ? duration : 0;
        const byCustomer = slotConnections.get(record.proxySlotId) ?? new Map<string, number>();
        byCustomer.set(record.customerId, (byCustomer.get(record.customerId) ?? 0) + duration);
        slotConnections.set(record.proxySlotId, byCustomer);
      }
    }
  }
  for (const [slotId, slotCost] of slotCosts) {
    if (customerId === undefined) {
      amount += slotCost;
      continue;
    }
    const byCustomer = slotConnections.get(slotId) ?? new Map<string, number>();
    const total = [...byCustomer.values()].reduce((sum, value) => sum + value, 0);
    if (total === 0) {
      if (customerId === "Unallocated") amount += slotCost;
    } else {
      amount += slotCost * ((byCustomer.get(customerId) ?? 0) / total);
    }
  }
  return { amount, connectionMs };
}

export function summarizeUsage(
  records: readonly UsageRecord[],
  query: UsageQuery,
  totals: readonly ProviderCostTotal[] = [],
): UsageRollup[] {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("invalid_usage_range");
  const byPeriod = new Map<string, UsageRecord[]>();
  for (const record of records) {
    if (!matches(record, query)) continue;
    const completedAt = Date.parse(record.completedAt);
    const windowStartedAt = record.kind === "capacity" ? record.startedAt : record.connectionStartedAt;
    const windowEndsAt = record.kind === "capacity" ? record.completedAt : record.connectionEndedAt;
    const windowStart = windowStartedAt === undefined ? undefined : Date.parse(windowStartedAt);
    const windowEnd = windowEndsAt === undefined ? undefined : Date.parse(windowEndsAt);
    const windowOverlaps = windowStart !== undefined && windowEnd !== undefined && windowStart < to && windowEnd > from;
    if ((record.kind !== "attempt" || completedAt < from || completedAt >= to) && !windowOverlaps) continue;
    const starts = new Set<string>();
    if (record.kind === "attempt" && completedAt >= from && completedAt < to) {
      starts.add(periodStart(record.completedAt, query.interval).toISOString());
    }
    if (windowOverlaps) {
      let start = periodStart(new Date(Math.max(from, windowStart)).toISOString(), query.interval);
      while (start.getTime() < Math.min(to, windowEnd)) {
        starts.add(start.toISOString());
        start = nextPeriod(start, query.interval);
      }
    }
    for (const start of starts) {
      const entries = byPeriod.get(start) ?? [];
      entries.push(record);
      byPeriod.set(start, entries);
    }
  }
  const results: UsageRollup[] = [];
  for (const [periodStartedAt, periodEntries] of byPeriod) {
    const periodEndsAt = nextPeriod(new Date(periodStartedAt), query.interval).toISOString();
    const groupedValues =
      query.groupBy === undefined
        ? ["all"]
        : query.groupBy === "customer"
          ? [
              ...new Set([
                ...periodEntries.filter((record) => record.kind === "attempt").map((record) => record.customerId),
                ...(periodEntries.some((record) => record.kind === "capacity") ? ["Unallocated"] : []),
              ]),
            ]
          : [...new Set(periodEntries.map((record) => groupValue(record, query.groupBy)))];
    for (const groupedValue of groupedValues) {
      const entries =
        query.groupBy === undefined
          ? periodEntries
          : query.groupBy === "customer"
            ? periodEntries.filter((record) => record.kind === "capacity" || record.customerId === groupedValue)
            : periodEntries.filter((record) => groupValue(record, query.groupBy) === groupedValue);
      const completedEntries = entries.filter(
        (record) => record.kind === "attempt" && record.completedAt >= periodStartedAt && record.completedAt < periodEndsAt,
      );
      const operations = new Set(completedEntries.map((record) => record.logicalOperationId));
      const successful = new Set(
        completedEntries
          .filter((record) => record.outcome === "success" || record.outcome === "http_error")
          .map((record) => record.logicalOperationId),
      );
      const customerId = query.groupBy === "customer" ? groupedValue : query.customerId;
      const estimate = estimatedCost(query.groupBy === "customer" ? periodEntries : entries, periodStartedAt, periodEndsAt, customerId);
      const capacity = capacityMetrics(entries, periodStartedAt, periodEndsAt);
      const providers = new Set(entries.map((record) => record.provider).filter((provider) => provider !== "unresolved"));
      const matchingTotals = totals.filter(
        (total) => providers.has(total.provider) && total.periodStartedAt === periodStartedAt && total.periodEndsAt === periodEndsAt,
      );
      const reconciled =
        (query.groupBy === undefined || query.groupBy === "customer") && providers.size > 0 && matchingTotals.length === providers.size;
      const providerSpendUsd = reconciled
        ? matchingTotals.reduce((sum, total) => {
            if (query.groupBy !== "customer") return sum + total.amountUsd;
            const providerEntries = periodEntries.filter((record) => record.provider === total.provider);
            const providerEstimate = estimatedCost(providerEntries, periodStartedAt, periodEndsAt).amount;
            const customerEstimate = estimatedCost(providerEntries, periodStartedAt, periodEndsAt, groupedValue).amount;
            return (
              sum +
              (providerEstimate === 0
                ? groupedValue === "Unallocated"
                  ? total.amountUsd
                  : 0
                : total.amountUsd * (customerEstimate / providerEstimate))
            );
          }, 0)
        : 0;
      const group = query.groupBy === undefined ? {} : { [query.groupBy]: groupedValue };
      results.push({
        id: `${periodStartedAt}#${query.interval}#${query.groupBy ?? "all"}#${groupedValue}`,
        interval: query.interval,
        periodStartedAt,
        periodEndsAt,
        group,
        requestCount: operations.size,
        successCount: successful.size,
        retryCount: completedEntries.filter((record) => record.outcome === "retry").length,
        failoverCount: completedEntries.filter((record) => record.failover).length,
        bytesSent: completedEntries.reduce((sum, record) => sum + record.bytesSent, 0),
        bytesReceived: completedEntries.reduce((sum, record) => sum + record.bytesReceived, 0),
        ...capacity,
        capacityPolicyVersion: CAPACITY_POLICY.version,
        providerSpendUsd,
        attributedCostUsd: reconciled && query.groupBy !== "customer" ? providerSpendUsd : estimate.amount,
        estimatedCostUsd: estimate.amount,
        costStatus: reconciled ? "reconciled" : "estimated",
        pricingVersions: [
          ...new Set(entries.flatMap((record) => (record.pricingVersion === undefined ? [] : [record.pricingVersion]))),
        ].sort(),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return results.sort((a, b) => a.periodStartedAt.localeCompare(b.periodStartedAt) || a.id.localeCompare(b.id));
}
