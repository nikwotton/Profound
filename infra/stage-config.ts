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
  readonly features: {
    readonly controlApiIdentities: boolean;
    readonly syntheticHealthRoute: boolean;
    readonly healthAlerting: boolean;
    readonly usageAccountingSource: boolean;
  };
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

export function resolveStageConfiguration(stage: string): StageConfiguration {
  const kind = classifyStage(stage);
  const production = kind === "production";
  const providerMode = production || stage === "staging" ? "live" : "mock";
  return {
    name: stage,
    kind,
    production,
    cloudTest: kind === "ci",
    developer: kind === "developer",
    protect: production,
    removal: production ? "retain" : "remove",
    providerMode,
    minimumTasks: production ? 2 : 1,
    maximumTasks: production ? 4 : 2,
    deployTransportTarget: kind === "ci",
    features: {
      controlApiIdentities: false,
      syntheticHealthRoute: false,
      healthAlerting: false,
      usageAccountingSource: false,
    },
  };
}
