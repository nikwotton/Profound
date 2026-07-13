import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApplication, type RunningApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { basicAuth, closeServer, listen } from "../src/net-utils.js";
import { silentLogger } from "../src/logger.js";
import type { RouteProfileInput } from "../src/types.js";

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
  route: {
    id: string;
    endpointId?: string;
    status: string;
  };
  proxyUrl: string;
}

export async function startHttpTarget(): Promise<TestTarget> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ method: request.method, path: request.url, body: "target-response" }));
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
): Promise<TestApp> {
  const directory = existing?.directory ?? mkdtempSync(join(tmpdir(), "profound-test-"));
  const databasePath = existing?.databasePath ?? join(directory, "routes.db");
  const config = loadConfig({
    PROVIDER_MODE: "mock",
    FORWARD_PROXY_HOST: "127.0.0.1",
    FORWARD_PROXY_PORT: "0",
    CONTROL_API_HOST: "127.0.0.1",
    CONTROL_API_PORT: "0",
    CONTROL_API_TOKEN: "test-admin-token",
    ADVERTISED_PROXY_HOST: "127.0.0.1",
    SQLITE_PATH: databasePath,
    ALLOWED_TARGET_PORTS: allowedPorts.join(","),
    CONNECT_TIMEOUT_MS: "250",
  });
  const application = await startApplication(config, silentLogger);
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
): Promise<Response> {
  return fetch(`http://127.0.0.1:${app.controlAddress.port}${path}`, {
    ...init,
    headers: {
      ...(authorized ? { authorization: "Bearer test-admin-token" } : {}),
      ...init.headers,
    },
  });
}

export async function createRoute(
  app: RunningApplication,
  profile: RouteProfileInput,
): Promise<CreatedRouteResponse> {
  const response = await controlRequest(app, "/v1/routes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (response.status !== 201) throw new Error(`Route creation failed: ${response.status} ${await response.text()}`);
  return await response.json() as CreatedRouteResponse;
}

export async function requestViaProxy(
  proxyUrl: string,
  targetUrl: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const proxy = new URL(proxyUrl);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: "GET",
      path: targetUrl,
      headers: {
        "proxy-authorization": basicAuth(
          decodeURIComponent(proxy.username),
          decodeURIComponent(proxy.password),
        ),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

export async function waitForRouteStatus(
  app: RunningApplication,
  id: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await controlRequest(app, `/v1/routes/${id}`);
    const body = await response.json() as { route: { status: string } };
    if (body.route.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Route ${id} did not reach ${status}`);
}
