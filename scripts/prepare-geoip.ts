import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { extract } from "tar";
import { expectOptionalString, expectRecord, parseJson } from "../src/decoding.js";

const accountId = process.env["MAXMIND_ACCOUNT_ID"]?.trim();
const licenseKey = process.env["MAXMIND_LICENSE_KEY"]?.trim();
if (!accountId || !licenseKey) {
  throw new Error("MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY are required");
}

const outputDirectory = resolve(process.env["GEOIP_BUNDLE_DIRECTORY"] ?? ".sst/geoip");
const databasePath = join(outputDirectory, "GeoLite2-City.mmdb");
const metadataPath = `${databasePath}.metadata.json`;
const downloadUrl = "https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz";
const authorization = `Basic ${Buffer.from(`${accountId}:${licenseKey}`).toString("base64")}`;

async function existingBuildTimestamp(): Promise<string | undefined> {
  try {
    const parsed = expectRecord(
      parseJson(await readFile(metadataPath, "utf8"), `GeoIP metadata ${metadataPath}`),
      `GeoIP metadata ${metadataPath}`,
    );
    return expectOptionalString(parsed["buildTimestamp"], "GeoIP metadata buildTimestamp");
  } catch {
    return undefined;
  }
}

async function findDatabase(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === "GeoLite2-City.mmdb") return path;
    if (entry.isDirectory()) {
      const nested = await findDatabase(path);
      if (nested) return nested;
    }
  }
  return undefined;
}

const head = await fetch(downloadUrl, {
  method: "HEAD",
  headers: { authorization },
  redirect: "follow",
  signal: AbortSignal.timeout(120_000),
});
if (!head.ok) throw new Error(`MaxMind update check returned HTTP ${head.status}`);
const remoteTimestampHeader = head.headers.get("last-modified");
const buildTimestamp =
  remoteTimestampHeader && Number.isFinite(Date.parse(remoteTimestampHeader))
    ? new Date(remoteTimestampHeader).toISOString()
    : new Date().toISOString();
const currentTimestamp = await existingBuildTimestamp();
if (currentTimestamp && Date.parse(currentTimestamp) >= Date.parse(buildTimestamp)) {
  console.log(JSON.stringify({ status: "current", databasePath, buildTimestamp: currentTimestamp }));
  process.exit(0);
}

const response = await fetch(downloadUrl, {
  headers: { authorization },
  redirect: "follow",
  signal: AbortSignal.timeout(120_000),
});
if (!response.ok || response.body === null) throw new Error(`MaxMind download returned HTTP ${response.status}`);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "profound-geoip-bundle-"));
try {
  const archivePath = join(temporaryDirectory, "GeoLite2-City.tar.gz");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath, { mode: 0o600 }));
  await extract({
    file: archivePath,
    cwd: temporaryDirectory,
    strict: true,
    preservePaths: false,
    filter: (path, entry) =>
      !path.startsWith("/") &&
      !path.split("/").includes("..") &&
      basename(path) === "GeoLite2-City.mmdb" &&
      ("type" in entry ? entry.type === "File" : entry.isFile()),
  });
  const source = await findDatabase(temporaryDirectory);
  if (!source) throw new Error("MaxMind archive did not contain GeoLite2-City.mmdb");
  await mkdir(outputDirectory, { recursive: true });
  const stagedDatabase = `${databasePath}.tmp`;
  const stagedMetadata = `${metadataPath}.tmp`;
  await copyFile(source, stagedDatabase);
  await writeFile(
    stagedMetadata,
    JSON.stringify({
      vendor: "MaxMind",
      edition: "GeoLite2-City",
      buildTimestamp,
    }),
    { mode: 0o600 },
  );
  await rename(stagedDatabase, databasePath);
  await rename(stagedMetadata, metadataPath);
  console.log(JSON.stringify({ status: "prepared", databasePath, buildTimestamp }));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
