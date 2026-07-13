import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { AuthenticationError, AppError, ProviderUnavailableError, errorMessage } from "./errors.js";
import type { Logger } from "./logger.js";
import { basicAuth, closeServer, listen, parseBasicAuth, parseHostPort } from "./net-utils.js";
import { RouteService } from "./route-service.js";
import { Telemetry } from "./telemetry.js";
import type { ListenAddress, StoredRoute, UpstreamEndpoint } from "./types.js";

export interface ForwardProxyOptions {
  host: string;
  port: number;
  allowedTargetPorts: Set<number>;
  connectTimeoutMs: number;
  logger: Logger;
  telemetry: Telemetry;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function forwardHeaders(headers: IncomingHttpHeaders, upstream: UpstreamEndpoint): IncomingHttpHeaders {
  const result = { ...headers };
  delete result["proxy-authorization"];
  delete result["proxy-connection"];
  delete result.connection;
  result["proxy-authorization"] = basicAuth(upstream.username, upstream.password);
  result.connection = "close";
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  delete result["proxy-authenticate"];
  delete result["proxy-authorization"];
  delete result["proxy-status"];
  delete result["proxy-connection"];
  delete result["keep-alive"];
  delete result["transfer-encoding"];
  result.connection = "close";
  return result;
}

export class ForwardProxyServer {
  readonly #server;
  #address?: ListenAddress;

  constructor(
    private readonly routes: RouteService,
    private readonly options: ForwardProxyOptions,
  ) {
    this.#server = createServer((request, response) => {
      void this.#handleRequest(request, response);
    });
    this.#server.on("connect", (request, clientSocket, head) => {
      void this.#handleConnect(request, clientSocket, head);
    });
    this.#server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
  }

  async start(): Promise<ListenAddress> {
    this.#address = await listen(this.#server, this.options.host, this.options.port);
    return this.#address;
  }

  address(): ListenAddress {
    if (this.#address === undefined) throw new Error("Forward proxy has not started");
    return this.#address;
  }

  async stop(): Promise<void> {
    await closeServer(this.#server);
  }

  #authenticate(request: IncomingMessage): StoredRoute {
    const credentials = parseBasicAuth(first(request.headers["proxy-authorization"]));
    if (credentials === undefined) throw new AuthenticationError();
    return this.routes.authenticate(credentials.username, credentials.password);
  }

  #checkPort(port: number): void {
    if (!this.options.allowedTargetPorts.has(port)) {
      throw new AppError("Target port is not allowed", "target_port_forbidden", 403);
    }
  }

  #sendError(response: ServerResponse, error: unknown): void {
    const appError = error instanceof AppError ? error : new AppError("Proxy request failed", "proxy_error", 502);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(appError.statusCode, {
      "content-type": "application/problem+json",
      ...(appError.statusCode === 407 ? { "proxy-authenticate": 'Basic realm="profound"' } : {}),
    });
    response.end(JSON.stringify({ code: appError.code, message: appError.message }));
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const span = this.options.telemetry.startSpan("proxy.http", {
      "proxy.protocol": "http",
      "http.request.method": request.method ?? "UNKNOWN",
    });
    response.once("finish", () => {
      const status = response.statusCode;
      this.options.telemetry.finishSpan(span, startedAt, {
        plane: "data",
        protocol: "http",
        "http.response.status_code": status,
      }, status >= 400 ? new Error(`HTTP ${status}`) : undefined);
    });
    try {
      const route = this.#authenticate(request);
      span.setAttributes({
        "proxy.route.id": route.id,
        "proxy.kind": route.kind,
        "proxy.provider": route.provider,
      });
      const target = new URL(request.url ?? "");
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new AppError("Absolute HTTP target URL required", "invalid_target", 400);
      }
      const port = target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);
      this.#checkPort(port);
      const upstream = await this.routes.resolve(route);
      const upstreamRequest = httpRequest({
        host: upstream.host,
        port: upstream.port,
        method: request.method,
        path: target.toString(),
        headers: forwardHeaders(request.headers, upstream),
      }, (upstreamResponse) => {
        const status = upstreamResponse.statusCode ?? 502;
        if (status === 407) {
          upstreamResponse.resume();
          this.#sendError(response, new AppError("Upstream provider authentication failed", "upstream_authentication_failed", 502));
          return;
        }
        if (status === 429) {
          upstreamResponse.resume();
          response.writeHead(503, {
            "content-type": "application/problem+json",
            ...(upstreamResponse.headers["retry-after"] === undefined
              ? {}
              : { "retry-after": upstreamResponse.headers["retry-after"] }),
          });
          response.end(JSON.stringify({ code: "provider_rate_limited", message: "Upstream provider rate limited the route" }));
          return;
        }
        if (status >= 500) {
          upstreamResponse.resume();
          this.#sendError(response, new AppError("Upstream provider request failed", "upstream_error", 502));
          return;
        }
        response.writeHead(status, responseHeaders(upstreamResponse.headers));
        upstreamResponse.pipe(response);
      });
      upstreamRequest.setTimeout(this.options.connectTimeoutMs, () => {
        upstreamRequest.destroy(new Error("Upstream proxy timed out"));
      });
      upstreamRequest.on("error", (error) => {
        this.options.logger.warn("Forward proxy upstream request failed", {
          routeId: route.id,
          provider: route.provider,
          target,
          error: error.message,
        });
        this.#sendError(response, new ProviderUnavailableError("Upstream provider connection failed"));
      });
      request.pipe(upstreamRequest);
    } catch (error) {
      this.#sendError(response, error);
    }
  }

  async #handleConnect(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    let route: StoredRoute | undefined;
    const startedAt = Date.now();
    const span = this.options.telemetry.startSpan("proxy.connect", {
      "proxy.protocol": "connect",
    });
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      this.options.telemetry.finishSpan(span, startedAt, {
        plane: "data",
        protocol: "connect",
        ...(route === undefined ? {} : {
          "proxy.kind": route.kind,
          "proxy.provider": route.provider,
        }),
      }, error);
    };
    try {
      route = this.#authenticate(request);
      const target = parseHostPort(request.url ?? "", 443);
      this.#checkPort(target.port);
      const upstream = await this.routes.resolve(route);
      await this.#openUpstreamTunnel(clientSocket, head, request.url ?? "", upstream);
      clientSocket.once("close", () => finish());
      this.options.logger.info("Proxy tunnel opened", {
        routeId: route.id,
        provider: route.provider,
        endpointId: upstream.endpointId,
        targetHost: target.host,
        targetPort: target.port,
      });
    } catch (error) {
      finish(error);
      const appError = error instanceof AppError ? error : new ProviderUnavailableError();
      const status = appError.statusCode === 407
        ? "407 Proxy Authentication Required"
        : appError.statusCode === 403
          ? "403 Forbidden"
          : "502 Bad Gateway";
      const authenticate = appError.statusCode === 407
        ? 'Proxy-Authenticate: Basic realm="profound"\r\n'
        : "";
      if (!clientSocket.destroyed) clientSocket.end(`HTTP/1.1 ${status}\r\n${authenticate}Connection: close\r\n\r\n`);
      this.options.logger.warn("Proxy tunnel failed", {
        ...(route === undefined ? {} : { routeId: route.id, provider: route.provider }),
        error: errorMessage(error),
      });
    }
  }

  async #openUpstreamTunnel(
    clientSocket: Duplex,
    clientHead: Buffer,
    authority: string,
    upstream: UpstreamEndpoint,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const upstreamSocket = connect(upstream.port, upstream.host);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => {
        upstreamSocket.destroy();
        reject(new ProviderUnavailableError("Upstream proxy timed out"));
      }, this.options.connectTimeoutMs);

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        upstreamSocket.destroy();
        reject(error);
      };

      upstreamSocket.once("error", () => fail(new ProviderUnavailableError("Upstream provider connection failed")));
      upstreamSocket.once("connect", () => {
        upstreamSocket.write(
          `CONNECT ${authority} HTTP/1.1\r\n` +
          `Host: ${authority}\r\n` +
          `Proxy-Authorization: ${basicAuth(upstream.username, upstream.password)}\r\n` +
          "Connection: keep-alive\r\n\r\n",
        );
      });
      upstreamSocket.on("data", function onData(chunk: Buffer) {
        if (settled) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 64 * 1024) {
          fail(new ProviderUnavailableError("Upstream proxy response headers were too large"));
          return;
        }
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        upstreamSocket.off("data", onData);
        const statusLine = buffer.subarray(0, boundary).toString("latin1").split("\r\n")[0] ?? "";
        const statusCode = Number(statusLine.split(" ")[1]);
        if (statusCode !== 200) {
          fail(new ProviderUnavailableError("Upstream provider rejected the tunnel"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remainder = buffer.subarray(boundary + 4);
        if (remainder.length > 0) clientSocket.write(remainder);
        if (clientHead.length > 0) upstreamSocket.write(clientHead);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
        resolve();
      });
    });
  }
}
