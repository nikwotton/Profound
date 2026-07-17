import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Logger } from "../logger.js";
import { basicAuth, closeServer, listen, parseBasicAuth, parseHostPort } from "../net-utils.js";
import type { ListenAddress } from "../types.js";

export type SimulatorFailure = "auth" | "unavailable" | "rate_limit" | "timeout" | null;

export interface MockIdentity {
  id: string;
  exitIp: string;
  country: string;
  region?: string;
  city?: string;
  carrier?: string;
  extraHeaders?: Record<string, string>;
}

export interface MockForwardProxyOptions {
  host: string;
  port: number;
  authorize(username: string, password: string): MockIdentity | undefined;
  failure(): SimulatorFailure;
  logger: Logger;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function copyHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  delete result["proxy-authorization"];
  delete result["proxy-connection"];
  delete result.connection;
  return result;
}

function copyResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  delete result.connection;
  delete result["keep-alive"];
  delete result["transfer-encoding"];
  result.connection = "close";
  return result;
}

function identityHeaders(identity: MockIdentity): Record<string, string> {
  return {
    "x-mock-endpoint-id": identity.id,
    "x-mock-exit-ip": identity.exitIp,
    "x-mock-country": identity.country,
    ...(identity.region === undefined ? {} : { "x-mock-region": identity.region }),
    ...(identity.city === undefined ? {} : { "x-mock-city": identity.city }),
    ...(identity.carrier === undefined ? {} : { "x-mock-carrier": identity.carrier }),
    ...identity.extraHeaders,
  };
}

function authenticate(request: IncomingMessage, options: MockForwardProxyOptions): MockIdentity | undefined {
  if (options.failure() === "auth") return undefined;
  const credentials = parseBasicAuth(first(request.headers["proxy-authorization"]));
  return credentials === undefined ? undefined : options.authorize(credentials.username, credentials.password);
}

function applyFailure(response: ServerResponse, failure: SimulatorFailure): boolean {
  if (failure === "timeout") return true;
  if (failure === "unavailable") {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("No peers available");
    return true;
  }
  if (failure === "rate_limit") {
    response.writeHead(429, { "content-type": "text/plain", "retry-after": "1" });
    response.end("Rate limited");
    return true;
  }
  return false;
}

export class MockForwardProxy {
  readonly #server;
  readonly #connections = new Set<Socket>();
  #address?: ListenAddress;

  constructor(private readonly options: MockForwardProxyOptions) {
    this.#server = createServer((request, response) => this.#handleRequest(request, response));
    this.#server.on("connection", (socket) => {
      this.#connections.add(socket);
      socket.once("close", () => this.#connections.delete(socket));
    });
    this.#server.on("connect", (request, clientSocket, head) => {
      this.#handleConnect(request, clientSocket, head);
    });
  }

  async start(): Promise<ListenAddress> {
    this.#address = await listen(this.#server, this.options.host, this.options.port);
    return this.#address;
  }

  address(): ListenAddress {
    if (this.#address === undefined) throw new Error("Mock forward proxy has not started");
    return this.#address;
  }

  async stop(): Promise<void> {
    for (const socket of this.#connections) socket.destroy();
    await closeServer(this.#server);
  }

  #handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const identity = authenticate(request, this.options);
    if (identity === undefined) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="mock-provider"' });
      response.end();
      return;
    }
    if (applyFailure(response, this.options.failure())) return;

    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Unsupported protocol");
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Absolute target URL required");
      return;
    }

    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = transport(
      target,
      {
        method: request.method,
        headers: copyHeaders(request.headers),
      },
      (upstreamResponse) => {
        const resolvedDestination = upstreamResponse.socket.remoteAddress;
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          ...copyResponseHeaders(upstreamResponse.headers),
          ...identityHeaders(identity),
          ...(resolvedDestination === undefined ? {} : { "x-mock-resolved-destination": resolvedDestination }),
          "x-mock-resolver-country": identity.country,
        });
        upstreamResponse.pipe(response);
      },
    );
    upstream.setTimeout(10_000, () => upstream.destroy(new Error("Target timed out")));
    upstream.on("error", (error) => {
      this.options.logger.warn("Mock provider target request failed", { error: error.message, target });
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end("Target request failed");
    });
    request.pipe(upstream);
  }

  #handleConnect(request: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const identity = authenticate(request, this.options);
    if (identity === undefined) {
      clientSocket.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="mock-provider"\r\n\r\n`);
      return;
    }
    const failure = this.options.failure();
    if (failure === "timeout") return;
    if (failure === "unavailable" || failure === "rate_limit") {
      const status = failure === "rate_limit" ? "429 Too Many Requests" : "502 Bad Gateway";
      clientSocket.end(`HTTP/1.1 ${status}\r\n\r\n`);
      return;
    }

    let target: { host: string; port: number };
    try {
      target = parseHostPort(request.url ?? "", 443);
    } catch {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const targetSocket = connect(target.port, target.host);
    this.#connections.add(targetSocket);
    const closeTarget = (): void => {
      targetSocket.destroy();
    };
    clientSocket.once("close", closeTarget);
    targetSocket.once("close", () => {
      this.#connections.delete(targetSocket);
      clientSocket.off("close", closeTarget);
    });
    targetSocket.setTimeout(10_000, () => targetSocket.destroy(new Error("Target timed out")));
    targetSocket.once("connect", () => {
      const resolvedDestination = targetSocket.remoteAddress;
      clientSocket.write(
        "HTTP/1.1 200 Connection Established\r\n" +
          (resolvedDestination === undefined ? "" : `X-Mock-Resolved-Destination: ${resolvedDestination}\r\n`) +
          `X-Mock-Resolver-Country: ${identity.country}\r\n` +
          "\r\n",
      );
      if (head.length > 0) targetSocket.write(head);
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });
    targetSocket.once("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    this.options.logger.info("Mock provider tunnel opened", {
      endpointId: identity.id,
      targetHost: target.host,
      targetPort: target.port,
    });
  }
}

export { basicAuth };
