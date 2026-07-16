import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { AddressNotFoundError, Reader, type ReaderModel } from "@maxmind/geoip2-node";
import { extract } from "tar";
import type { Logger } from "./logger.js";
import type { GeoIpDatasetMetadata, GeoIpLookupResult } from "./types.js";

const VENDOR = "MaxMind" as const;
const EDITION = "GeoLite2-City" as const;
const DEFAULT_DOWNLOAD_URL = "https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz";

export interface GeoIpResolver {
  lookup(ip: string): GeoIpLookupResult;
}

interface CityDatabase {
  city(ip: string): ReturnType<ReaderModel["city"]>;
}

type OpenDatabase = (path: string) => Promise<CityDatabase>;

interface DatasetSidecar {
  vendor: typeof VENDOR;
  edition: typeof EDITION;
  buildTimestamp: string;
}

export interface LocalGeoIpResolverOptions {
  databasePath: string;
  maximumAccuracyRadiusKm: number;
  openDatabase?: OpenDatabase;
}

function metadataPath(databasePath: string): string {
  return `${databasePath}.metadata.json`;
}

function validMetadata(value: unknown): value is DatasetSidecar {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<DatasetSidecar>;
  return candidate.vendor === VENDOR && candidate.edition === EDITION &&
    typeof candidate.buildTimestamp === "string" && Number.isFinite(Date.parse(candidate.buildTimestamp));
}

export class LocalGeoIpResolver implements GeoIpResolver {
  #reader: CityDatabase | undefined;
  #metadata: GeoIpDatasetMetadata | undefined;
  readonly #openDatabase: OpenDatabase;

  constructor(
    readonly options: LocalGeoIpResolverOptions,
    private readonly logger: Logger,
  ) {
    this.#openDatabase = options.openDatabase ?? ((path) => Reader.open(path));
  }

  get dataset(): GeoIpDatasetMetadata | undefined {
    return this.#metadata;
  }

  async load(): Promise<boolean> {
    if (!existsSync(this.options.databasePath)) return false;
    try {
      const [reader, fileStatus] = await Promise.all([
        this.#openDatabase(this.options.databasePath),
        stat(this.options.databasePath),
      ]);
      let metadata: GeoIpDatasetMetadata = {
        vendor: VENDOR,
        edition: EDITION,
        buildTimestamp: fileStatus.mtime.toISOString(),
      };
      try {
        const parsed: unknown = JSON.parse(await readFile(metadataPath(this.options.databasePath), "utf8"));
        if (validMetadata(parsed)) metadata = parsed;
      } catch {
        // A sidecar is optional. The MMDB mtime remains useful version evidence.
      }
      this.#reader = reader;
      this.#metadata = metadata;
      return true;
    } catch (error) {
      this.logger.warn("GeoIP dataset could not be loaded", {
        "event.name": "profound.geoip.load_failure",
        error: error instanceof Error ? error.message : "unknown",
      });
      return false;
    }
  }

  lookup(ip: string): GeoIpLookupResult {
    if (this.#reader === undefined || isIP(ip) === 0) return { geo: { status: "unavailable" } };
    try {
      const record = this.#reader.city(ip);
      const countryCode = record.country?.isoCode?.toUpperCase();
      const subdivisionCode = record.subdivisions?.at(-1)?.isoCode?.toUpperCase();
      const city = record.city?.names.en;
      const geonameId = record.city?.geonameId;
      const accuracyRadiusKm = record.location?.accuracyRadius;
      const lowConfidence = countryCode === undefined || city === undefined || accuracyRadiusKm === undefined ||
        accuracyRadiusKm > this.options.maximumAccuracyRadiusKm;
      return {
        geo: {
          status: lowConfidence ? "unverifiable" : "available",
          ...(countryCode === undefined ? {} : { countryCode }),
          ...(subdivisionCode === undefined ? {} : { subdivisionCode }),
          ...(city === undefined ? {} : { city }),
          ...(geonameId === undefined ? {} : { geonameId }),
          ...(accuracyRadiusKm === undefined ? {} : { accuracyRadiusKm }),
        },
        ...(this.#metadata === undefined ? {} : { geoDataset: this.#metadata }),
      };
    } catch (error) {
      if (error instanceof AddressNotFoundError) {
        return {
          geo: { status: "unverifiable" },
          ...(this.#metadata === undefined ? {} : { geoDataset: this.#metadata }),
        };
      }
      this.logger.warn("GeoIP lookup failed", {
        "event.name": "profound.geoip.lookup_failure",
        error: error instanceof Error ? error.message : "unknown",
      });
      return {
        geo: { status: "unavailable" },
        ...(this.#metadata === undefined ? {} : { geoDataset: this.#metadata }),
      };
    }
  }

  async activate(candidatePath: string, buildTimestamp: string): Promise<void> {
    const candidateReader = await this.#openDatabase(candidatePath);
    const metadata: DatasetSidecar = { vendor: VENDOR, edition: EDITION, buildTimestamp };
    const directory = dirname(this.options.databasePath);
    await mkdir(directory, { recursive: true });
    const temporaryMetadata = join(directory, `.${basename(this.options.databasePath)}.${process.pid}.metadata.tmp`);
    await writeFile(temporaryMetadata, JSON.stringify(metadata), { mode: 0o600 });
    try {
      await rename(candidatePath, this.options.databasePath);
      this.#reader = candidateReader;
      this.#metadata = metadata;
      try {
        await rename(temporaryMetadata, metadataPath(this.options.databasePath));
      } catch (error) {
        await rm(temporaryMetadata, { force: true });
        this.logger.warn("GeoIP metadata sidecar could not be updated", {
          "event.name": "profound.geoip.metadata_failure",
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    } catch (error) {
      await rm(temporaryMetadata, { force: true });
      throw error;
    }
  }
}

export interface MaxMindGeoLiteUpdaterOptions {
  accountId: string;
  licenseKey: string;
  intervalMs: number;
  requestTimeoutMs?: number;
  downloadUrl?: string;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}

export class MaxMindGeoLiteUpdater {
  #timer: NodeJS.Timeout | undefined;
  readonly #fetch: typeof fetch;

  constructor(
    private readonly resolver: LocalGeoIpResolver,
    private readonly options: MaxMindGeoLiteUpdaterOptions,
    private readonly logger: Logger,
  ) {
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async refresh(): Promise<"activated" | "current"> {
    const authorization = `Basic ${Buffer.from(`${this.options.accountId}:${this.options.licenseKey}`).toString("base64")}`;
    const url = this.options.downloadUrl ?? DEFAULT_DOWNLOAD_URL;
    const head = await this.#fetch(url, {
      method: "HEAD",
      headers: { authorization },
      redirect: "follow",
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 120_000),
    });
    if (!head.ok) throw new Error(`MaxMind update check returned HTTP ${head.status}`);
    const lastModified = head.headers.get("last-modified");
    const remoteBuild = lastModified === null || !Number.isFinite(Date.parse(lastModified))
      ? undefined
      : new Date(lastModified).toISOString();
    if (remoteBuild !== undefined && this.resolver.dataset !== undefined &&
      Date.parse(remoteBuild) <= Date.parse(this.resolver.dataset.buildTimestamp)) {
      return "current";
    }

    const response = await this.#fetch(url, {
      headers: { authorization },
      redirect: "follow",
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 120_000),
    });
    if (!response.ok || response.body === null) throw new Error(`MaxMind download returned HTTP ${response.status}`);
    const directory = await mkdtemp(join(tmpdir(), "profound-geoip-"));
    const archivePath = join(directory, "GeoLite2-City.tar.gz");
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath, { mode: 0o600 }));
      await extract({
        file: archivePath,
        cwd: directory,
        strict: true,
        preservePaths: false,
        filter: (path, entry) => !path.startsWith("/") && !path.split("/").includes("..") &&
          basename(path) === "GeoLite2-City.mmdb" &&
          ("type" in entry ? entry.type === "File" : entry.isFile()),
      });
      const candidate = await findDatabase(directory);
      if (candidate === undefined) throw new Error("MaxMind archive did not contain GeoLite2-City.mmdb");
      await this.resolver.activate(candidate, remoteBuild ?? new Date(this.options.now?.() ?? Date.now()).toISOString());
      this.logger.info("GeoIP dataset activated", {
        "event.name": "profound.geoip.dataset_activated",
        dataset: EDITION,
        buildTimestamp: this.resolver.dataset?.buildTimestamp,
      });
      return "activated";
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.refresh().catch((error) => {
        this.logger.warn("GeoIP dataset refresh failed", {
          "event.name": "profound.geoip.refresh_failure",
          error: error instanceof Error ? error.message : "unknown",
        });
      });
    }, this.options.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

async function findDatabase(directory: string): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === "GeoLite2-City.mmdb") return path;
    if (entry.isDirectory()) {
      const nested = await findDatabase(path);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}
