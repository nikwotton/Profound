import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as fc from "fast-check";
import { DEPLOYMENT_TERMINATE_AFTER_MS, evaluateDeploymentDrain, validateMigrationDeclaration } from "../../src/release-policy.js";

it.effect("property: one valid migration label is accepted for ordinary files", () =>
  Effect.sync(() => {
    fc.assert(
      fc.property(
        fc.constantFrom("migration:none", "migration:compatible", "migration:backfill", "migration:destructive"),
        (label) => validateMigrationDeclaration([label], ["README.md"]).errors.length === 0,
      ),
    );
  }),
);

it.effect("property: active tunnels are never terminated before the six-hour cutoff", () =>
  Effect.sync(() => {
    const startedAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: DEPLOYMENT_TERMINATE_AFTER_MS - 1 }),
        fc.integer({ min: 1, max: 100_000 }),
        (ageMs, activeTunnelCount) =>
          evaluateDeploymentDrain({
            startedAt: new Date(startedAtMs).toISOString(),
            now: new Date(startedAtMs + ageMs).toISOString(),
            activeTunnelCount,
          }).action !== "terminate",
      ),
    );
  }),
);
