import { once } from "node:events";
import { request as httpRequest, createServer, type IncomingHttpHeaders } from "node:http";
import { connect, createServer as createNetServer, isIP } from "node:net";
import { Schema } from "effect";
import { startStandaloneApplication, type ApplicationDependencies, type RunningApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  CreatedProfileSchema,
  IssuedAccessGrantSchema,
  ProfileResponseSchema,
  PublicAccessGrantSchema,
  PublicRouteSchema,
} from "../src/control-contract.js";
import { expectBufferChunk } from "../src/decoding.js";
import { basicAuth, closeServer, listen } from "../src/net-utils.js";
import { silentLogger, type Logger } from "../src/logger.js";
import type { RouteProfileInput } from "../src/types.js";
import { InMemoryRouteStore, InMemoryRouteStoreState } from "../src/in-memory-route-store.js";
import { proxyWithCredentials, readExactly } from "./proxy-client-support.js";

export interface TestTarget {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export interface TestApp {
  application: RunningApplication;
  storeState: InMemoryRouteStoreState;
  stop(): Promise<void>;
}

export interface CreatedRouteResponse {
  profile: typeof PublicRouteSchema.Type & { id: string };
  accessGrant: typeof PublicAccessGrantSchema.Type & { id: string; routeId: string };
  credential: typeof IssuedAccessGrantSchema.Type.credential & { id: string };
  proxyUsername: string;
  proxyUrls: { http: string; socks5: string };
}

export type IssuedAccessGrantApiResponse = typeof IssuedAccessGrantSchema.Type;

export function materializeIssuedAccessGrant(issued: IssuedAccessGrantApiResponse): Omit<CreatedRouteResponse, "profile"> {
  return {
    accessGrant: {
      ...issued.grant,
      id: issued.grant.grantId,
      routeId: issued.grant.profileId,
      credentials: [issued.credential],
    },
    credential: { ...issued.credential, id: issued.credential.credentialId },
    proxyUsername: issued.credential.username,
    proxyUrls: {
      http: proxyWithCredentials(issued.endpoints.http, issued.credential.username, issued.credential.password),
      socks5: proxyWithCredentials(issued.endpoints.socks5, issued.credential.username, issued.credential.password),
    },
  };
}

type TestProfileInput = Partial<RouteProfileInput> & {
  name?: string;
  targeting?: { country?: string; region?: string; city?: string; carrier?: string; postalCode?: string; asn?: number };
  rotation?: { mode: string; intervalSeconds?: number };
  session?: unknown;
  allowedProtocols?: unknown;
  retryPolicy?: unknown;
  sessionMode?: "managed" | "stateless";
  shouldRetry?: boolean;
};

function canonicalTestProfile(input: TestProfileInput): RouteProfileInput {
  const { targeting, sessionMode: _sessionMode, shouldRetry, session: _session, ...profile } = input;
  void _sessionMode;
  void _session;
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
    customerId: profile.customerId ?? "test-customer",
    ...(geography === undefined ? {} : { geography }),
    ...(carrier === undefined ? {} : { carrier }),
    ...(profile.providerOverride === undefined ? {} : { providerOverride: profile.providerOverride }),
    allowConnectionRetry: profile.allowConnectionRetry ?? shouldRetry ?? false,
  };
}

export async function startHttpTarget(
  options: {
    responseBody?: string | Buffer;
    onRequest?: () => void;
    onChunk?: (chunk: Buffer) => void;
    host?: "127.0.0.1" | "localhost";
  } = {},
): Promise<TestTarget> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      const buffer = expectBufferChunk(chunk);
      chunks.push(buffer);
      options.onChunk?.(buffer);
    });
    request.on("end", () => {
      options.onRequest?.();
      if (options.responseBody !== undefined) {
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": Buffer.byteLength(options.responseBody) });
        response.end(options.responseBody);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          body: "target-response",
          requestBody: Buffer.concat(chunks).toString("utf8"),
          authorization: request.headers.authorization,
        }),
      );
    });
  });
  const host = options.host ?? "127.0.0.1";
  const address = await listen(server, host, 0);
  return {
    url: `http://${host}:${address.port}/resource?secret=query-value`,
    port: address.port,
    stop: () => closeServer(server),
  };
}

export async function startEchoTarget(): Promise<TestTarget> {
  const server = createNetServer((socket) => socket.pipe(socket));
  const address = await listen(server, "127.0.0.1", 0);
  return {
    url: `127.0.0.1:${address.port}`,
    port: address.port,
    stop: () => closeServer(server),
  };
}

export async function startTestApp(
  allowedPorts: number[],
  existing?: { storeState: InMemoryRouteStoreState },
  logger: Logger = silentLogger,
  environment: NodeJS.ProcessEnv = {},
  dependencies: ApplicationDependencies = {},
): Promise<TestApp> {
  const storeState = existing?.storeState ?? new InMemoryRouteStoreState();
  const config = loadConfig({
    PROVIDER_MODE: "mock",
    FORWARD_PROXY_HOST: "127.0.0.1",
    FORWARD_PROXY_PORT: "0",
    SOCKS5_PROXY_HOST: "127.0.0.1",
    SOCKS5_PROXY_PORT: "0",
    CONTROL_API_HOST: "127.0.0.1",
    CONTROL_API_PORT: "0",
    CONTROL_API_TOKEN: "test-admin-token",
    ADVERTISED_PROXY_HOST: "127.0.0.1",
    ROUTE_TABLE_NAME: "unused-test-table",
    ALLOWED_TARGET_PORTS: allowedPorts.join(","),
    CONNECT_TIMEOUT_MS: "250",
    ...environment,
  });
  const application = await startStandaloneApplication(config, logger, {
    targetValidator: async () => undefined,
    storeFactory: () => new InMemoryRouteStore(storeState, dependencies.now),
    ...dependencies,
  });
  return {
    application,
    storeState,
    stop: () => application.stop(),
  };
}

export async function controlRequest(
  app: RunningApplication,
  path: string,
  init: RequestInit = {},
  authorized = true,
  bearerToken = "test-admin-token",
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (authorized && !headers.has("authorization")) headers.set("authorization", `Bearer ${bearerToken}`);
  return fetch(`http://127.0.0.1:${app.controlAddress.port}${path}`, {
    ...init,
    headers,
  });
}

export async function createRoute(
  app: RunningApplication,
  profile: TestProfileInput,
  explicitSessionMode?: "managed" | "stateless",
): Promise<CreatedRouteResponse> {
  const response = await controlRequest(app, "/v1/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(canonicalTestProfile(profile)),
  });
  if (response.status !== 201) throw new Error(`Route creation failed: ${response.status} ${await response.text()}`);
  const { profileId } = Schema.decodeUnknownSync(CreatedProfileSchema)(await response.json());
  const [profileResponse, grantResponse] = await Promise.all([
    controlRequest(app, `/v1/profiles/${profileId}`),
    controlRequest(app, `/v1/profiles/${profileId}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionMode: explicitSessionMode ?? profile.sessionMode ?? "stateless",
      }),
    }),
  ]);
  if (!profileResponse.ok || grantResponse.status !== 201) throw new Error("Profile setup failed");
  const publicProfile = Schema.decodeUnknownSync(ProfileResponseSchema)(await profileResponse.json()).profile;
  const issued = Schema.decodeUnknownSync(IssuedAccessGrantSchema)(await grantResponse.json());
  return {
    profile: { ...publicProfile, id: profileId },
    ...materializeIssuedAccessGrant(issued),
  };
}

export async function requestViaProxy(
  proxyUrl: string,
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const proxy = new URL(proxyUrl);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: proxy.hostname,
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
    request.on("error", reject);
    request.end(options.body);
  });
}

export async function exchangeViaHttpConnect(
  proxyUrl: string,
  targetAuthority: string,
  payload: string,
): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  const socket = connect(Number(proxy.port), proxy.hostname);
  try {
    await once(socket, "connect");
    socket.write(
      `CONNECT ${targetAuthority} HTTP/1.1\r\nHost: ${targetAuthority}\r\n` +
        `Proxy-Authorization: ${basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password))}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    while (buffer.indexOf("\r\n\r\n") < 0) {
      buffer = Buffer.concat([buffer, await readExactly(socket, 1)]);
    }
    const boundary = buffer.indexOf("\r\n\r\n");
    const header = buffer.subarray(0, boundary).toString("latin1");
    const status = Number(header.split(" ")[1] ?? 0);
    if (status !== 200 || payload === "") return { status, body: "" };
    socket.write(payload);
    return { status, body: (await readExactly(socket, Buffer.byteLength(payload))).toString("utf8") };
  } finally {
    socket.destroy();
  }
}

export async function exchangeViaSocks5(
  proxyUrl: string,
  targetHost: string,
  targetPort: number,
  payload: string,
  command = 0x01,
): Promise<{ replyCode: number; body: string }> {
  const proxy = new URL(proxyUrl);
  const socket = connect(Number(proxy.port), proxy.hostname);
  try {
    await once(socket, "connect");
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    assertBytes(await readExactly(socket, 2), [0x05, 0x02]);
    const username = Buffer.from(decodeURIComponent(proxy.username));
    const password = Buffer.from(decodeURIComponent(proxy.password));
    socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
    assertBytes(await readExactly(socket, 2), [0x01, 0x00]);
    const host = Buffer.from(targetHost);
    const address =
      isIP(targetHost) === 4
        ? Buffer.from([0x01, ...targetHost.split(".").map(Number)])
        : Buffer.concat([Buffer.from([0x03, host.length]), host]);
    const port = Buffer.alloc(2);
    port.writeUInt16BE(targetPort);
    socket.write(Buffer.concat([Buffer.from([0x05, command, 0x00]), address, port]));
    const reply = await readExactly(socket, 10);
    const replyCode = reply[1] ?? 0xff;
    if (replyCode !== 0x00 || payload === "") return { replyCode, body: "" };
    socket.write(payload);
    return { replyCode, body: (await readExactly(socket, Buffer.byteLength(payload))).toString("utf8") };
  } finally {
    socket.destroy();
  }
}

export async function socks5AuthenticationStatus(proxyUrl: string): Promise<number> {
  const proxy = new URL(proxyUrl);
  const socket = connect(Number(proxy.port), proxy.hostname);
  try {
    await once(socket, "connect");
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    assertBytes(await readExactly(socket, 2), [0x05, 0x02]);
    const username = Buffer.from(decodeURIComponent(proxy.username));
    const password = Buffer.from(decodeURIComponent(proxy.password));
    socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
    return (await readExactly(socket, 2))[1] ?? 0xff;
  } finally {
    socket.destroy();
  }
}

function assertBytes(actual: Buffer, expected: number[]): void {
  if (!actual.equals(Buffer.from(expected))) {
    throw new Error(`Unexpected SOCKS5 response: ${actual.toString("hex")}`);
  }
}

export async function waitForRouteStatus(app: RunningApplication, id: string, status: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await controlRequest(app, `/v1/profiles/${id}`);
    const body = Schema.decodeUnknownSync(ProfileResponseSchema)(await response.json());
    if (body.profile.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Route ${id} did not reach ${status}`);
}
