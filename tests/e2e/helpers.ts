import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { test, type TestContext } from "node:test";
import { Schema } from "effect";
import {
  CreatedProfileSchema,
  IssuedAccessGrantSchema,
  ProfileResponseSchema,
  PublicAccessGrantSchema,
  PublicRouteSchema,
} from "../../src/control-contract.js";
import { expectBufferChunk } from "../../src/decoding.js";
import { basicAuth } from "../../src/net-utils.js";
import type { RouteProfileInput } from "../../src/types.js";
import {
  collectHttpResponse,
  openProxySocket,
  parsedHeaders,
  proxyWithCredentials,
  readExactly,
  readHeaders,
  type ProxyResponse,
  type ProxySocket,
} from "../proxy-client-support.js";

export { proxyWithCredentials } from "../proxy-client-support.js";
export type { ProxyResponse } from "../proxy-client-support.js";

export const e2eTestsEnabled = process.env["RUN_PROXY_E2E_TESTS"] === "1";

export type IssuedAccessGrantResponse = typeof IssuedAccessGrantSchema.Type;

export interface CreatedRouteResponse {
  profile: typeof PublicRouteSchema.Type;
  accessGrant: typeof PublicAccessGrantSchema.Type;
  credential: typeof IssuedAccessGrantSchema.Type.credential;
  proxyUsername: string;
  proxyUrls: { http: string; socks5: string };
}

export interface E2eEnvironment {
  controlApiUrl: string;
  controlApiToken: string;
  targetUrl: string;
  expectedTargetStatus: number;
}

function environmentValue(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (value === undefined) throw new Error(`${name} is required when RUN_PROXY_E2E_TESTS=1`);
  return value;
}

let cachedEnvironment: E2eEnvironment | undefined;

export function e2eEnvironment(): E2eEnvironment {
  if (cachedEnvironment !== undefined) return cachedEnvironment;
  const controlApiUrl = new URL(environmentValue("E2E_CONTROL_API_URL", "http://127.0.0.1:8081"));
  const targetUrl = new URL(environmentValue("E2E_TARGET_URL", "https://example.com/"));
  if (controlApiUrl.protocol !== "http:" && controlApiUrl.protocol !== "https:") {
    throw new Error("E2E_CONTROL_API_URL must use http or https");
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new Error("E2E_TARGET_URL must use http or https");
  }
  const expectedTargetStatus = Number(environmentValue("E2E_EXPECTED_TARGET_STATUS", "200"));
  if (!Number.isInteger(expectedTargetStatus) || expectedTargetStatus < 100 || expectedTargetStatus > 599) {
    throw new Error("E2E_EXPECTED_TARGET_STATUS must be an HTTP status code");
  }
  cachedEnvironment = {
    controlApiUrl: controlApiUrl.toString(),
    controlApiToken: environmentValue("E2E_CONTROL_API_TOKEN", "change-me"),
    targetUrl: targetUrl.toString(),
    expectedTargetStatus,
  };
  return cachedEnvironment;
}

export function e2eTest(name: string, fn: (context: TestContext) => Promise<void> | void): void {
  test(name, { skip: !e2eTestsEnabled }, fn);
}

export async function controlRequest(path: string, init: RequestInit = {}, token?: string | null): Promise<Response> {
  const environment = e2eEnvironment();
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token ?? environment.controlApiToken}`);
  return await fetch(new URL(path, environment.controlApiUrl), { ...init, headers });
}

export async function createRoute(profile: RouteProfileInput): Promise<CreatedRouteResponse> {
  const response = await controlRequest("/v1/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (response.status !== 201) throw new Error(`Profile creation failed: ${response.status} ${await response.text()}`);
  const { profileId } = Schema.decodeUnknownSync(CreatedProfileSchema)(await response.json());
  const [profileResponse, grantResponse] = await Promise.all([
    controlRequest(`/v1/profiles/${encodeURIComponent(profileId)}`),
    controlRequest(`/v1/profiles/${encodeURIComponent(profileId)}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionMode: "stateless" }),
    }),
  ]);
  if (!profileResponse.ok || grantResponse.status !== 201) {
    throw new Error(`Profile setup failed: profile=${profileResponse.status} grant=${grantResponse.status}`);
  }
  const publicProfile = Schema.decodeUnknownSync(ProfileResponseSchema)(await profileResponse.json()).profile;
  const issued = Schema.decodeUnknownSync(IssuedAccessGrantSchema)(await grantResponse.json());
  return {
    profile: publicProfile,
    accessGrant: { ...issued.grant, credentials: [issued.credential] },
    credential: issued.credential,
    proxyUsername: issued.credential.username,
    proxyUrls: {
      http: issuedProxyEndpoint(issued, "http"),
      socks5: issuedProxyEndpoint(issued, "socks5"),
    },
  };
}

export async function deleteProfile(id: string): Promise<Response> {
  return await controlRequest(`/v1/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function bestEffortDeleteProfile(id: string): Promise<void> {
  await deleteProfile(id).catch(() => undefined);
}

export function issuedProxyEndpoint(issued: IssuedAccessGrantResponse, protocol: "http" | "socks5"): string {
  return proxyWithCredentials(issued.endpoints[protocol], issued.credential.username, issued.credential.password);
}

async function requestThroughSocket(
  socket: ProxySocket,
  target: URL,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<ProxyResponse> {
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

export async function requestViaHttpProxy(
  proxyUrl: string,
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<ProxyResponse> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  if (target.protocol === "http:") {
    const transport = proxy.protocol === "https:" ? httpsRequest : httpRequest;
    return await new Promise((resolve, reject) => {
      const request = transport(
        {
          hostname: proxy.hostname,
          port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
          method: options.method ?? "GET",
          path: target.toString(),
          headers: {
            host: target.host,
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

  const tunnel = await openProxySocket(proxy);
  const authority = `${target.hostname}:${target.port || 443}`;
  tunnel.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
      `Proxy-Authorization: ${basicAuth(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password))}\r\n\r\n`,
  );
  const proxyHeaders = await readHeaders(tunnel);
  const proxyStatus = Number(proxyHeaders.split(" ")[1] ?? 0);
  if (proxyStatus !== 200) {
    tunnel.destroy();
    return { status: proxyStatus, headers: parsedHeaders(proxyHeaders), body: "" };
  }
  const socket = tlsConnect({
    socket: tunnel,
    servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
  });
  await once(socket, "secureConnect");
  return await requestThroughSocket(socket, target, options);
}

async function openSocks5Tunnel(proxyUrl: string, target: URL): Promise<{ socket: Socket; reply: number }> {
  const proxy = new URL(proxyUrl);
  const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
  await once(socket, "connect");
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  const method = await readExactly(socket, 2);
  if (method[0] !== 0x05 || method[1] !== 0x02) throw new Error(`Unexpected SOCKS5 method reply ${method.toString("hex")}`);
  const username = Buffer.from(decodeURIComponent(proxy.username));
  const password = Buffer.from(decodeURIComponent(proxy.password));
  if (username.length > 255 || password.length > 255) throw new Error("SOCKS5 credentials exceed the protocol limit");
  socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
  const authentication = await readExactly(socket, 2);
  if (authentication[1] !== 0x00) return { socket, reply: 0x01 };
  const hostname = Buffer.from(target.hostname);
  const address =
    isIP(target.hostname) === 4
      ? Buffer.from([0x01, ...target.hostname.split(".").map(Number)])
      : Buffer.concat([Buffer.from([0x03, hostname.length]), hostname]);
  const port = Buffer.alloc(2);
  port.writeUInt16BE(Number(target.port || (target.protocol === "https:" ? 443 : 80)));
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, port]));
  const reply = await readExactly(socket, 4);
  const addressType = reply.readUInt8(3);
  const addressLength =
    addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : addressType === 0x03 ? (await readExactly(socket, 1)).readUInt8(0) : 0;
  if (addressLength > 0) await readExactly(socket, addressLength + 2);
  return { socket, reply: reply[1] ?? 0xff };
}

export async function requestViaSocks5(
  proxyUrl: string,
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<ProxyResponse> {
  const target = new URL(targetUrl);
  const connected = await openSocks5Tunnel(proxyUrl, target);
  if (connected.reply !== 0x00) {
    connected.socket.destroy();
    return { status: connected.reply === 0x01 ? 407 : 502, headers: {}, body: "" };
  }
  const socket: ProxySocket =
    target.protocol === "https:"
      ? tlsConnect({ socket: connected.socket, servername: isIP(target.hostname) === 0 ? target.hostname : undefined })
      : connected.socket;
  if (target.protocol === "https:") await once(socket, "secureConnect");
  return await requestThroughSocket(socket, target, options);
}
