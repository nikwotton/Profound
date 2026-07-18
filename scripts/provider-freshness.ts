import { readFile } from "node:fs/promises";
import { expectArray, expectRecord, expectString, parseJson } from "../src/decoding.js";

interface ProviderSource {
  contract: string;
  id: string;
  reviewedAt: string;
  sources: string[];
}

function decodeProviderSource(value: unknown, index: number): ProviderSource {
  const source = expectRecord(value, `provider source ${index}`);
  return {
    contract: expectString(source.contract, `provider source ${index}.contract`),
    id: expectString(source.id, `provider source ${index}.id`),
    reviewedAt: expectString(source.reviewedAt, `provider source ${index}.reviewedAt`),
    sources: expectArray(source.sources, `provider source ${index}.sources`).map((item, sourceIndex) =>
      expectString(item, `provider source ${index}.sources[${sourceIndex}]`),
    ),
  };
}

const rawManifest = expectRecord(
  parseJson(await readFile(new URL("../config/provider-sources.json", import.meta.url), "utf8"), "provider source manifest"),
  "provider source manifest",
);
const providers = expectArray(rawManifest.providers, "provider source manifest.providers").map(decodeProviderSource);
const remote = process.argv.includes("--remote");
const errors: string[] = [];
for (const provider of providers) {
  const contract = expectRecord(
    parseJson(await readFile(new URL(`../${provider.contract}`, import.meta.url), "utf8"), provider.contract),
    provider.contract,
  );
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
process.stdout.write(`Verified ${providers.length} pinned provider contracts${remote ? " and remote freshness metadata" : ""}.\n`);
