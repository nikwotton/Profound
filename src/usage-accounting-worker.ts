import { CAPACITY_POLICY } from "./capacity-policy.js";
import { ACCOUNTING_POLICY } from "./service-policies.js";
import type { UsageRepository } from "./store.js";
import type { CapacityPressureEvidence, UsageAlertEvent, UsageInterval, UsageReconciliation, UsageRollup } from "./domain/usage.js";
import type { ProviderId } from "./domain/routing.js";
import { summarizeUsage, type ProviderCostTotal, type UsageVarianceThresholds } from "./usage-accounting-core.js";

const DEFAULT_VARIANCE_THRESHOLDS: UsageVarianceThresholds = {
  absoluteFloorUsd: ACCOUNTING_POLICY.varianceAbsoluteFloorUsd,
  warningRelative: ACCOUNTING_POLICY.varianceWarningRelative,
  errorRelative: ACCOUNTING_POLICY.varianceErrorRelative,
};

export class UsageAccountingWorker {
  constructor(
    private readonly store: Pick<
      UsageRepository,
      | "listUsageRecords"
      | "saveUsageRollup"
      | "saveUsageReconciliation"
      | "listUsageReconciliations"
      | "saveUsageAlertEvent"
      | "saveCapacityPressureEvidence"
    >,
    private readonly totals: () => readonly ProviderCostTotal[] = () => [],
    private readonly thresholds: UsageVarianceThresholds = DEFAULT_VARIANCE_THRESHOLDS,
    private readonly onReconciliation: (record: UsageReconciliation) => void = () => undefined,
    private readonly onCapacityPressure: (rollup: UsageRollup, provider: ProviderId) => void = () => undefined,
  ) {}

  async run(from: string, to: string): Promise<number> {
    const records = await this.store.listUsageRecords(from, to);
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
        kind: "provider_usage_adjustment",
        id: `${total.provider}#${total.periodStartedAt}#${total.periodEndsAt}#${total.sourceVersion}`,
        provider: total.provider,
        periodStartedAt: total.periodStartedAt,
        periodEndsAt: total.periodEndsAt,
        estimatedTotalUsd: estimate,
        reportedTotalUsd: total.amountUsd,
        adjustmentUsd: varianceUsd,
        relativeVariance,
        varianceAttribution: "Unallocated",
        severity: severe || (significant && repeated) ? "error" : significant ? "warning" : "normal",
        sourceVersion: total.sourceVersion,
        createdAt: new Date().toISOString(),
      };
      if (await this.store.saveUsageReconciliation(reconciliation)) {
        if (reconciliation.severity !== "normal") {
          const alert: UsageAlertEvent = {
            id: `reconciliation:${reconciliation.id}`,
            kind: "reconciliation_variance",
            severity: reconciliation.severity,
            provider: reconciliation.provider,
            periodStartedAt: reconciliation.periodStartedAt,
            periodEndsAt: reconciliation.periodEndsAt,
            relatedRecordId: reconciliation.id,
            varianceUsd: reconciliation.adjustmentUsd,
            relativeVariance: reconciliation.relativeVariance,
            createdAt: reconciliation.createdAt,
          };
          await this.store.saveUsageAlertEvent(alert);
        }
        this.onReconciliation(reconciliation);
      }
      reconciliations.push(reconciliation);
    }
    const rollups = [
      ...summarizeUsage(records, { from, to, interval: "hour" }, totals),
      ...summarizeUsage(records, { from, to, interval: "day" }, totals),
      ...summarizeUsage(records, { from, to, interval: "hour", groupBy: "customer" }, totals),
      ...summarizeUsage(records, { from, to, interval: "day", groupBy: "customer" }, totals),
    ];
    for (const interval of ["hour", "day"] as const) {
      const customerRollups = rollups.filter((rollup) => rollup.interval === interval && rollup.group.customer !== undefined);
      const periods = new Set(customerRollups.map((rollup) => `${rollup.periodStartedAt}\u0000${rollup.periodEndsAt}`));
      for (const key of periods) {
        const [periodStartedAt, periodEndsAt, unexpected] = key.split("\u0000");
        if (periodStartedAt === undefined || periodEndsAt === undefined || unexpected !== undefined) {
          throw new Error("invalid_usage_period_key");
        }
        const periodReconciliations = reconciliations.filter(
          (record) => record.periodStartedAt === periodStartedAt && record.periodEndsAt === periodEndsAt,
        );
        if (periodReconciliations.length === 0) continue;
        const periodCustomers = customerRollups.filter((rollup) => rollup.periodStartedAt === periodStartedAt);
        for (const rollup of periodCustomers) {
          rollup.attributedCostUsd = rollup.estimatedCostUsd;
          rollup.costStatus = "reconciled";
        }
        const variance = periodReconciliations.reduce((sum, record) => sum + record.adjustmentUsd, 0);
        let unallocated = periodCustomers.find((rollup) => rollup.group.customer === "Unallocated");
        if (unallocated === undefined) {
          const created: UsageRollup = {
            id: `${periodStartedAt}#${interval}#customer#Unallocated`,
            interval,
            periodStartedAt,
            periodEndsAt,
            group: { customer: "Unallocated" },
            operationCount: 0,
            successCount: 0,
            retryCount: 0,
            failoverCount: 0,
            bytesSent: 0,
            bytesReceived: 0,
            averageLatencyMs: 0,
            p95LatencyMs: 0,
            activeConnectionMs: 0,
            provisionedSlotMs: 0,
            healthyIdleSlotMs: 0,
            unhealthySlotMs: 0,
            slotOccupancy: 0,
            currentSlotOccupancy: 0,
            provisionedSlots: 0,
            activeConnections: 0,
            peakConcurrentConnections: 0,
            p95ConcurrentConnections: 0,
            concurrencyUtilization: 0,
            throughputUtilization: 0,
            prioritizedGbUsed: 0,
            prioritizedGbForecast: 0,
            capacityDrivenFallbackCount: 0,
            capacityFailureCount: 0,
            capacityWaitMs: 0,
            capacityPolicyVersion: CAPACITY_POLICY.version,
            providerSpendUsd: 0,
            attributedCostUsd: 0,
            estimatedCostUsd: 0,
            costStatus: "reconciled",
            pricingVersions: [],
            updatedAt: new Date().toISOString(),
          };
          rollups.push(created);
          unallocated = created;
        }
        unallocated.attributedCostUsd += variance;
      }
    }
    for (const rollup of rollups) await this.store.saveUsageRollup(rollup);
    for (const provider of ["bright_data", "proxidize"] as const) {
      const pressureRecords = records.filter((record) => {
        if (record.kind === "capacity") return record.provider === provider;
        if (record.capacityPressure !== true) return false;
        return (record.capacityPressureProvider ?? (record.provider === "unresolved" ? undefined : record.provider)) === provider;
      });
      const pressureRollups = [
        ...summarizeUsage(pressureRecords, { from, to, interval: "hour" }),
        ...summarizeUsage(pressureRecords, { from, to, interval: "day" }),
      ];
      for (const rollup of pressureRollups) {
        if (
          rollup.capacityFailureCount === 0 &&
          rollup.capacityDrivenFallbackCount === 0 &&
          rollup.concurrencyUtilization <= 1 &&
          rollup.throughputUtilization <= 1
        )
          continue;
        const observedAt = new Date().toISOString();
        const evidence: CapacityPressureEvidence = {
          id: `capacity:${provider}:${rollup.id}:${rollup.capacityPolicyVersion}`,
          provider,
          periodStartedAt: rollup.periodStartedAt,
          periodEndsAt: rollup.periodEndsAt,
          relatedRollupId: rollup.id,
          capacityPolicyVersion: rollup.capacityPolicyVersion,
          ...(rollup.capacityConstraint === undefined ? {} : { capacityConstraint: rollup.capacityConstraint }),
          capacityDrivenFallbackCount: rollup.capacityDrivenFallbackCount,
          capacityFailureCount: rollup.capacityFailureCount,
          capacityWaitMs: rollup.capacityWaitMs,
          concurrencyUtilization: rollup.concurrencyUtilization,
          throughputUtilization: rollup.throughputUtilization,
          observedAt,
        };
        await this.store.saveCapacityPressureEvidence(evidence);
        const recommendation: UsageAlertEvent = {
          id: `capacity:${provider}:${rollup.id}:${rollup.capacityPolicyVersion}`,
          kind: "capacity_recommendation",
          severity: rollup.capacityFailureCount > 0 ? "error" : "warning",
          provider,
          periodStartedAt: rollup.periodStartedAt,
          periodEndsAt: rollup.periodEndsAt,
          relatedRecordId: rollup.id,
          capacityPolicyVersion: rollup.capacityPolicyVersion,
          ...(rollup.capacityConstraint === undefined ? {} : { capacityConstraint: rollup.capacityConstraint }),
          capacityDrivenFallbackCount: rollup.capacityDrivenFallbackCount,
          capacityFailureCount: rollup.capacityFailureCount,
          capacityWaitMs: rollup.capacityWaitMs,
          createdAt: observedAt,
        };
        if (await this.store.saveUsageAlertEvent(recommendation)) this.onCapacityPressure(rollup, provider);
      }
    }
    return rollups.length;
  }
}
