import type { RouteStore } from "./store.js";
import type { UsageGroupBy, UsageInterval, UsageProvider, UsageReconciliation, UsageRecord, UsageRollup } from "./types.js";

const GIB = 1024 ** 3;
const DEVICE_MONTH_MS = (365.25 / 12) * 24 * 60 * 60_000;

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
  country?: string;
  city?: string;
  outcome?: string;
}

export interface UnallocatedDeviceCapacity {
  id: string;
  endpointId: string;
  periodStartedAt: string;
  periodEndsAt: string;
  priceUsd: number;
  pricingVersion: string;
  health?: "healthy" | "unhealthy";
}

export function unallocatedDeviceCapacityRecord(capacity: UnallocatedDeviceCapacity): UsageRecord {
  if (Date.parse(capacity.periodStartedAt) >= Date.parse(capacity.periodEndsAt)) throw new Error("invalid_capacity_period");
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
    country: "US",
    endpointId: capacity.endpointId,
    deviceLeaseKey: `proxidize:${capacity.endpointId}`,
    leaseWindowStartedAt: capacity.periodStartedAt,
    leaseWindowEndsAt: capacity.periodEndsAt,
    pricingVersion: capacity.pricingVersion,
    pricingModel: "per_device_month",
    priceUsd: capacity.priceUsd,
    capacityState: capacity.health === "unhealthy" ? "unhealthy" : "healthy_idle",
    startedAt: capacity.periodStartedAt,
    completedAt: capacity.periodEndsAt,
  };
}

export interface UsageVarianceThresholds {
  absoluteFloorUsd: number;
  warningRelative: number;
  errorRelative: number;
}

const DEFAULT_VARIANCE_THRESHOLDS: UsageVarianceThresholds = {
  absoluteFloorUsd: 1,
  warningRelative: 0.05,
  errorRelative: 0.15,
};

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
    (query.country === undefined || record.country === query.country) &&
    (query.city === undefined || record.city === query.city) &&
    (query.outcome === undefined || record.outcome === query.outcome)
  );
}

function contributesToPeriod(record: UsageRecord, periodStartedAt: string, periodEndsAt: string): boolean {
  if (record.kind === "attempt" && record.completedAt >= periodStartedAt && record.completedAt < periodEndsAt) return true;
  return (
    record.leaseWindowStartedAt !== undefined &&
    record.leaseWindowEndsAt !== undefined &&
    record.leaseWindowStartedAt < periodEndsAt &&
    record.leaseWindowEndsAt > periodStartedAt
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

function capacityDurations(
  records: UsageRecord[],
  periodStartedAt: string,
  periodEndsAt: string,
): {
  allocatedMs: number;
  provisionedMs: number;
  healthyIdleMs: number;
  unhealthyMs: number;
  currentUtilization: number;
} {
  const periodStartMs = Date.parse(periodStartedAt);
  const periodEndMs = Date.parse(periodEndsAt);
  const devices = new Map<
    string,
    {
      allocated: Array<{ start: number; end: number }>;
      healthy: Array<{ start: number; end: number }>;
      unhealthy: Array<{ start: number; end: number }>;
    }
  >();
  for (const record of records) {
    if (record.deviceLeaseKey === undefined || record.leaseWindowStartedAt === undefined || record.leaseWindowEndsAt === undefined)
      continue;
    const entry = devices.get(record.deviceLeaseKey) ?? { allocated: [], healthy: [], unhealthy: [] };
    const window = {
      start: Math.max(periodStartMs, Date.parse(record.leaseWindowStartedAt)),
      end: Math.min(periodEndMs, Date.parse(record.leaseWindowEndsAt)),
    };
    if (record.kind === "attempt") entry.allocated.push(window);
    else if (record.capacityState === "unhealthy") entry.unhealthy.push(window);
    else entry.healthy.push(window);
    devices.set(record.deviceLeaseKey, entry);
  }
  let allocatedMs = 0;
  let provisionedMs = 0;
  let healthyIdleMs = 0;
  let unhealthyMs = 0;
  let currentAllocated = 0;
  let currentProvisioned = 0;
  const currentAt = periodEndMs - 1;
  for (const entry of devices.values()) {
    allocatedMs += unionDuration(entry.allocated);
    healthyIdleMs += unionDuration(entry.healthy);
    unhealthyMs += unionDuration(entry.unhealthy);
    provisionedMs += unionDuration([...entry.allocated, ...entry.healthy, ...entry.unhealthy]);
    const isAllocated = entry.allocated.some((window) => window.start <= currentAt && window.end > currentAt);
    const isProvisioned =
      isAllocated || [...entry.healthy, ...entry.unhealthy].some((window) => window.start <= currentAt && window.end > currentAt);
    if (isAllocated) currentAllocated += 1;
    if (isProvisioned) currentProvisioned += 1;
  }
  return {
    allocatedMs,
    provisionedMs,
    healthyIdleMs,
    unhealthyMs,
    currentUtilization: currentProvisioned === 0 ? 0 : currentAllocated / currentProvisioned,
  };
}

function estimatedCost(records: UsageRecord[], periodStartedAt: string, periodEndsAt: string): { amount: number; leaseMs: number } {
  let amount = 0;
  const leaseWindows = new Map<string, Array<{ start: number; end: number; price: number }>>();
  for (const record of records) {
    if (
      record.pricingModel === "per_gib" &&
      record.priceUsd !== undefined &&
      record.completedAt >= periodStartedAt &&
      record.completedAt < periodEndsAt
    ) {
      amount += ((record.bytesSent + record.bytesReceived) / GIB) * record.priceUsd;
    }
    if (
      record.pricingModel === "per_device_month" &&
      record.priceUsd !== undefined &&
      record.deviceLeaseKey !== undefined &&
      record.leaseWindowStartedAt !== undefined &&
      record.leaseWindowEndsAt !== undefined
    ) {
      const windows = leaseWindows.get(record.deviceLeaseKey) ?? [];
      windows.push({
        start: Math.max(Date.parse(periodStartedAt), Date.parse(record.leaseWindowStartedAt)),
        end: Math.min(Date.parse(periodEndsAt), Date.parse(record.leaseWindowEndsAt)),
        price: record.priceUsd,
      });
      leaseWindows.set(record.deviceLeaseKey, windows);
    }
  }
  let leaseMs = 0;
  for (const windows of leaseWindows.values()) {
    const duration = unionDuration(windows);
    leaseMs += duration;
    amount += (duration / DEVICE_MONTH_MS) * (windows.at(-1)?.price ?? 0);
  }
  return { amount, leaseMs };
}

export function summarizeUsage(
  records: readonly UsageRecord[],
  query: UsageQuery,
  totals: readonly ProviderCostTotal[] = [],
): UsageRollup[] {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("invalid_usage_range");
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const completedAt = Date.parse(record.completedAt);
    const leaseStart = record.leaseWindowStartedAt === undefined ? undefined : Date.parse(record.leaseWindowStartedAt);
    const leaseEnd = record.leaseWindowEndsAt === undefined ? undefined : Date.parse(record.leaseWindowEndsAt);
    const leaseOverlaps = leaseStart !== undefined && leaseEnd !== undefined && leaseStart < to && leaseEnd > from;
    if ((completedAt < from || completedAt >= to) && !leaseOverlaps) continue;
    if (!matches(record, query)) continue;
    const starts = new Set<string>();
    if (record.kind === "attempt" && completedAt >= from && completedAt < to) {
      starts.add(periodStart(record.completedAt, query.interval).toISOString());
    }
    if (leaseOverlaps) {
      let start = periodStart(new Date(Math.max(from, leaseStart)).toISOString(), query.interval);
      while (start.getTime() < Math.min(to, leaseEnd)) {
        starts.add(start.toISOString());
        start = nextPeriod(start, query.interval);
      }
    }
    for (const start of starts) {
      const key = `${start}\u0000${groupValue(record, query.groupBy)}`;
      const entries = grouped.get(key) ?? [];
      entries.push(record);
      grouped.set(key, entries);
    }
  }
  const results: UsageRollup[] = [];
  for (const [key, entries] of grouped) {
    const [periodStartedAt, groupedValue] = key.split("\u0000") as [string, string];
    const periodEndsAt = nextPeriod(new Date(periodStartedAt), query.interval).toISOString();
    const completedEntries = entries.filter((record) => record.completedAt >= periodStartedAt && record.completedAt < periodEndsAt);
    const operations = new Set(completedEntries.filter((record) => record.kind === "attempt").map((record) => record.logicalOperationId));
    const successful = new Set(
      completedEntries
        .filter((record) => record.kind === "attempt" && (record.outcome === "success" || record.outcome === "http_error"))
        .map((record) => record.logicalOperationId),
    );
    const estimate = estimatedCost(entries, periodStartedAt, periodEndsAt);
    const capacity = capacityDurations(entries, periodStartedAt, periodEndsAt);
    const providers = new Set(entries.map((record) => record.provider).filter((provider) => provider !== "unresolved"));
    const matchingTotals = totals.filter(
      (total) => providers.has(total.provider) && total.periodStartedAt === periodStartedAt && total.periodEndsAt === periodEndsAt,
    );
    const reconciled = providers.size > 0 && matchingTotals.length === providers.size;
    const providerSpendUsd = reconciled ? matchingTotals.reduce((sum, total) => sum + total.amountUsd, 0) : 0;
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
      deviceLeaseMs: capacity.allocatedMs,
      provisionedDeviceMs: capacity.provisionedMs,
      healthyIdleDeviceMs: capacity.healthyIdleMs,
      unhealthyDeviceMs: capacity.unhealthyMs,
      allocationUtilization: capacity.provisionedMs === 0 ? 0 : capacity.allocatedMs / capacity.provisionedMs,
      currentAllocationUtilization: capacity.currentUtilization,
      providerSpendUsd,
      attributedCostUsd: reconciled ? providerSpendUsd : estimate.amount,
      estimatedCostUsd: estimate.amount,
      costStatus: reconciled ? "reconciled" : "estimated",
      pricingVersions: [
        ...new Set(entries.flatMap((record) => (record.pricingVersion === undefined ? [] : [record.pricingVersion]))),
      ].sort(),
      updatedAt: new Date().toISOString(),
    });
  }
  return results.sort((a, b) => a.periodStartedAt.localeCompare(b.periodStartedAt) || a.id.localeCompare(b.id));
}

export class UsageAccountingWorker {
  constructor(
    private readonly store: Pick<
      RouteStore,
      "listUsageRecords" | "saveUsageRollup" | "saveUsageReconciliation" | "listUsageReconciliations"
    >,
    private readonly totals: () => readonly ProviderCostTotal[] = () => [],
    private readonly thresholds: UsageVarianceThresholds = DEFAULT_VARIANCE_THRESHOLDS,
    private readonly onReconciliation: (record: UsageReconciliation) => void = () => undefined,
  ) {}

  async run(from: string, to: string): Promise<number> {
    const records = await this.store.listUsageRecords(new Date(Date.parse(from) - 15 * 60_000).toISOString(), to);
    const totals = this.totals();
    const historical = await this.store.listUsageReconciliations(new Date(Date.parse(from) - 32 * 86_400_000).toISOString(), to);
    const reconciliations: UsageReconciliation[] = [];
    for (const total of totals) {
      const duration = Date.parse(total.periodEndsAt) - Date.parse(total.periodStartedAt);
      const interval: UsageInterval = duration <= 3_600_000 ? "hour" : "day";
      const estimate =
        summarizeUsage(records, {
          from: total.periodStartedAt,
          to: total.periodEndsAt,
          interval,
          provider: total.provider,
        })[0]?.estimatedCostUsd ?? 0;
      const varianceUsd = total.amountUsd - estimate;
      const relativeVariance = estimate === 0 ? (varianceUsd === 0 ? 0 : 1) : Math.abs(varianceUsd) / Math.abs(estimate);
      const exceedsFloor = Math.abs(varianceUsd) >= this.thresholds.absoluteFloorUsd;
      const severe = exceedsFloor && relativeVariance > this.thresholds.errorRelative;
      const significant = exceedsFloor && relativeVariance > this.thresholds.warningRelative;
      const repeated = historical.some(
        (record) => record.provider === total.provider && record.severity !== "normal" && record.sourceVersion !== total.sourceVersion,
      );
      const reconciliation: UsageReconciliation = {
        id: `${total.provider}#${total.periodStartedAt}#${total.periodEndsAt}#${total.sourceVersion}`,
        provider: total.provider,
        periodStartedAt: total.periodStartedAt,
        periodEndsAt: total.periodEndsAt,
        estimatedTotalUsd: estimate,
        reportedTotalUsd: total.amountUsd,
        varianceUsd,
        relativeVariance,
        varianceAttribution: "Unallocated",
        severity: severe || (significant && repeated) ? "error" : significant ? "warning" : "normal",
        sourceVersion: total.sourceVersion,
        createdAt: new Date().toISOString(),
      };
      if (await this.store.saveUsageReconciliation(reconciliation)) this.onReconciliation(reconciliation);
      reconciliations.push(reconciliation);
    }
    const rollups = [
      ...summarizeUsage(records, { from, to, interval: "hour" }, totals),
      ...summarizeUsage(records, { from, to, interval: "day" }, totals),
      ...summarizeUsage(records, { from, to, interval: "hour", groupBy: "customer" }),
      ...summarizeUsage(records, { from, to, interval: "day", groupBy: "customer" }),
    ];
    for (const interval of ["hour", "day"] as const) {
      const customerRollups = rollups.filter((rollup) => rollup.interval === interval && rollup.group.customer !== undefined);
      const periods = new Set(customerRollups.map((rollup) => `${rollup.periodStartedAt}\u0000${rollup.periodEndsAt}`));
      for (const key of periods) {
        const [periodStartedAt, periodEndsAt] = key.split("\u0000") as [string, string];
        const periodRecords = records.filter(
          (record) => contributesToPeriod(record, periodStartedAt, periodEndsAt) && record.provider !== "unresolved",
        );
        const providers = new Set(periodRecords.map((record) => record.provider));
        const periodReconciliations = reconciliations.filter(
          (record) => record.periodStartedAt === periodStartedAt && record.periodEndsAt === periodEndsAt && providers.has(record.provider),
        );
        if (providers.size === 0 || periodReconciliations.length !== providers.size) continue;
        const periodCustomers = customerRollups.filter((rollup) => rollup.periodStartedAt === periodStartedAt);
        for (const rollup of periodCustomers) {
          rollup.attributedCostUsd = rollup.estimatedCostUsd;
          rollup.costStatus = "reconciled";
        }
        const variance = periodReconciliations.reduce((sum, record) => sum + record.varianceUsd, 0);
        let unallocated = periodCustomers.find((rollup) => rollup.group.customer === "Unallocated");
        if (unallocated === undefined) {
          unallocated = {
            id: `${periodStartedAt}#${interval}#customer#Unallocated`,
            interval,
            periodStartedAt,
            periodEndsAt,
            group: { customer: "Unallocated" },
            requestCount: 0,
            successCount: 0,
            retryCount: 0,
            failoverCount: 0,
            bytesSent: 0,
            bytesReceived: 0,
            deviceLeaseMs: 0,
            provisionedDeviceMs: 0,
            healthyIdleDeviceMs: 0,
            unhealthyDeviceMs: 0,
            allocationUtilization: 0,
            currentAllocationUtilization: 0,
            providerSpendUsd: 0,
            attributedCostUsd: 0,
            estimatedCostUsd: 0,
            costStatus: "reconciled",
            pricingVersions: [],
            updatedAt: new Date().toISOString(),
          };
          rollups.push(unallocated);
        }
        unallocated.attributedCostUsd += variance;
      }
    }
    for (const rollup of rollups) await this.store.saveUsageRollup(rollup);
    return rollups.length;
  }
}
