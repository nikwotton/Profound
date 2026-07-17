import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../config/provider-sources.json", import.meta.url), "utf8"));
const remote = process.argv.includes("--remote");
const errors = [];
for (const provider of manifest.providers) {
  const contract = JSON.parse(await readFile(new URL(`../${provider.contract}`, import.meta.url), "utf8"));
  if (contract.provider !== provider.id || typeof contract.version !== "string") {
    errors.push(`${provider.id}: pinned contract identity/version is invalid`);
  }
  if (!remote) continue;
  for (const source of provider.sources) {
    try {
      const response = await fetch(source, { method: "HEAD", redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const modified = response.headers.get("last-modified");
      if (modified && Date.parse(modified) > Date.parse(provider.reviewedAt)) {
        errors.push(`${provider.id}: ${source} was modified after ${provider.reviewedAt}`);
      }
    } catch (error) {
      errors.push(`${provider.id}: cannot verify ${source}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exit(1);
}
process.stdout.write(`Verified ${manifest.providers.length} pinned provider contracts${remote ? " and remote freshness metadata" : ""}.\n`);
