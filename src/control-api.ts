import { HttpApiBuilder, HttpApiSwagger, HttpServer } from "@effect/platform";
import { Redacted, Effect, Layer } from "effect";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expectBufferChunk, expectOptionalString, expectRecord, parseJson } from "./decoding.js";
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
type RouteUpdateError = RouteCreateError | RouteNotFound;
type AccessGrantCreateError = RouteReadError | ServiceUnavailable;

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
  if (error instanceof ValidationError) {
    return new BadRequest({ code: error.code, message: error.message, retryable: false, requestId: randomUUID() });
  }
  if (error instanceof AppError && error.statusCode === 503) {
    return new ServiceUnavailable({ code: error.code, message: error.message, retryable: true, requestId: randomUUID() });
  }
  return new InternalError({ code: "internal_error", message: "Internal server error", retryable: true, requestId: randomUUID() });
}

function readError(error: unknown): RouteReadError {
  if (error instanceof NotFoundError) {
    return new RouteNotFound({ code: error.code, message: error.message, retryable: false, requestId: randomUUID() });
  }
  return new InternalError({ code: "internal_error", message: "Internal server error", retryable: true, requestId: randomUUID() });
}

function updateError(error: unknown): RouteUpdateError {
  return error instanceof NotFoundError ? readError(error) : createError(error);
}

function accessGrantCreateError(error: unknown): AccessGrantCreateError {
  if (error instanceof NotFoundError) return readError(error);
  if (error instanceof ProviderUnavailableError) {
    return new ServiceUnavailable({ code: error.code, message: error.message, retryable: true, requestId: randomUUID() });
  }
  return internalError();
}

function internalError(): InternalError {
  return new InternalError({ code: "internal_error", message: "Internal server error", retryable: true, requestId: randomUUID() });
}

function makeHandler(routes: RouteService, options: ControlApiOptions) {
  const AuthorizationLive = Layer.succeed(AdminAuthorization, {
    bearer: (token) => {
      const userId = authenticatedUser(Redacted.value(token), options.controlIdentities);
      return userId === undefined
        ? Effect.fail(
            new Unauthorized({
              code: "unauthorized",
              message: "Administrator bearer token required",
              retryable: false,
              requestId: randomUUID(),
            }),
          )
        : Effect.succeed({ userId });
    },
  });

  const HealthLive = HttpApiBuilder.group(ControlApi, "health", (handlers) =>
    handlers
      .handle("live", () => Effect.succeed({ status: "live" as const }).pipe(Effect.withSpan("control.health.live")))
      .handle("ready", () =>
        Effect.tryPromise({
          try: () => routes.ready(),
          catch: () =>
            new ServiceUnavailable({
              code: "not_ready",
              message: "Service readiness check failed",
              retryable: true,
              requestId: randomUUID(),
            }),
        }).pipe(
          Effect.flatMap((ready) =>
            ready
              ? Effect.succeed({ status: "ready" as const })
              : Effect.fail(
                  new ServiceUnavailable({
                    code: "not_ready",
                    message: "The proxy service is not ready",
                    retryable: true,
                    requestId: randomUUID(),
                  }),
                ),
          ),
          Effect.withSpan("control.health.ready"),
        ),
      ),
  );

  const ProfilesLive = HttpApiBuilder.group(ControlApi, "profiles", (handlers) =>
    handlers
      .handle("createProfile", ({ payload }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: async () => ({ profileId: (await routes.create(payload, identity.userId)).profileId }),
            catch: createError,
          }),
        ).pipe(Effect.withSpan("control.profiles.create")),
      )
      .handle("listProfiles", () =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: async () => ({ data: await routes.list(identity.userId) }),
            catch: internalError,
          }),
        ).pipe(Effect.withSpan("control.profiles.list")),
      )
      .handle("getProfile", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: async () => ({ profile: await routes.get(path.id, identity.userId) }),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.profiles.get", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("updateProfile", ({ path, payload }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: async () => ({ profile: await routes.update(path.id, payload, identity.userId) }),
            catch: updateError,
          }),
        ).pipe(Effect.withSpan("control.profiles.update", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("deleteProfile", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.delete(path.id, identity.userId),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.profiles.delete", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("createAccessGrant", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.createAccessGrant(path.id, identity.userId),
            catch: accessGrantCreateError,
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
      .handle("getAccessGrant", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: async () => ({ grant: await routes.getAccessGrant(path.grantId, identity.userId) }),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.access_grants.get", { attributes: { "proxy.access_grant.id": path.grantId } })),
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
      .handle("getAccessGrantCredential", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: async () => ({
              credential: await routes.getAccessGrantCredential(path.grantId, path.credentialId, identity.userId),
            }),
            catch: readError,
          }),
        ).pipe(
          Effect.withSpan("control.access_grants.get_credential", {
            attributes: { "proxy.access_grant.id": path.grantId },
          }),
        ),
      )
      .handle("revokeAccessGrantCredential", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.revokeAccessGrantCredential(path.grantId, path.credentialId, identity.userId),
            catch: readError,
          }),
        ).pipe(
          Effect.withSpan("control.access_grants.revoke_credential", {
            attributes: { "proxy.access_grant.id": path.grantId },
          }),
        ),
      )
      .handle("revokeAccessGrant", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          Effect.tryPromise({
            try: () => routes.revokeAccessGrant(path.grantId, identity.userId),
            catch: readError,
          }),
        ).pipe(Effect.withSpan("control.access_grants.revoke", { attributes: { "proxy.access_grant.id": path.grantId } })),
      ),
  ).pipe(Layer.provide(AuthorizationLive));

  const ApiLive = HttpApiBuilder.api(ControlApi).pipe(Layer.provide([HealthLive, ProfilesLive]));
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
    const buffer = expectBufferChunk(chunk, "control API request chunk");
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

function rewriteIssuedCredentialHost(body: Buffer, hostname: string): Buffer {
  const payload = expectRecord(parseJson(body.toString("utf8"), "issued-credential response"), "issued-credential response");
  const rewrite = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const url = new URL(value);
    url.hostname = hostname;
    return url.toString();
  };
  if (payload.endpoints !== undefined) {
    const endpoints = expectRecord(payload.endpoints, "issued-credential response.endpoints");
    const http = rewrite(expectOptionalString(endpoints.http, "issued-credential response.endpoints.http"));
    const socks5 = rewrite(expectOptionalString(endpoints.socks5, "issued-credential response.endpoints.socks5"));
    if (http !== undefined) endpoints.http = http;
    if (socks5 !== undefined) endpoints.socks5 = socks5;
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
      let responseBody: Buffer = Buffer.from(await webResponse.arrayBuffer());
      const responseHeaders = Object.fromEntries(webResponse.headers.entries());
      if (
        this.options.advertisedProxyHostFromRequest &&
        request.method === "POST" &&
        (pathname === "/v1/profiles" ||
          pathname.endsWith("/grants") ||
          pathname.endsWith("/credentials/rotate") ||
          pathname.endsWith("/credentials/emergency-rotate")) &&
        (webResponse.status === 200 || webResponse.status === 201)
      ) {
        const hostname = requestHostname(request.headers.host);
        if (hostname !== undefined) {
          responseBody = rewriteIssuedCredentialHost(responseBody, hostname);
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
