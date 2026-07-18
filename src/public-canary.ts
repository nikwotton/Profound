import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { expectBufferChunk } from "./decoding.js";
import { isCanaryChallenge, verifyCanaryChallenge } from "./canary-challenge.js";
import type { GeoIpResolver } from "./geoip.js";
import type { Logger } from "./logger.js";
import type { ListenAddress } from "./types.js";

export interface PublicCanaryOptions {
  host: string;
  port: number;
  signingSecret: string;
  trustedProxyCidrs: readonly string[];
  requestsPerMinute: number;
  maximumBodyBytes?: number;
  now?: () => number;
}

export interface PublicCanaryRequest {
  method: string;
  path: string;
  sourceIp: string;
  userAgent?: string;
  requestSize?: number;
  body: Buffer;
}

export interface PublicCanaryResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function normalizeIp(value: string | undefined): string {
  const candidate = (value ?? "unknown").trim().replace(/^::ffff:/, "");
  return isIP(candidate) === 0 ? "unknown" : candidate;
}

function trustedProxies(cidrs: readonly string[]): BlockList {
  const result = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefixText, ...extra] = cidr.trim().split("/");
    const familyNumber = isIP(address ?? "");
    const prefix = Number(prefixText);
    const maximum = familyNumber === 4 ? 32 : 128;
    if (extra.length > 0 || familyNumber === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error(`Invalid trusted proxy CIDR: ${cidr}`);
    }
    if (address === undefined) throw new Error(`Invalid trusted proxy CIDR: ${cidr}`);
    result.addSubnet(address, prefix, familyNumber === 4 ? "ipv4" : "ipv6");
  }
  return result;
}

function sourceIp(request: IncomingMessage, trusted: BlockList): string {
  const peer = normalizeIp(request.socket.remoteAddress);
  const family = isIP(peer);
  if (family !== 0 && trusted.check(peer, family === 4 ? "ipv4" : "ipv6")) {
    const forwarded = request.headers["x-forwarded-for"];
    const values = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)?.split(",") ?? [];
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const normalized = normalizeIp(values[index]);
      if (normalized !== "unknown") return normalized;
    }
  }
  return peer;
}

const unavailableGeoIpResolver: GeoIpResolver = { lookup: () => ({ geo: { status: "unavailable" } }) };

async function readBody(request: IncomingMessage, maximumBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = expectBufferChunk(chunk, "public-canary request chunk");
    size += buffer.length;
    if (size > maximumBodyBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function jsonResult(statusCode: number, body: unknown): PublicCanaryResponse {
  const encoded = JSON.stringify(body);
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(encoded)),
      "cache-control": "no-store",
    },
    body: encoded,
  };
}

export class PublicCanary {
  readonly #windows = new Map<string, { minute: number; count: number }>();
  readonly #usedChallenges = new Map<string, number>();
  #windowMinute = -1;

  constructor(
    private readonly options: Pick<PublicCanaryOptions, "signingSecret" | "requestsPerMinute" | "maximumBodyBytes" | "now">,
    private readonly logger: Logger,
    private readonly geoIpResolver: GeoIpResolver = unavailableGeoIpResolver,
  ) {}

  async handle(request: PublicCanaryRequest): Promise<PublicCanaryResponse> {
    const now = this.options.now?.() ?? Date.now();
    const ip = normalizeIp(request.sourceIp);
    const geoIp = this.geoIpResolver.lookup(ip);
    const path = new URL(request.path, "http://canary.invalid").pathname;
    const baseLog = {
      sourceIp: ip,
      timestamp: new Date(now).toISOString(),
      method: request.method,
      path,
      userAgent: request.userAgent ?? "unknown",
      requestSize: request.requestSize ?? request.body.length,
      derivedCountry: geoIp.geo.countryCode ?? "unknown",
      derivedSubdivision: geoIp.geo.subdivisionCode ?? "unknown",
      derivedCity: geoIp.geo.city ?? "unknown",
      derivedAsn: "unknown",
      geoStatus: geoIp.geo.status,
      geoDatasetBuildTimestamp: geoIp.geoDataset?.buildTimestamp ?? "unknown",
    };

    if (request.method === "GET" && path === "/health/live") return jsonResult(200, { status: "live" });
    if (request.method !== "POST" || path !== "/v1/challenge") {
      this.logger.warn("Canary request rejected", {
        ...baseLog,
        tokenValidation: "not_attempted",
        wafAction: "not_found",
      });
      return jsonResult(404, { error: "not_found" });
    }

    const minute = Math.floor(now / 60_000);
    if (minute !== this.#windowMinute) {
      this.#windowMinute = minute;
      this.#windows.clear();
      for (const [testId, expiresAt] of this.#usedChallenges) {
        if (expiresAt < now) this.#usedChallenges.delete(testId);
      }
    }
    const window = this.#windows.get(ip);
    const next = window?.minute === minute ? { minute, count: window.count + 1 } : { minute, count: 1 };
    this.#windows.set(ip, next);
    if (next.count > this.options.requestsPerMinute) {
      this.logger.warn("Canary request rate limited", {
        ...baseLog,
        tokenValidation: "not_attempted",
        rateLimitAction: "blocked",
      });
      return jsonResult(429, { error: "rate_limited" });
    }

    try {
      if (request.body.length > (this.options.maximumBodyBytes ?? 4_096)) throw new Error("request_too_large");
      const parsed: unknown = JSON.parse(request.body.toString("utf8"));
      const valid = isCanaryChallenge(parsed) && verifyCanaryChallenge(this.options.signingSecret, parsed, now);
      if (!valid) {
        this.logger.warn("Canary challenge rejected", {
          ...baseLog,
          requestSize: request.body.length,
          tokenValidation: "invalid",
        });
        return jsonResult(401, { error: "invalid_challenge" });
      }
      if (this.#usedChallenges.has(parsed.testId)) {
        this.logger.warn("Canary challenge replay rejected", {
          ...baseLog,
          requestSize: request.body.length,
          tokenValidation: "replayed",
          testId: parsed.testId,
        });
        return jsonResult(409, { error: "challenge_replayed" });
      }
      this.#usedChallenges.set(parsed.testId, Date.parse(parsed.expiresAt));
      this.logger.info("Canary challenge completed", {
        ...baseLog,
        requestSize: request.body.length,
        tokenValidation: "valid",
        testId: parsed.testId,
      });
      return jsonResult(200, {
        observedIp: ip,
        geo: geoIp.geo,
        ...(geoIp.geoDataset === undefined ? {} : { geoDataset: geoIp.geoDataset }),
        timestamp: new Date(now).toISOString(),
        correlationId: parsed.testId,
      });
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "request_too_large";
      this.logger.warn("Canary request rejected", {
        ...baseLog,
        tokenValidation: "invalid",
        wafAction: tooLarge ? "request_too_large" : "malformed_json",
      });
      return jsonResult(tooLarge ? 413 : 400, { error: tooLarge ? "request_too_large" : "invalid_request" });
    }
  }
}

export class PublicCanaryServer {
  #server: Server | undefined;
  readonly #trustedProxies: BlockList;
  readonly #canary: PublicCanary;

  constructor(
    private readonly options: PublicCanaryOptions,
    logger: Logger,
    geoIpResolver: GeoIpResolver = unavailableGeoIpResolver,
  ) {
    this.#trustedProxies = trustedProxies(options.trustedProxyCidrs);
    this.#canary = new PublicCanary(options, logger, geoIpResolver);
  }

  async start(): Promise<ListenAddress> {
    if (this.#server !== undefined) throw new Error("Public canary is already running");
    this.#server = createServer((request, response) => void this.#handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.options.port, this.options.host, () => resolve());
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("Public canary did not bind a TCP address");
    return { host: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://canary.invalid").pathname;
    let body: Buffer;
    try {
      body = await readBody(request, this.options.maximumBodyBytes ?? 4_096);
    } catch {
      body = Buffer.alloc((this.options.maximumBodyBytes ?? 4_096) + 1);
    }
    const userAgent = Array.isArray(request.headers["user-agent"])
      ? request.headers["user-agent"].join(",")
      : request.headers["user-agent"];
    const result = await this.#canary.handle({
      method: request.method ?? "UNKNOWN",
      path,
      sourceIp: sourceIp(request, this.#trustedProxies),
      ...(userAgent === undefined ? {} : { userAgent }),
      requestSize: Number(request.headers["content-length"] ?? body.length),
      body,
    });
    response.writeHead(result.statusCode, result.headers);
    response.end(result.body);
  }
}
