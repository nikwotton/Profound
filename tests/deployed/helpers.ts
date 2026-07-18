import { execFile } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { promisify } from "node:util";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { test, type TestContext } from "node:test";
import { Schema } from "effect";
import { CreatedProfileSchema, IssuedAccessGrantSchema, ProfileResponseSchema, PublicRouteSchema } from "../../src/control-contract.js";
import { expectBufferChunk, parseJson } from "../../src/decoding.js";
import { basicAuth } from "../../src/net-utils.js";
import type { RouteProfileInput } from "../../src/types.js";

const execFileAsync = promisify(execFile);
export const deployedTestsEnabled = process.env["RUN_DEPLOYED_SST_TESTS"] === "1";

export interface ServiceMetadata {
  cluster: string;
  service: string;
  taskDefinition: string;
  taskRole: string;
  executionRole: string;
}

export interface DeployedMetadata {
  schemaVersion: 3;
  app: string;
  stage: string;
  deploymentProvider: "aws";
  region: string;
  providerMode: "mock" | "live";
  geoIpBundleConfigured: boolean;
  routeTable: string;
  compute: {
    orchestration: "ecs";
    launchType: "FARGATE";
    expansionPath: ["ECS_MANAGED_INSTANCES", "EC2"];
  };
  proxyTransport: {
    loadBalancer: "network";
    scheme: "internal";
    httpListenerIdleTimeoutSeconds: number;
    socks5ListenerIdleTimeoutSeconds: number;
    deregistrationDelaySeconds: number;
    connectionTerminationOnDeregistration: false;
  };
  telemetry: {
    backend: "axiom";
    endpoint: string;
    datasets: {
      logs: string;
      traces: string;
      metrics: string;
    };
    retentionDays: number;
  };
  httpProxy: string;
  socks5Proxy: string;
  controlApi: string;
  publicCanary: string;
  statusApplication: string;
  healthAggregator: string;
  productVpcId: string;
  canaryVpcId: string;
  services: {
    proxy: ServiceMetadata;
    controlPlane: ServiceMetadata;
    healthAggregator: ServiceMetadata;
    status: ServiceMetadata;
    notification: ServiceMetadata;
    telemetry: ServiceMetadata;
    canaryTelemetry: ServiceMetadata;
  };
  canary: {
    compute: "lambda";
    api: "api-gateway-v2";
    apiId: string;
    functionArn: string;
    geoIpPackaged: boolean;
  };
  integrationTarget: null | {
    url: string;
    compute: "lambda";
    api: "api-gateway-v2";
    apiId: string;
    functionArn: string;
    stateTable: string;
  };
  integrationTransportTarget: null | {
    url: string;
    compute: "ecs-fargate";
    cluster: string;
    service: string;
    taskDefinition: string;
  };
}

export interface DeployedEnvironment {
  stage: string;
  region: string;
  controlToken: string;
  healthAggregatorToken?: string;
  canarySigningSecret?: string;
  metadata: DeployedMetadata;
}

const optional = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });

const ServiceMetadataSchema: Schema.Schema<ServiceMetadata> = Schema.Struct({
  cluster: Schema.String,
  service: Schema.String,
  taskDefinition: Schema.String,
  taskRole: Schema.String,
  executionRole: Schema.String,
});

const DeployedMetadataSchema: Schema.Schema<DeployedMetadata> = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  app: Schema.String,
  stage: Schema.String,
  deploymentProvider: Schema.Literal("aws"),
  region: Schema.String,
  providerMode: Schema.Literal("mock", "live"),
  geoIpBundleConfigured: Schema.Boolean,
  routeTable: Schema.String,
  compute: Schema.Struct({
    orchestration: Schema.Literal("ecs"),
    launchType: Schema.Literal("FARGATE"),
    expansionPath: Schema.mutable(Schema.Tuple(Schema.Literal("ECS_MANAGED_INSTANCES"), Schema.Literal("EC2"))),
  }),
  proxyTransport: Schema.Struct({
    loadBalancer: Schema.Literal("network"),
    scheme: Schema.Literal("internal"),
    httpListenerIdleTimeoutSeconds: Schema.Number,
    socks5ListenerIdleTimeoutSeconds: Schema.Number,
    deregistrationDelaySeconds: Schema.Number,
    connectionTerminationOnDeregistration: Schema.Literal(false),
  }),
  telemetry: Schema.Struct({
    backend: Schema.Literal("axiom"),
    endpoint: Schema.String,
    datasets: Schema.Struct({ logs: Schema.String, traces: Schema.String, metrics: Schema.String }),
    retentionDays: Schema.Number,
  }),
  httpProxy: Schema.String,
  socks5Proxy: Schema.String,
  controlApi: Schema.String,
  publicCanary: Schema.String,
  statusApplication: Schema.String,
  healthAggregator: Schema.String,
  productVpcId: Schema.String,
  canaryVpcId: Schema.String,
  services: Schema.Struct({
    proxy: ServiceMetadataSchema,
    controlPlane: ServiceMetadataSchema,
    healthAggregator: ServiceMetadataSchema,
    status: ServiceMetadataSchema,
    notification: ServiceMetadataSchema,
    telemetry: ServiceMetadataSchema,
    canaryTelemetry: ServiceMetadataSchema,
  }),
  canary: Schema.Struct({
    compute: Schema.Literal("lambda"),
    api: Schema.Literal("api-gateway-v2"),
    apiId: Schema.String,
    functionArn: Schema.String,
    geoIpPackaged: Schema.Boolean,
  }),
  integrationTarget: Schema.NullOr(
    Schema.Struct({
      url: Schema.String,
      compute: Schema.Literal("lambda"),
      api: Schema.Literal("api-gateway-v2"),
      apiId: Schema.String,
      functionArn: Schema.String,
      stateTable: Schema.String,
    }),
  ),
  integrationTransportTarget: Schema.NullOr(
    Schema.Struct({
      url: Schema.String,
      compute: Schema.Literal("ecs-fargate"),
      cluster: Schema.String,
      service: Schema.String,
      taskDefinition: Schema.String,
    }),
  ),
});

export interface CreatedRouteResponse {
  profile: typeof PublicRouteSchema.Type & { id: string };
  accessGrant: typeof IssuedAccessGrantSchema.Type.grant & { id: string; routeId: string };
  credential: typeof IssuedAccessGrantSchema.Type.credential & { id: string };
  proxyUsername: string;
  proxyUrls: { http: string; socks5: string };
}

export type IssuedAccessGrantResponse = typeof IssuedAccessGrantSchema.Type;
export type PublicRoute = typeof PublicRouteSchema.Type;

type LegacyTestProfileInput = Partial<RouteProfileInput> & {
  name?: string;
  targeting?: { country?: string; region?: string; city?: string; carrier?: string; postalCode?: string; asn?: number };
  rotation?: { mode: string; intervalSeconds?: number };
  session?: unknown;
  allowedProtocols?: unknown;
  retryPolicy?: unknown;
  shouldRetry?: boolean;
};

function canonicalTestProfile(input: LegacyTestProfileInput): RouteProfileInput {
  const { targeting, shouldRetry, ...profile } = input;
  const carrier = profile.carrier ?? targeting?.carrier;
  const geography =
    targeting === undefined
      ? profile.geography
      : {
          ...(targeting.country === undefined ? {} : { countryCode: targeting.country }),
          ...(targeting.region === undefined ? {} : { regionCode: targeting.region }),
          ...(targeting.city === undefined ? {} : { city: targeting.city }),
        };
  return {
    customerId: profile.customerId ?? `deployed-test-${Date.now()}`,
    ...(geography === undefined ? {} : { geography }),
    ...(carrier === undefined ? {} : { carrier }),
    allowConnectionRetry: profile.allowConnectionRetry ?? shouldRetry ?? false,
  };
}

export interface ProxyResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function deployedTest(name: string, fn: (context: TestContext) => Promise<void> | void): void {
  test(name, { skip: !deployedTestsEnabled }, fn);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when RUN_DEPLOYED_SST_TESTS=1`);
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export async function awsJson<A, I>(args: string[], schema: Schema.Schema<A, I>, region = optionalEnvironment("AWS_REGION")): Promise<A> {
  const command = [...args, ...(region === undefined ? [] : ["--region", region]), "--output", "json"];
  try {
    const { stdout } = await execFileAsync("aws", command, {
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    return Schema.decodeUnknownSync(schema)(parseJson(stdout, `AWS CLI response for ${args.join(" ")}`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`AWS CLI failed: aws ${command.join(" ")}\n${detail}`);
  }
}

export async function axiomJson<A, I>(path: string, schema: Schema.Schema<A, I>, init: RequestInit = {}): Promise<A> {
  const token = requiredEnvironment("DEPLOYED_AXIOM_QUERY_TOKEN");
  const base = optionalEnvironment("DEPLOYED_AXIOM_API_URL") ?? "https://api.axiom.co";
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(new URL(path, `${base.replace(/\/$/, "")}/`), {
    ...init,
    headers,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Axiom API request failed: ${response.status} ${body}`);
  }
  return Schema.decodeUnknownSync(schema)(parseJson(body, `Axiom response for ${path}`));
}

export function axiomApl(apl: string, startTimeMs: number): Promise<unknown> {
  return axiomJson("v1/datasets/_apl?format=tabular", Schema.Unknown, {
    method: "POST",
    body: JSON.stringify({
      apl,
      startTime: new Date(startTimeMs).toISOString(),
      endTime: new Date().toISOString(),
    }),
  });
}

let environmentPromise: Promise<DeployedEnvironment> | undefined;

export function deployedEnvironment(): Promise<DeployedEnvironment> {
  environmentPromise ??= loadDeployedEnvironment();
  return environmentPromise;
}

async function loadDeployedEnvironment(): Promise<DeployedEnvironment> {
  const stage = requiredEnvironment("DEPLOYED_STAGE");
  const parameterName = optionalEnvironment("DEPLOYED_METADATA_PARAMETER") ?? `/sst/profound-proxy-router/${stage}/deployed-integration`;
  const parameter = await awsJson(
    ["ssm", "get-parameter", "--name", parameterName],
    Schema.Struct({ Parameter: optional(Schema.Struct({ Value: optional(Schema.String) })) }),
  );
  const value = parameter.Parameter?.Value;
  if (value === undefined) throw new Error(`SSM parameter ${parameterName} has no value`);
  const metadata = Schema.decodeUnknownSync(DeployedMetadataSchema)(parseJson(value, `SSM parameter ${parameterName}`));
  if (metadata.schemaVersion !== 3 || metadata.stage !== stage) {
    throw new Error(`SSM parameter ${parameterName} is not deployed-integration schema v3 for stage ${stage}`);
  }
  const healthAggregatorToken = optionalEnvironment("DEPLOYED_HEALTH_AGGREGATOR_TOKEN");
  const canarySigningSecret = optionalEnvironment("DEPLOYED_CANARY_SIGNING_SECRET");
  return {
    stage,
    region: optionalEnvironment("AWS_REGION") ?? metadata.region,
    controlToken: requiredEnvironment("DEPLOYED_CONTROL_API_TOKEN"),
    ...(healthAggregatorToken === undefined ? {} : { healthAggregatorToken }),
    ...(canarySigningSecret === undefined ? {} : { canarySigningSecret }),
    metadata,
  };
}

export async function controlRequest(path: string, init: RequestInit = {}, token?: string | null): Promise<Response> {
  const environment = await deployedEnvironment();
  const headers = new Headers(init.headers);
  if (token !== null && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token ?? environment.controlToken}`);
  }
  return fetch(new URL(path, `${environment.metadata.controlApi}/`), {
    ...init,
    headers,
  });
}

export async function createRoute(
  profile: LegacyTestProfileInput,
  sessionMode: "managed" | "none" = "none",
): Promise<CreatedRouteResponse> {
  const response = await controlRequest("/v1/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(canonicalTestProfile(profile)),
  });
  if (response.status !== 201) throw new Error(`Route creation failed: ${response.status} ${await response.text()}`);
  const { profileId } = Schema.decodeUnknownSync(CreatedProfileSchema)(await response.json());
  const [profileResponse, grantResponse] = await Promise.all([
    controlRequest(`/v1/profiles/${profileId}`),
    controlRequest(`/v1/profiles/${profileId}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionMode }),
    }),
  ]);
  if (!profileResponse.ok || grantResponse.status !== 201) throw new Error("Profile setup failed");
  const publicProfile = Schema.decodeUnknownSync(ProfileResponseSchema)(await profileResponse.json()).profile;
  const issued = Schema.decodeUnknownSync(IssuedAccessGrantSchema)(await grantResponse.json());
  return {
    profile: { ...publicProfile, id: profileId },
    accessGrant: {
      ...issued.grant,
      id: issued.grant.grantId,
      routeId: issued.grant.profileId,
    },
    credential: { ...issued.credential, id: issued.credential.credentialId },
    proxyUsername: issued.credential.username,
    proxyUrls: {
      http: proxyWithCredentials(issued.endpoints.http, issued.credential.username, issued.credential.password),
      socks5: proxyWithCredentials(issued.endpoints.socks5, issued.credential.username, issued.credential.password),
    },
  };
}

export async function revokeRoute(id: string): Promise<void> {
  const response = await controlRequest(`/v1/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (response.status !== 204 && response.status !== 200) {
    throw new Error(`Route revocation failed: ${response.status} ${await response.text()}`);
  }
}

export function proxyWithCredentials(proxyUrl: string, username: string, password: string): string {
  const url = new URL(proxyUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

export async function requestViaHttpProxy(
  proxyUrl: string,
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<ProxyResponse> {
  const proxy = new URL(proxyUrl);
  const transport = proxy.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const request = transport(
      {
        hostname: proxy.hostname,
        port: Number(proxy.port),
        method: options.method ?? "GET",
        path: targetUrl,
        headers: {
          "proxy-authorization": basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password)),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(expectBufferChunk(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

type ProxySocket = Socket | TLSSocket;

async function openProxySocket(proxy: URL): Promise<ProxySocket> {
  const port = Number(proxy.port);
  const socket =
    proxy.protocol === "https:"
      ? tlsConnect({ host: proxy.hostname, port, servername: proxy.hostname })
      : netConnect({ host: proxy.hostname, port });
  await once(socket, proxy.protocol === "https:" ? "secureConnect" : "connect");
  return socket;
}

async function readExactly(socket: ProxySocket, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = length;
  while (remaining > 0) {
    const value: unknown = socket.read(remaining);
    if (value !== null) {
      const chunk = expectBufferChunk(value, "deployed proxy response chunk");
      chunks.push(chunk);
      remaining -= chunk.length;
      continue;
    }
    if (socket.readableEnded || socket.destroyed) throw new Error("Socket closed before the expected bytes arrived");
    await once(socket, "readable");
  }
  return Buffer.concat(chunks, length);
}

async function readHeaders(socket: ProxySocket, maximumBytes = 64 * 1024): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void => fail(new Error("Socket closed while reading headers"));
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maximumBytes) {
        fail(new Error("Response headers exceed the integration-test limit"));
        return;
      }
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      cleanup();
      socket.pause();
      const remainder = buffer.subarray(boundary + 4);
      if (remainder.length > 0) socket.unshift(remainder);
      resolve(buffer.subarray(0, boundary).toString("latin1"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function connectViaHttpProxy(proxyUrl: string, target: URL): Promise<ProxySocket> {
  const proxy = new URL(proxyUrl);
  const socket = await openProxySocket(proxy);
  const authority = `${target.hostname}:${target.port || (target.protocol === "https:" ? "443" : "80")}`;
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
      `Proxy-Authorization: ${basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password))}\r\n\r\n`,
  );
  const headers = await readHeaders(socket);
  const status = Number(headers.split(" ")[1]);
  if (status !== 200) {
    socket.destroy();
    throw new Error(`CONNECT failed with status ${status}: ${headers.split("\r\n")[0]}`);
  }
  return socket;
}

export async function httpConnectStatus(proxyUrl: string, targetUrl: string): Promise<number> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  const socket = await openProxySocket(proxy);
  try {
    const authority = `${target.hostname}:${target.port || (target.protocol === "https:" ? "443" : "80")}`;
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
        `Proxy-Authorization: ${basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password))}\r\n\r\n`,
    );
    return Number((await readHeaders(socket)).split(" ")[1] ?? 0);
  } finally {
    socket.destroy();
  }
}

async function collectHttpResponse(socket: ProxySocket): Promise<ProxyResponse> {
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(expectBufferChunk(chunk));
  const response = Buffer.concat(chunks);
  const boundary = response.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("Target returned an invalid HTTP response");
  const header = response.subarray(0, boundary).toString("latin1");
  const headers: IncomingHttpHeaders = {};
  for (const line of header.split("\r\n").slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return {
    status: Number(header.split(" ")[1] ?? 0),
    headers,
    body: response.subarray(boundary + 4).toString("utf8"),
  };
}

export async function requestViaHttpConnect(
  proxyUrl: string,
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; rejectUnauthorized?: boolean } = {},
): Promise<ProxyResponse> {
  const target = new URL(targetUrl);
  const tunnel = await connectViaHttpProxy(proxyUrl, target);
  const socket: ProxySocket =
    target.protocol === "https:"
      ? tlsConnect({
          socket: tunnel,
          servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
          rejectUnauthorized: options.rejectUnauthorized ?? true,
        })
      : tunnel;
  if (target.protocol === "https:") await once(socket, "secureConnect");
  const body = options.body ?? "";
  const headers = {
    host: target.host,
    connection: "close",
    ...(body === "" ? {} : { "content-length": String(Buffer.byteLength(body)) }),
    ...options.headers,
  };
  socket.write(
    `${options.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1\r\n` +
      Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("") +
      `\r\n${body}`,
  );
  try {
    return await collectHttpResponse(socket);
  } finally {
    socket.destroy();
  }
}

async function connectViaSocks5(proxyUrl: string, target: URL, command = 0x01): Promise<{ socket: ProxySocket; reply: number }> {
  const proxy = new URL(proxyUrl);
  const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
  await once(socket, "connect");
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  const method = await readExactly(socket, 2);
  if (method[0] !== 0x05 || method[1] !== 0x02) throw new Error(`Unexpected SOCKS5 method reply ${method.toString("hex")}`);
  const username = Buffer.from(decodeURIComponent(proxy.username));
  const password = Buffer.from(decodeURIComponent(proxy.password));
  socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
  const authentication = await readExactly(socket, 2);
  if (authentication[1] !== 0x00) throw new Error(`SOCKS5 authentication failed with ${authentication[1]}`);
  const hostname = Buffer.from(target.hostname);
  const address =
    isIP(target.hostname) === 4
      ? Buffer.from([0x01, ...target.hostname.split(".").map(Number)])
      : Buffer.concat([Buffer.from([0x03, hostname.length]), hostname]);
  const port = Buffer.alloc(2);
  port.writeUInt16BE(Number(target.port || (target.protocol === "https:" ? 443 : 80)));
  socket.write(Buffer.concat([Buffer.from([0x05, command, 0x00]), address, port]));
  const reply = await readExactly(socket, 4);
  const addressType = reply[3];
  const addressLengthByte = addressType === 0x03 ? (await readExactly(socket, 1))[0] : undefined;
  const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : (addressLengthByte ?? 0);
  if (addressLength > 0) await readExactly(socket, addressLength + 2);
  return { socket, reply: reply[1] ?? 0xff };
}

export async function requestViaSocks5(
  proxyUrl: string,
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; rejectUnauthorized?: boolean } = {},
): Promise<ProxyResponse> {
  const target = new URL(targetUrl);
  const connected = await connectViaSocks5(proxyUrl, target);
  if (connected.reply !== 0x00) {
    connected.socket.destroy();
    throw new Error(`SOCKS5 CONNECT failed with reply ${connected.reply}`);
  }
  const socket: ProxySocket =
    target.protocol === "https:"
      ? tlsConnect({
          socket: connected.socket,
          servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
          rejectUnauthorized: options.rejectUnauthorized ?? true,
        })
      : connected.socket;
  if (target.protocol === "https:") await once(socket, "secureConnect");
  const body = options.body ?? "";
  const headers = {
    host: target.host,
    connection: "close",
    ...(body === "" ? {} : { "content-length": String(Buffer.byteLength(body)) }),
    ...options.headers,
  };
  socket.write(
    `${options.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1\r\n` +
      Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("") +
      `\r\n${body}`,
  );
  try {
    return await collectHttpResponse(socket);
  } finally {
    socket.destroy();
  }
}

export async function socks5CommandReply(proxyUrl: string, targetUrl: string, command: number): Promise<number> {
  const connected = await connectViaSocks5(proxyUrl, new URL(targetUrl), command);
  connected.socket.destroy();
  return connected.reply;
}

export async function waitFor<T>(
  description: string,
  operation: () => Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 2_000));
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

export async function waitForRouteStatus(id: string, expected: string): Promise<PublicRoute> {
  return await waitFor(
    `route ${id} to become ${expected}`,
    async () => {
      const response = await controlRequest(`/v1/profiles/${encodeURIComponent(id)}`);
      if (!response.ok) return undefined;
      const body = Schema.decodeUnknownSync(ProfileResponseSchema)(await response.json());
      return body.profile.status === expected ? body.profile : undefined;
    },
    { timeoutMs: 30_000, intervalMs: 250 },
  );
}
