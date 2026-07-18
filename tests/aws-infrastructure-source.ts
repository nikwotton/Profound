import { readFileSync } from "node:fs";

const awsInfrastructureModules = [
  "infra/providers/aws.ts",
  "infra/providers/aws-integration-targets.ts",
  "infra/providers/aws-operations-services.ts",
  "infra/providers/aws-secrets.ts",
  "infra/providers/aws-state.ts",
  "infra/providers/aws-telemetry-services.ts",
] as const;

export function awsInfrastructureSource(): string {
  return awsInfrastructureModules.map((path) => readFileSync(path, "utf8")).join("\n");
}
