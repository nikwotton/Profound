import type { UsageRepository } from "./store.js";
import type { CapacityPressureEvidence, UsageAlertEvent, UsageReconciliation, UsageRecord, UsageRollup } from "./types.js";

interface InMemoryUsageState {
  readonly usageRecords: Map<string, UsageRecord>;
  readonly usageRollups: Map<string, UsageRollup>;
  readonly usageReconciliations: Map<string, UsageReconciliation>;
  readonly usageAlertEvents: Map<string, UsageAlertEvent>;
  readonly capacityPressureEvidence: Map<string, CapacityPressureEvidence>;
}

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryUsageRepository implements UsageRepository {
  constructor(private readonly state: InMemoryUsageState) {}

  async recordUsage(record: UsageRecord): Promise<boolean> {
    if (this.state.usageRecords.has(record.id)) return false;
    this.state.usageRecords.set(record.id, copy(record));
    return true;
  }

  async listUsageRecords(from: string, to: string, options: { limit?: number; newestFirst?: boolean } = {}): Promise<UsageRecord[]> {
    const records = [...this.state.usageRecords.values()]
      .filter((record) => record.completedAt >= from && record.completedAt < to)
      .toSorted((left, right) =>
        options.newestFirst ? right.completedAt.localeCompare(left.completedAt) : left.completedAt.localeCompare(right.completedAt),
      );
    return records.slice(0, options.limit ?? records.length).map(copy);
  }

  async saveUsageRollup(rollup: UsageRollup): Promise<void> {
    this.state.usageRollups.set(rollup.id, copy(rollup));
  }

  async listUsageRollups(from: string, to: string, interval: UsageRollup["interval"]): Promise<UsageRollup[]> {
    return [...this.state.usageRollups.values()]
      .filter((rollup) => rollup.interval === interval && rollup.periodStartedAt >= from && rollup.periodStartedAt < to)
      .toSorted((left, right) => left.periodStartedAt.localeCompare(right.periodStartedAt))
      .map(copy);
  }

  async saveUsageReconciliation(reconciliation: UsageReconciliation): Promise<boolean> {
    if (this.state.usageReconciliations.has(reconciliation.id)) return false;
    this.state.usageReconciliations.set(reconciliation.id, copy(reconciliation));
    return true;
  }

  async listUsageReconciliations(from: string, to: string): Promise<UsageReconciliation[]> {
    return [...this.state.usageReconciliations.values()]
      .filter((value) => value.periodStartedAt >= from && value.periodStartedAt < to)
      .toSorted((left, right) => left.periodStartedAt.localeCompare(right.periodStartedAt))
      .map(copy);
  }

  async saveUsageAlertEvent(event: UsageAlertEvent): Promise<boolean> {
    if (this.state.usageAlertEvents.has(event.id)) return false;
    this.state.usageAlertEvents.set(event.id, copy(event));
    return true;
  }

  async listUsageAlertEvents(from: string, to: string): Promise<UsageAlertEvent[]> {
    return [...this.state.usageAlertEvents.values()]
      .filter((event) => event.periodStartedAt >= from && event.periodStartedAt < to)
      .toSorted((left, right) => left.periodStartedAt.localeCompare(right.periodStartedAt))
      .map(copy);
  }

  async saveCapacityPressureEvidence(evidence: CapacityPressureEvidence): Promise<void> {
    this.state.capacityPressureEvidence.set(evidence.id, copy(evidence));
  }

  async listCapacityPressureEvidence(observedAfter: string): Promise<CapacityPressureEvidence[]> {
    return [...this.state.capacityPressureEvidence.values()]
      .filter((evidence) => evidence.observedAt >= observedAfter)
      .toSorted((left, right) => left.observedAt.localeCompare(right.observedAt))
      .map(copy);
  }
}
