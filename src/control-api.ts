import { HttpApiBuilder, HttpApiSwagger, HttpServer } from "@effect/platform";
import { Redacted, Effect, Layer } from "effect";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AdminAuthorization,
  AuthenticatedUser,
  BadRequest,
  ControlApi,
  InternalError,
  RouteNotFound,
  ServiceUnavailable,
  Unauthorized,
} from "./control-contract.js";
import { AppError, NotFoundError, ProviderUnavailableError, ValidationError, safeErrorMessage } from "./errors.js";
import type { Logger } from "./logger.js";
import { closeServer, listen } from "./net-utils.js";
import { RouteService } from "./route-service.js";
import { Telemetry } from "./telemetry.js";
import type { ListenAddress } from "./types.js";

export interface ControlApiOptions {
  host: string;
  port: number;
  adminToken: string;
  adminUserId: string;
  controlIdentities: ReadonlyMap<string, string>;
  advertisedProxyHostFromRequest: boolean;
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

function authenticatedUser(token: string, identities: ReadonlyMap<string, string>): string | undefined {
  for (const [candidate, userId] of identities) {
    if (secureEqual(token, candidate)) return userId;
  }
  return undefined;
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
    bearer: (token) => {
      const userId = authenticatedUser(Redacted.value(token), options.controlIdentities);
      return userId === undefined
        ? Effect.fail(new Unauthorized({ code: "unauthorized", message: "Administrator bearer token required" }))
        : Effect.succeed({ userId });
    },
  });

  const HealthLive = HttpApiBuilder.group(ControlApi, "health", (handlers) =>
    handlers
      .handle("live", () => Effect.succeed({ status: "live" as const }).pipe(Effect.withSpan("control.health.live")))
      .handle("ready", () =>
        Effect.tryPromise({
          try: () => routes.ready(),
          catch: () => new ServiceUnavailable({ code: "not_ready", message: "Provider readiness check failed" }),
        }).pipe(
          Effect.flatMap((ready) =>
            ready
              ? Effect.succeed({ status: "ready" as const })
              : Effect.fail(new ServiceUnavailable({ code: "not_ready", message: "One or more providers are unavailable" })),
          ),
          Effect.withSpan("control.health.ready"),
        ),
      ),
  );

  const RoutesLive = HttpApiBuilder.group(ControlApi, "routes", (handlers) =>
    handlers
      .handle("createRoute", ({ payload }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.create(payload, identity.userId),
            catch: createError,
          }),
        ).pipe(Effect.withSpan("control.routes.create")),
      )
      .handle("listRoutes", () =>
        Effect.tryPromise({
          try: async () => ({ data: await routes.list() }),
          catch: internalError,
        }).pipe(Effect.withSpan("control.routes.list")),
      )
      .handle("getRoute", ({ path }) =>
        Effect.tryPromise({
          try: async () => ({ route: await routes.get(path.id) }),
          catch: readError,
        }).pipe(Effect.withSpan("control.routes.get", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("deleteRoute", ({ path }) =>
        Effect.tryPromise({
          try: () => routes.delete(path.id),
          catch: readError,
        }).pipe(Effect.withSpan("control.routes.delete", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("rotateRoute", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: async () => ({ route: await routes.rotate(path.id, identity.userId) }),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.routes.rotate", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("createAccessGrant", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.createAccessGrant(path.id, identity.userId),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.access_grants.create", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("listAccessGrants", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: async () => ({ data: await routes.listAccessGrants(path.id, identity.userId) }),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.access_grants.list", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("rotateAccessGrantCredential", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.rotateAccessGrantCredential(path.grantId, identity.userId),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.access_grants.rotate_credential", { attributes: { "proxy.access_grant.id": path.grantId } })),
      )
      .handle("emergencyRotateAccessGrantCredential", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.rotateAccessGrantCredential(path.grantId, identity.userId, true),
            catch: readError,
          }),
        ).pipe(
          Effect.withSpan("control.access_grants.emergency_rotate_credential", { attributes: { "proxy.access_grant.id": path.grantId } }),
        ),
      )
      .handle("revokeAccessGrant", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.revokeAccessGrant(path.grantId, identity.userId),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.access_grants.revoke", { attributes: { "proxy.access_grant.id": path.grantId } })),
      )
      .handle("releaseAccessGrantLease", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.releaseDeviceLease(path.grantId, identity.userId),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.access_grants.release_lease", { attributes: { "proxy.access_grant.id": path.grantId } })),
      )
      .handle("emergencyRevokeAccessGrant", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.revokeAccessGrant(path.grantId, identity.userId, true),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.access_grants.emergency_revoke", { attributes: { "proxy.access_grant.id": path.grantId } })),
      )
      .handle("emergencyRevokeRoute", ({ path }) =>
        Effect.tryPromise({
          try: () => routes.emergencyRevoke(path.id),
          catch: readError,
        }).pipe(Effect.withSpan("control.routes.emergency_revoke", { attributes: { "proxy.route.id": path.id } })),
      ),
  ).pipe(Layer.provide(AuthorizationLive));

  const ProvidersLive = HttpApiBuilder.group(ControlApi, "providers", (handlers) =>
    handlers
      .handle("providerDescriptors", () =>
        Effect.succeed({
          data: routes.descriptors().map((descriptor) => {
            const { clientProtocols, upstreamProtocols, geography, rotation, countries, targetPorts, ...capabilities } =
              descriptor.capabilities;
            return {
              ...descriptor,
              capabilities: {
                ...capabilities,
                clientProtocols: [...clientProtocols],
                upstreamProtocols: [...upstreamProtocols],
                geography: [...geography],
                rotation: [...rotation],
                targetPorts: targetPorts === "any_public" ? targetPorts : [...targetPorts],
                ...(countries === undefined ? {} : { countries: [...countries] }),
              },
            };
          }),
        }).pipe(Effect.withSpan("control.providers.descriptors")),
      )
      .handle("providerHealth", () =>
        Effect.tryPromise({
          try: async () => ({ data: await routes.refreshHealth() }),
          catch: internalError,
        }).pipe(Effect.withSpan("control.providers.health")),
      ),
  ).pipe(Layer.provide(AuthorizationLive));

  const ApiLive = HttpApiBuilder.api(ControlApi).pipe(Layer.provide([HealthLive, RoutesLive, ProvidersLive]));
  const DocumentationLive = Layer.mergeAll(
    HttpApiSwagger.layer({ path: "/docs" }),
    HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" }),
  ).pipe(Layer.provide(ApiLive));

  return HttpApiBuilder.toWebHandler(Layer.mergeAll(ApiLive, DocumentationLive, HttpServer.layerContext, options.telemetry.effectLayer));
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

function requestHostname(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

function rewriteCreatedRouteHost(body: Buffer, hostname: string): Buffer {
  const payload = JSON.parse(body.toString("utf8")) as {
    proxyUrls?: { http?: string; socks5?: string };
  };
  const rewrite = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const url = new URL(value);
    url.hostname = hostname;
    return url.toString();
  };
  if (payload.proxyUrls !== undefined) {
    const http = rewrite(payload.proxyUrls.http);
    const socks5 = rewrite(payload.proxyUrls.socks5);
    if (http !== undefined) payload.proxyUrls.http = http;
    if (socks5 !== undefined) payload.proxyUrls.socks5 = socks5;
  }
  return Buffer.from(JSON.stringify(payload));
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
      const webRequest = new Request(`http://${request.headers.host ?? "control.local"}${request.url ?? "/"}`, {
        method: request.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      });
      const webResponse = await this.#handler(webRequest);
      let responseBody: Buffer<ArrayBufferLike> = Buffer.from(await webResponse.arrayBuffer());
      const responseHeaders = Object.fromEntries(webResponse.headers.entries());
      if (
        this.options.advertisedProxyHostFromRequest &&
        request.method === "POST" &&
        (pathname === "/v1/routes" ||
          pathname.endsWith("/access-grants") ||
          pathname.endsWith("/credentials/rotate") ||
          pathname.endsWith("/credentials/emergency-rotate")) &&
        (webResponse.status === 200 || webResponse.status === 201)
      ) {
        const hostname = requestHostname(request.headers.host);
        if (hostname !== undefined) {
          responseBody = rewriteCreatedRouteHost(responseBody, hostname);
          delete responseHeaders["content-length"];
        }
      }
      response.writeHead(webResponse.status, webResponse.statusText, responseHeaders);
      response.end(responseBody);
      this.options.telemetry.finishSpan(
        span,
        startedAt,
        {
          plane: "control",
          "http.route": pathname,
          "http.response.status_code": webResponse.status,
        },
        webResponse.status >= 400 ? new Error(`HTTP ${webResponse.status}`) : undefined,
      );
    } catch (error) {
      this.options.logger.warn("Control API request failed", {
        method: request.method,
        path: pathname,
        error: safeErrorMessage(error),
      });
      const status = error instanceof AppError ? error.statusCode : 500;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: error instanceof AppError ? error.code : "internal_error", message: "Request failed" }));
      this.options.telemetry.finishSpan(
        span,
        startedAt,
        {
          plane: "control",
          "http.route": pathname,
          "http.response.status_code": status,
        },
        error,
      );
    }
  }
}
