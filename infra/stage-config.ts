export type StageKind = "production" | "shared" | "ci" | "developer";

export interface StageConfiguration {
  readonly name: string;
  readonly kind: StageKind;
  readonly production: boolean;
  readonly cloudTest: boolean;
  readonly developer: boolean;
  readonly protect: boolean;
  readonly removal: "retain" | "remove";
  readonly providerMode: "mock" | "live";
  readonly minimumTasks: number;
  readonly maximumTasks: number;
  readonly deployTransportTarget: boolean;
}

export function classifyStage(stage: string): StageKind {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(stage)) {
    throw new Error("SST stage names must be 1-32 lowercase letters, digits, or hyphens");
  }
  if (stage === "prod" || stage === "production") return "production";
  if (stage === "ci" || stage.startsWith("ci-")) return "ci";
  if (stage === "staging" || stage === "preview") return "shared";
  return "developer";
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function resolveStageConfiguration(stage: string, environment: Readonly<Record<string, string | undefined>>): StageConfiguration {
  const kind = classifyStage(stage);
  const production = kind === "production";
  const providerMode = environment.PROVIDER_MODE ?? (production ? "live" : "mock");
  if (providerMode !== "mock" && providerMode !== "live") throw new Error("PROVIDER_MODE must be mock or live");
  if (kind === "developer" && providerMode === "live") {
    throw new Error("Personal developer stages cannot use live provider credentials");
  }
  const minimumTasks = positiveInteger(environment.MIN_TASKS, production ? 2 : 1, "MIN_TASKS");
  const maximumTasks = positiveInteger(environment.MAX_TASKS, production ? 4 : 2, "MAX_TASKS");
  if (maximumTasks < minimumTasks) throw new Error("MAX_TASKS must be greater than or equal to MIN_TASKS");
  return {
    name: stage,
    kind,
    production,
    cloudTest: kind === "ci",
    developer: kind === "developer",
    protect: production,
    removal: production ? "retain" : "remove",
    providerMode,
    minimumTasks,
    maximumTasks,
    deployTransportTarget: kind === "ci",
  };
}
