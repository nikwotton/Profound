import assert from "node:assert/strict";
import { test } from "node:test";
import { runUnappliedMigrations } from "../src/migration-runner.js";

test("migration runner applies every unapplied migration in order and is restartable", async () => {
  const applied = new Set<string>(["20260101_existing"]);
  const effects: string[] = [];
  const ledger = {
    async listApplied() {
      return applied;
    },
    async markApplied(id: string) {
      applied.add(id);
    },
  };
  const migrations = [
    {
      id: "20260103_third",
      async apply() {
        effects.push("third");
      },
    },
    {
      id: "20260101_existing",
      async apply() {
        effects.push("existing");
      },
    },
    {
      id: "20260102_second",
      async apply() {
        effects.push("second");
      },
    },
  ];
  assert.deepEqual(await runUnappliedMigrations(migrations, ledger), ["20260102_second", "20260103_third"]);
  assert.deepEqual(effects, ["second", "third"]);
  assert.deepEqual(await runUnappliedMigrations(migrations, ledger), []);
});
