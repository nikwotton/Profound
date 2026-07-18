import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { signCanaryChallenge } from "./canary-challenge.js";
import { expectBufferChunk, expectEnum, expectNumber, expectOptionalString, expectRecord, expectString, parseJson } from "./decoding.js";
import type { SyntheticValidationScope } from "./health-aggregator.js";
import type { GeoIpDatasetMetadata, GeoIpEvidence, GeographyVerification, SyntheticValidationResult } from "./types.js";

export interface SignedCanaryProbeOptions {
  canaryUrl: string;
  signingSecret: string;
  proxyUrl?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  timeoutMs: number;
  now?: () => number;
}

interface CanaryResponse {
  observedIp: string;
  geo: GeoIpEvidence;
  geoDataset?: GeoIpDatasetMetadata;
  timestamp: string;
  correlationId: string;
}

function authorization(options: SignedCanaryProbeOptions): string | undefined {
  if (options.proxyUsername === undefined || options.proxyPassword === undefined) return undefined;
  return `Basic ${Buffer.from(`${options.proxyUsername}:${options.proxyPassword}`).toString("base64")}`;
}

async function responseBody(response: NodeJS.ReadableStream, statusCode: number | undefined): Promise<CanaryResponse> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(expectBufferChunk(chunk, "canary response chunk"));
  if (statusCode !== 200) throw new Error(`Canary returned HTTP ${statusCode ?? 0}`);
  const parsed = expectRecord(parseJson(Buffer.concat(chunks).toString("utf8"), "canary response"), "canary response");
  const rawGeo = expectRecord(parsed["geo"], "canary response.geo");
  const status = expectEnum(rawGeo["status"], ["available", "unverifiable", "unavailable"] as const, "canary response.geo.status");
  const geo: GeoIpEvidence = {
    status,
    ...(expectOptionalString(rawGeo["countryCode"], "canary response.geo.countryCode") === undefined
      ? {}
      : { countryCode: expectString(rawGeo["countryCode"], "canary response.geo.countryCode") }),
    ...(expectOptionalString(rawGeo["subdivisionCode"], "canary response.geo.subdivisionCode") === undefined
      ? {}
      : { subdivisionCode: expectString(rawGeo["subdivisionCode"], "canary response.geo.subdivisionCode") }),
    ...(expectOptionalString(rawGeo["city"], "canary response.geo.city") === undefined
      ? {}
      : { city: expectString(rawGeo["city"], "canary response.geo.city") }),
    ...(rawGeo["geonameId"] === undefined ? {} : { geonameId: expectNumber(rawGeo["geonameId"], "canary response.geo.geonameId") }),
    ...(rawGeo["accuracyRadiusKm"] === undefined
      ? {}
      : { accuracyRadiusKm: expectNumber(rawGeo["accuracyRadiusKm"], "canary response.geo.accuracyRadiusKm") }),
  };
  const rawGeoDataset = parsed["geoDataset"];
  const geoDataset: GeoIpDatasetMetadata | undefined =
    rawGeoDataset === undefined
      ? undefined
      : (() => {
          const dataset = expectRecord(rawGeoDataset, "canary response.geoDataset");
          return {
            vendor: expectString(dataset["vendor"], "canary response.geoDataset.vendor"),
            edition: expectString(dataset["edition"], "canary response.geoDataset.edition"),
            buildTimestamp: expectString(dataset["buildTimestamp"], "canary response.geoDataset.buildTimestamp"),
          };
        })();
  if (
    geo.status === "available" &&
    (geoDataset === undefined ||
      geoDataset.vendor.length === 0 ||
      geoDataset.edition.length === 0 ||
      !Number.isFinite(Date.parse(geoDataset.buildTimestamp)))
  ) {
    throw new Error("Canary GeoIP dataset metadata was malformed");
  }
  return {
    observedIp: expectString(parsed["observedIp"], "canary response.observedIp"),
    geo,
    ...(geoDataset === undefined ? {} : { geoDataset }),
    timestamp: expectString(parsed["timestamp"], "canary response.timestamp"),
    correlationId: expectString(parsed["correlationId"], "canary response.correlationId"),
  };
}

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim().toLocaleLowerCase("en-US");
  return result ? result : undefined;
}

function verifyGeography(scope: SyntheticValidationScope, response: CanaryResponse): GeographyVerification {
  if (response.geo.status !== "available") return "unverifiable";
  const countryMatches = scope.country === undefined || normalized(scope.country) === normalized(response.geo.countryCode);
  const cityMatches = scope.city === undefined || normalized(scope.city) === normalized(response.geo.city);
  return countryMatches && cityMatches ? "match" : "mismatch";
}

function directRequest(target: URL, body: Buffer, timeoutMs: number): Promise<CanaryResponse> {
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
        },
        timeout: timeoutMs,
      },
      (response) => void responseBody(response, response.statusCode).then(resolve, reject),
    );
    request.once("timeout", () => request.destroy(new Error("Canary request timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

function requestOverTunnel(target: URL, socket: Duplex, body: Buffer, timeoutMs: number): Promise<CanaryResponse> {
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          host: target.host,
          "content-type": "application/json",
          "content-length": body.length,
        },
        agent: false,
        createConnection: () => socket,
        timeout: timeoutMs,
      },
      (response) => void responseBody(response, response.statusCode).then(resolve, reject),
    );
    request.once("timeout", () => request.destroy(new Error("Canary tunnel request timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

function proxiedRequest(target: URL, proxy: URL, body: Buffer, options: SignedCanaryProbeOptions): Promise<CanaryResponse> {
  const send = proxy.protocol === "https:" ? httpsRequest : httpRequest;
  const proxyAuthorization = authorization(options);
  if (target.protocol === "http:") {
    return new Promise((resolve, reject) => {
      const request = send(
        {
          protocol: proxy.protocol,
          hostname: proxy.hostname,
          port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
          method: "POST",
          path: target.href,
          headers: {
            host: target.host,
            "content-type": "application/json",
            "content-length": body.length,
            ...(proxyAuthorization === undefined ? {} : { "proxy-authorization": proxyAuthorization }),
          },
          timeout: options.timeoutMs,
        },
        (response) => void responseBody(response, response.statusCode).then(resolve, reject),
      );
      request.once("timeout", () => request.destroy(new Error("Proxy canary request timed out")));
      request.once("error", reject);
      request.end(body);
    });
  }
  return new Promise((resolve, reject) => {
    const connect = send({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        host: `${target.hostname}:${target.port || 443}`,
        ...(proxyAuthorization === undefined ? {} : { "proxy-authorization": proxyAuthorization }),
      },
      timeout: options.timeoutMs,
    });
    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT returned HTTP ${response.statusCode ?? 0}`));
        return;
      }
      if (head.length > 0) socket.unshift(head);
      const secureSocket = tlsConnect({ socket, servername: target.hostname });
      secureSocket.once("secureConnect", () => {
        void requestOverTunnel(target, secureSocket, body, options.timeoutMs).then(resolve, reject);
      });
      secureSocket.once("error", reject);
    });
    connect.once("timeout", () => connect.destroy(new Error("Proxy CONNECT timed out")));
    connect.once("error", reject);
    connect.end();
  });
}

export class SignedCanaryProbe {
  constructor(private readonly options: SignedCanaryProbeOptions) {}

  async run(scope: SyntheticValidationScope): Promise<SyntheticValidationResult> {
    const target = new URL(this.options.canaryUrl);
    const now = this.options.now?.() ?? Date.now();
    const makeBody = (): { testId: string; body: Buffer } => {
      const testId = randomUUID();
      return {
        testId,
        body: Buffer.from(
          JSON.stringify(
            signCanaryChallenge(this.options.signingSecret, {
              testId,
              nonce: randomBytes(16).toString("base64url"),
              expiresAt: new Date((this.options.now?.() ?? Date.now()) + 60_000).toISOString(),
            }),
          ),
        ),
      };
    };
    if (this.options.proxyUrl === undefined) {
      return {
        testId: randomUUID(),
        outcome: "inconclusive",
        checkedAt: new Date(now).toISOString(),
        ...(scope.country === undefined ? {} : { expectedCountry: scope.country }),
        ...(scope.city === undefined ? {} : { expectedCity: scope.city }),
        geographyVerification: "unverifiable",
        message: "No synthetic proxy route is configured",
      };
    }
    const proxied = makeBody();
    try {
      const result = await proxiedRequest(target, new URL(this.options.proxyUrl), proxied.body, this.options);
      if (result.correlationId !== proxied.testId) throw new Error("Canary response correlation did not match the challenge");
      const geographyVerification = verifyGeography(scope, result);
      return {
        testId: proxied.testId,
        outcome: "success",
        checkedAt: result.timestamp,
        observedIp: result.observedIp,
        ...(scope.country === undefined ? {} : { expectedCountry: scope.country }),
        ...(scope.city === undefined ? {} : { expectedCity: scope.city }),
        ...(result.geo.countryCode === undefined ? {} : { country: result.geo.countryCode }),
        ...(result.geo.city === undefined ? {} : { city: result.geo.city }),
        geoStatus: result.geo.status,
        geographyVerification,
        ...(result.geoDataset === undefined ? {} : { geoDataset: result.geoDataset }),
        ...(geographyVerification === "match"
          ? {}
          : {
              message:
                geographyVerification === "mismatch"
                  ? "Observed GeoIP evidence did not match the requested geography"
                  : "Observed geography could not be verified",
            }),
      };
    } catch (proxyError) {
      const direct = makeBody();
      try {
        const result = await directRequest(target, direct.body, this.options.timeoutMs);
        if (result.correlationId !== direct.testId) throw new Error("Canary control correlation did not match the challenge");
        return {
          testId: proxied.testId,
          outcome: "proxy_failure",
          checkedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
          ...(scope.country === undefined ? {} : { expectedCountry: scope.country }),
          ...(scope.city === undefined ? {} : { expectedCity: scope.city }),
          geographyVerification: "unverifiable",
          message: proxyError instanceof Error ? proxyError.message : "Proxy path failed",
        };
      } catch {
        return {
          testId: proxied.testId,
          outcome: "inconclusive",
          checkedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
          ...(scope.country === undefined ? {} : { expectedCountry: scope.country }),
          ...(scope.city === undefined ? {} : { expectedCity: scope.city }),
          geographyVerification: "unverifiable",
          message: "Both proxy and direct canary requests failed",
        };
      }
    }
  }
}
