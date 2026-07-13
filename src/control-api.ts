import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpServer,
} from "@effect/platform";
import { Redacted, Effect, Layer } from "effect";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AdminAuthorization,
  BadRequest,
  ControlApi,
  InternalError,
  RouteNotFound,
  ServiceUnavailable,
  Unauthorized,
} from "./control-contract.js";
import { AppError, NotFoundError, ProviderUnavailableError, ValidationError, errorMessage } from "./errors.js";
import type { Logger } from "./logger.js";
import { closeServer, listen } from "./net-utils.js";
import { RouteService } from "./route-service.js";
import { Telemetry } from "./telemetry.js";
import type { ListenAddress } from "./types.js";

export interface ControlApiOptions {
  host: string;
  port: number;
  adminToken: string;
  logger: Logger;
  telemetry: Telemetry;
}

type RouteReadError = RouteNotFound | InternalError;
type RouteCreateError = BadRequest | ServiceUnavailable | InternalError;

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createError(error: unknown): RouteCreateError {
  if (error instanceof ValidationError) return new BadRequest({ code: error.code, message: error.message });
  if (error instanceof ProviderUnavailableError) {
    return new ServiceUnavailable({ code: error.code, message: error.message });
  }
  return new InternalError({ code: "internal_error", message: "Internal server error" });
}

function readError(error: unknown): RouteReadError {
  if (error instanceof NotFoundError) return new RouteNotFound({ code: error.code, message: error.message });
  return new InternalError({ code: "internal_error", message: "Internal server error" });
}

function internalError(_error: unknown): InternalError {
  return new InternalError({ code: "internal_error", message: "Internal server error" });
}

function makeHandler(routes: RouteService, options: ControlApiOptions) {
  const AuthorizationLive = Layer.succeed(AdminAuthorization, {
    bearer: (token) => secureEqual(Redacted.value(token), options.adminToken)
      ? Effect.void
      : Effect.fail(new Unauthorized({ code: "unauthorized", message: "Administrator bearer token required" })),
  });

  const HealthLive = HttpApiBuilder.group(ControlApi, "health", (handlers) => handlers
    .handle("live", () => Effect.succeed({ status: "live" as const }).pipe(Effect.withSpan("control.health.live")))
    .handle("ready", () => Effect.tryPromise({
      try: () => routes.ready(),
      catch: () => new ServiceUnavailable({ code: "not_ready", message: "Provider readiness check failed" }),
    }).pipe(
      Effect.flatMap((ready) => ready
        ? Effect.succeed({ status: "ready" as const })
        : Effect.fail(new ServiceUnavailable({ code: "not_ready", message: "One or more providers are unavailable" }))),
      Effect.withSpan("control.health.ready"),
    )));

  const RoutesLive = HttpApiBuilder.group(ControlApi, "routes", (handlers) => handlers
    .handle("createRoute", ({ payload }) => Effect.tryPromise({
      try: () => routes.create(payload),
      catch: createError,
    }).pipe(Effect.withSpan("control.routes.create")))
    .handle("listRoutes", () => Effect.succeed({ data: routes.list() }).pipe(Effect.withSpan("control.routes.list")))
    .handle("getRoute", ({ path }) => Effect.try({
      try: () => ({ route: routes.get(path.id) }),
      catch: readError,
    }).pipe(Effect.withSpan("control.routes.get", { attributes: { "proxy.route.id": path.id } })))
    .handle("deleteRoute", ({ path }) => Effect.try({
      try: () => routes.delete(path.id),
      catch: readError,
    }).pipe(Effect.withSpan("control.routes.delete", { attributes: { "proxy.route.id": path.id } })))
    .handle("rotateRoute", ({ path }) => Effect.try({
      try: () => ({ route: routes.rotate(path.id) }),
      catch: readError,
    }).pipe(Effect.withSpan("control.routes.rotate", { attributes: { "proxy.route.id": path.id } }))),
  ).pipe(Layer.provide(AuthorizationLive));

  const ProvidersLive = HttpApiBuilder.group(ControlApi, "providers", (handlers) => handlers
    .handle("providerHealth", () => Effect.tryPromise({
      try: async () => ({ data: await routes.refreshHealth() }),
      catch: internalError,
    }).pipe(Effect.withSpan("control.providers.health"))),
  ).pipe(Layer.provide(AuthorizationLive));

  const ApiLive = HttpApiBuilder.api(ControlApi).pipe(
    Layer.provide([HealthLive, RoutesLive, ProvidersLive]),
  );
  const DocumentationLive = Layer.mergeAll(
    HttpApiSwagger.layer({ path: "/docs" }),
    HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" }),
  ).pipe(Layer.provide(ApiLive));

  return HttpApiBuilder.toWebHandler(
    Layer.mergeAll(ApiLive, DocumentationLive, HttpServer.layerContext, options.telemetry.effectLayer),
  );
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "DELETE") return undefined;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 64 * 1024) throw new AppError("Request body exceeds 64 KiB", "payload_too_large", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class ControlApiServer {
  readonly #server;
  readonly #dispose;
  readonly #handler;
  #address?: ListenAddress;

  constructor(
    routes: RouteService,
    private readonly options: ControlApiOptions,
  ) {
    const webHandler = makeHandler(routes, options);
    this.#handler = webHandler.handler;
    this.#dispose = webHandler.dispose;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  async start(): Promise<ListenAddress> {
    this.#address = await listen(this.#server, this.options.host, this.options.port);
    return this.#address;
  }

  address(): ListenAddress {
    if (this.#address === undefined) throw new Error("Control API has not started");
    return this.#address;
  }

  async stop(): Promise<void> {
    await closeServer(this.#server);
    await this.#dispose();
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const pathname = new URL(request.url ?? "/", "http://control.local").pathname;
    const span = this.options.telemetry.startSpan("control.http", {
      "http.request.method": request.method ?? "UNKNOWN",
      "http.route": pathname,
    });
    try {
      const body = await readBody(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, value);
        }
      }
      const webRequest = new Request(
        `http://${request.headers.host ?? "control.local"}${request.url ?? "/"}`,
        {
          method: request.method ?? "GET",
          headers,
          ...(body === undefined ? {} : { body }),
        },
      );
      const webResponse = await this.#handler(webRequest);
      response.writeHead(webResponse.status, webResponse.statusText, Object.fromEntries(webResponse.headers.entries()));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
      this.options.telemetry.finishSpan(span, startedAt, {
        plane: "control",
        "http.route": pathname,
        "http.response.status_code": webResponse.status,
      }, webResponse.status >= 400 ? new Error(`HTTP ${webResponse.status}`) : undefined);
    } catch (error) {
      this.options.logger.warn("Control API request failed", {
        method: request.method,
        path: pathname,
        error: errorMessage(error),
      });
      const status = error instanceof AppError ? error.statusCode : 500;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: error instanceof AppError ? error.code : "internal_error", message: "Request failed" }));
      this.options.telemetry.finishSpan(span, startedAt, {
        plane: "control",
        "http.route": pathname,
        "http.response.status_code": status,
      }, error);
    }
  }
}
