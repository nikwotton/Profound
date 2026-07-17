export const MIGRATION_LABELS = ["migration:none", "migration:compatible", "migration:backfill", "migration:destructive"] as const;

export type MigrationLabel = (typeof MIGRATION_LABELS)[number];

const MIGRATION_SENSITIVE_PATHS = [
  /^infra\//,
  /^migrations\//,
  /^openapi\//,
  /^src\/(?:dynamo-store|store|types)\.ts$/,
  /^src\/control-contract\.ts$/,
  /^sst\.config\.ts$/,
];

export interface MigrationPolicyResult {
  declaration?: MigrationLabel;
  errors: string[];
  sensitiveFiles: string[];
}

export function validateMigrationDeclaration(labels: readonly string[], files: readonly string[]): MigrationPolicyResult {
  const declarations = MIGRATION_LABELS.filter((label) => labels.includes(label));
  const sensitiveFiles = files.filter((file) => MIGRATION_SENSITIVE_PATHS.some((pattern) => pattern.test(file)));
  const errors: string[] = [];
  if (declarations.length !== 1) {
    errors.push(`Exactly one migration declaration is required: ${MIGRATION_LABELS.join(", ")}`);
  }
  if (declarations[0] === "migration:none" && sensitiveFiles.length > 0 && !labels.includes("migration:none-reviewed")) {
    errors.push(
      `migration:none touches migration-sensitive paths and requires CODEOWNER confirmation via migration:none-reviewed: ${sensitiveFiles.join(", ")}`,
    );
  }
  return {
    ...(declarations[0] === undefined ? {} : { declaration: declarations[0] }),
    errors,
    sensitiveFiles,
  };
}

export function isCurrentReleaseCandidate(candidateSha: string, mainSha: string): boolean {
  return candidateSha.trim().toLowerCase() === mainSha.trim().toLowerCase();
}

export const DEPLOYMENT_POLL_INTERVAL_MS = 15 * 60_000;
export const DEPLOYMENT_NOTIFY_AFTER_MS = 60 * 60_000;
export const DEPLOYMENT_ESCALATE_AFTER_MS = 3 * 60 * 60_000;
export const DEPLOYMENT_TERMINATE_AFTER_MS = 6 * 60 * 60_000;

export type DrainAction = "complete" | "wait" | "notify" | "escalate" | "terminate";

export interface DrainEvaluationInput {
  startedAt: string;
  now: string;
  activeTunnelCount: number;
  lastNotificationAt?: string;
  extensionUntil?: string;
}

export interface DrainEvaluation {
  action: DrainAction;
  ageMs: number;
  nextPollAt?: string;
}

export function evaluateDeploymentDrain(input: DrainEvaluationInput): DrainEvaluation {
  const nowMs = Date.parse(input.now);
  const startedAtMs = Date.parse(input.startedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(startedAtMs) || nowMs < startedAtMs) {
    throw new Error("Deployment drain timestamps must be valid and monotonic");
  }
  if (!Number.isInteger(input.activeTunnelCount) || input.activeTunnelCount < 0) {
    throw new Error("activeTunnelCount must be a non-negative integer");
  }
  const ageMs = nowMs - startedAtMs;
  if (input.activeTunnelCount === 0) return { action: "complete", ageMs };
  const extensionUntilMs = input.extensionUntil === undefined ? undefined : Date.parse(input.extensionUntil);
  const extended = extensionUntilMs !== undefined && Number.isFinite(extensionUntilMs) && extensionUntilMs > nowMs;
  if (!extended && ageMs >= DEPLOYMENT_TERMINATE_AFTER_MS) return { action: "terminate", ageMs };

  const lastNotificationAtMs = input.lastNotificationAt === undefined ? undefined : Date.parse(input.lastNotificationAt);
  const notificationDue = lastNotificationAtMs === undefined || nowMs - lastNotificationAtMs >= DEPLOYMENT_NOTIFY_AFTER_MS;
  const action: DrainAction =
    ageMs >= DEPLOYMENT_ESCALATE_AFTER_MS && notificationDue
      ? "escalate"
      : ageMs >= DEPLOYMENT_NOTIFY_AFTER_MS && notificationDue
        ? "notify"
        : "wait";
  return { action, ageMs, nextPollAt: new Date(nowMs + DEPLOYMENT_POLL_INTERVAL_MS).toISOString() };
}
