export interface Migration {
  id: string;
  apply(): Promise<void>;
}

export interface MigrationLedger {
  listApplied(): Promise<ReadonlySet<string>>;
  markApplied(id: string): Promise<void>;
}

export async function runUnappliedMigrations(migrations: readonly Migration[], ledger: MigrationLedger): Promise<string[]> {
  const ids = migrations.map((migration) => migration.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^\d{8}_[a-z0-9_]+$/.test(id))) {
    throw new Error("Migration IDs must be unique YYYYMMDD_name values");
  }
  const ordered = [...migrations].sort((left, right) => left.id.localeCompare(right.id));
  const applied = await ledger.listApplied();
  const completed: string[] = [];
  for (const migration of ordered) {
    if (applied.has(migration.id)) continue;
    await migration.apply();
    await ledger.markApplied(migration.id);
    completed.push(migration.id);
  }
  return completed;
}
