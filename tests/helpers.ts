import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { request as httpRequest, createServer, type IncomingHttpHeaders } from "node:http";
import { connect, createServer as createNetServer, isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApplication, type ApplicationDependencies, type RunningApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { expectBufferChunk } from "../src/decoding.js";
import { basicAuth, closeServer, listen } from "../src/net-utils.js";
import { silentLogger, type Logger } from "../src/logger.js";
import type { PublicAccessGrant, PublicAccessGrantCredential, PublicRoute, RouteProfileInput } from "../src/types.js";

export interface TestTarget {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export interface TestApp {
  application: RunningApplication;
  databasePath: string;
  directory: string;
  stop(remove?: boolean): Promise<void>;
}

export interface CreatedRouteResponse {
  profile: PublicRoute & { id: string };
  accessGrant: PublicAccessGrant & { id: string; routeId: string };
  credential: PublicAccessGrantCredential & { id: string };
  proxyUsername: string;
  proxyUrls: { http: string; socks5: string };
}

export interface IssuedAccessGrantApiResponse {
  grant: PublicAccessGrant;
  credential: PublicAccessGrantCredential & { password: string };
  endpoints: { http: string; socks5: string };
}

export function materializeIssuedAccessGrant(issued: IssuedAccessGrantApiResponse): Omit<CreatedRouteResponse, "profile"> {
  return {
    accessGrant: {
      ...issued.grant,
      id: issued.grant.grantId,
      routeId: issued.grant.profileId,
      credentials: issued.grant.credentials.map((credential) => ({ ...credential, id: credential.credentialId })),
    },
    credential: { ...issued.credential, id: issued.credential.credentialId },
    proxyUsername: issued.credential.username,
    proxyUrls: {
      http: authenticatedProxyUrl(issued.endpoints.http, issued.credential.username, issued.credential.password),
      socks5: authenticatedProxyUrl(issued.endpoints.socks5, issued.credential.username, issued.credential.password),
    },
  };
}

type LegacyTestProfileInput = Partial<RouteProfileInput> & {
  name?: string;
  targeting?: { country?: string; region?: string; city?: string; carrier?: string; postalCode?: string; asn?: number };
  rotation?: { mode: string; intervalSeconds?: number };
  session?: unknown;
  allowedProtocols?: unknown;
  retryPolicy?: unknown;
  isAuthenticated?: boolean;
  shouldRetry?: boolean;
};

function canonicalTestProfile(input: LegacyTestProfileInput): RouteProfileInput {
  const { targeting, isAuthenticated, shouldRetry, ...profile } = input;
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
    isTargetAuthenticated: profile.isTargetAuthenticated ?? isAuthenticated ?? false,
    allowConnectionRetry: profile.allowConnectionRetry ?? shouldRetry ?? false,
  };
}

function authenticatedProxyUrl(endpoint: string, username: string, password: string): string {
  const url = new URL(endpoint);
  url.username = username;
  url.password = password;
  return url.toString();
}

export async function startHttpTarget(): Promise<TestTarget> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(expectBufferChunk(chunk)));
    request.on("end", () => {
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
  const address = await listen(server, "127.0.0.1", 0);
  return {
    url: `http://127.0.0.1:${address.port}/resource?secret=query-value`,
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
  existing?: { databasePath: string; directory: string },
  logger: Logger = silentLogger,
  environment: NodeJS.ProcessEnv = {},
  dependencies: ApplicationDependencies = {},
): Promise<TestApp> {
  const directory = existing?.directory ?? mkdtempSync(join(tmpdir(), "profound-test-"));
  const databasePath = existing?.databasePath ?? join(directory, "routes.db");
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
    SQLITE_PATH: databasePath,
    ALLOWED_TARGET_PORTS: allowedPorts.join(","),
    CONNECT_TIMEOUT_MS: "250",
    ...environment,
  });
  const application = await startApplication(config, logger, {
    targetValidator: async () => undefined,
    ...dependencies,
  });
  return {
    application,
    databasePath,
    directory,
    stop: async (remove = true) => {
      await application.stop();
      if (remove) rmSync(directory, { recursive: true, force: true });
    },
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

export async function createRoute(app: RunningApplication, profile: LegacyTestProfileInput): Promise<CreatedRouteResponse> {
  const response = await controlRequest(app, "/v1/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(canonicalTestProfile(profile)),
  });
  if (response.status !== 201) throw new Error(`Route creation failed: ${response.status} ${await response.text()}`);
  const { profileId } = (await response.json()) as { profileId: string };
  const [profileResponse, grantResponse] = await Promise.all([
    controlRequest(app, `/v1/profiles/${profileId}`),
    controlRequest(app, `/v1/profiles/${profileId}/grants`, { method: "POST" }),
  ]);
  if (!profileResponse.ok || grantResponse.status !== 201) throw new Error("Profile setup failed");
  const publicProfile = ((await profileResponse.json()) as { profile: Record<string, unknown> }).profile;
  const issued = (await grantResponse.json()) as IssuedAccessGrantApiResponse;
  return {
    profile: { ...publicProfile, id: profileId } as CreatedRouteResponse["profile"],
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

async function readExactly(socket: Socket, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = length;
  while (remaining > 0) {
    const chunk = socket.read(remaining) as Buffer | null;
    if (chunk !== null) {
      chunks.push(chunk);
      remaining -= chunk.length;
    } else {
      if (socket.readableEnded || socket.destroyed) throw new Error("Socket ended before the expected response arrived");
      await Promise.race([
        once(socket, "readable"),
        once(socket, "end").then(() => {
          throw new Error("Socket ended before the expected response arrived");
        }),
        once(socket, "close").then(() => {
          throw new Error("Socket closed before the expected response arrived");
        }),
      ]);
    }
  }
  return Buffer.concat(chunks, length);
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
    const body = (await response.json()) as { profile: { status: string } };
    if (body.profile.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Route ${id} did not reach ${status}`);
}
