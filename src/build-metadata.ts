export function serviceVersion(environment: NodeJS.ProcessEnv = process.env): string {
  return environment["RELEASE_SHA"]?.trim() || "development";
}
