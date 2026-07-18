import { HttpApiBuilder, HttpApiSwagger, HttpServer } from "@effect/platform";
import { Redacted, Effect, Layer } from "effect";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expectBufferChunk, expectOptionalString, expectRecord, parseJson } from "./decoding.js";
import { AdminAuthorization, type ApiError, AuthenticatedUser, ControlApi } from "./control-contract.js";
import { AppError, type RouteServiceError, safeErrorMessage } from "./errors.js";
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

type RouteReadError = ApiError;
type RouteCreateError = ApiError;
type RouteUpdateError = ApiError;
type AccessGrantCreateError = ApiError;

function unreachableRouteServiceError(error: never): never {
  void error;
  throw new Error("Unhandled route-service error");
}

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

function createError(error: RouteServiceError): RouteCreateError {
  switch (error.kind) {
    case "validation":
      return { code: error.code, message: error.message, retryable: false, requestId: randomUUID() };
    case "provider_unavailable":
    case "provider_authentication":
    case "provider_rate_limit":
    case "provider_protocol":
    case "provider_capacity_limit":
    case "provider_override_unsatisfied":
    case "upstream":
      return { code: error.code, message: error.message, retryable: error.retryable, requestId: randomUUID() };
    case "authentication":
    case "not_found":
    case "internal":
      return internalError();
    default:
      return unreachableRouteServiceError(error);
  }
}

function readError(error: RouteServiceError): RouteReadError {
  switch (error.kind) {
    case "not_found":
      return { code: error.code, message: error.message, retryable: false, requestId: randomUUID() };
    case "validation":
    case "authentication":
    case "provider_unavailable":
    case "provider_authentication":
    case "provider_rate_limit":
    case "provider_protocol":
    case "provider_capacity_limit":
    case "provider_override_unsatisfied":
    case "upstream":
    case "internal":
      return internalError();
    default:
      return unreachableRouteServiceError(error);
  }
}

function updateError(error: RouteServiceError): RouteUpdateError {
  return error.kind === "not_found" ? readError(error) : createError(error);
}

function accessGrantCreateError(error: RouteServiceError): AccessGrantCreateError {
  switch (error.kind) {
    case "not_found":
      return readError(error);
    case "provider_unavailable":
    case "provider_authentication":
    case "provider_rate_limit":
    case "provider_protocol":
    case "provider_capacity_limit":
    case "provider_override_unsatisfied":
    case "upstream":
      return { code: error.code, message: error.message, retryable: error.retryable, requestId: randomUUID() };
    case "validation":
      return { code: error.code, message: error.message, retryable: false, requestId: randomUUID() };
    case "authentication":
    case "internal":
      return internalError();
    default:
      return unreachableRouteServiceError(error);
  }
}

function internalError(): ApiError {
  return { code: "internal_error", message: "Internal server error", retryable: true, requestId: randomUUID() };
}

function makeHandler(routes: RouteService, options: ControlApiOptions) {
  const AuthorizationLive = Layer.succeed(AdminAuthorization, {
    bearer: (token) => {
      const userId = authenticatedUser(Redacted.value(token), options.controlIdentities);
      return userId === undefined
        ? Effect.fail({
            code: "unauthorized",
            message: "Control-plane bearer token required",
            retryable: false,
            requestId: randomUUID(),
          })
        : Effect.succeed({ userId });
    },
  });

  const HealthLive = HttpApiBuilder.group(ControlApi, "health", (handlers) =>
    handlers
      .handle("live", () => Effect.succeed({ status: "live" as const }).pipe(Effect.withSpan("control.health.live")))
      .handle("ready", () =>
        routes.effects.ready().pipe(
          Effect.mapError(() => ({
            code: "not_ready",
            message: "Service readiness check failed",
            retryable: true,
            requestId: randomUUID(),
          })),
          Effect.flatMap((ready) =>
            ready
              ? Effect.succeed({ status: "ready" as const })
              : Effect.fail({
                  code: "not_ready",
                  message: "The proxy service is not ready",
                  retryable: true,
                  requestId: randomUUID(),
                }),
          ),
          Effect.withSpan("control.health.ready"),
        ),
      ),
  );

  const ProfilesLive = HttpApiBuilder.group(ControlApi, "profiles", (handlers) =>
    handlers
      .handle("createProfile", ({ payload }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.create(payload, identity.userId).pipe(
            Effect.map((profile) => ({ profileId: profile.profileId })),
            Effect.mapError(createError),
          ),
        ).pipe(Effect.withSpan("control.profiles.create")),
      )
      .handle("listProfiles", () =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.list(identity.userId).pipe(
            Effect.map((data) => ({ data })),
            Effect.mapError(internalError),
          ),
        ).pipe(Effect.withSpan("control.profiles.list")),
      )
      .handle("getProfile", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.get(path.id, identity.userId).pipe(
            Effect.map((profile) => ({ profile })),
            Effect.mapError(readError),
          ),
        ).pipe(Effect.withSpan("control.profiles.get", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("updateProfile", ({ path, payload }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.update(path.id, payload, identity.userId).pipe(
            Effect.map((profile) => ({ profile })),
            Effect.mapError(updateError),
          ),
        ).pipe(Effect.withSpan("control.profiles.update", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("deleteProfile", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.delete(path.id, identity.userId).pipe(Effect.mapError(readError)),
        ).pipe(Effect.withSpan("control.profiles.delete", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("createAccessGrant", ({ path, payload }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.createAccessGrant(path.id, identity.userId, payload).pipe(Effect.mapError(accessGrantCreateError)),
        ).pipe(Effect.withSpan("control.access_grants.create", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("listAccessGrants", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.listAccessGrants(path.id, identity.userId).pipe(
            Effect.map((data) => ({ data })),
            Effect.mapError(readError),
          ),
        ).pipe(Effect.withSpan("control.access_grants.list", { attributes: { "proxy.route.id": path.id } })),
      )
      .handle("getAccessGrant", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.getAccessGrant(path.grantId, identity.userId).pipe(
            Effect.map((grant) => ({ grant })),
            Effect.mapError(readError),
          ),
        ).pipe(Effect.withSpan("control.access_grants.get", { attributes: { "proxy.access_grant.id": path.grantId } })),
      )
      .handle("rotateAccessGrantCredential", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.rotateAccessGrantCredential(path.grantId, path.credentialId, identity.userId).pipe(Effect.mapError(readError)),
        ).pipe(Effect.withSpan("control.access_grants.rotate_credential", { attributes: { "proxy.access_grant.id": path.grantId } })),
      )
      .handle("emergencyRotateAccessGrantCredential", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects
            .rotateAccessGrantCredential(path.grantId, path.credentialId, identity.userId, true)
            .pipe(Effect.mapError(readError)),
        ).pipe(
          Effect.withSpan("control.access_grants.emergency_rotate_credential", { attributes: { "proxy.access_grant.id": path.grantId } }),
        ),
      )
      .handle("createStatelessCredential", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.createStatelessCredential(path.grantId, identity.userId).pipe(Effect.mapError(accessGrantCreateError)),
        ),
      )
      .handle("createLogicalSession", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.createManagedSession(path.grantId, identity.userId).pipe(Effect.mapError(readError)),
        ),
      )
      .handle("listLogicalSessions", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.listLogicalSessions(path.grantId, identity.userId).pipe(
            Effect.map((data) => ({ data })),
            Effect.mapError(readError),
          ),
        ),
      )
      .handle("getLogicalSession", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.getLogicalSession(path.grantId, path.sessionId, identity.userId).pipe(
            Effect.map((session) => ({ session })),
            Effect.mapError(readError),
          ),
        ),
      )
      .handle("closeLogicalSession", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.closeLogicalSession(path.grantId, path.sessionId, identity.userId).pipe(Effect.mapError(readError)),
        ),
      )
      .handle("forceCloseLogicalSession", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.closeLogicalSession(path.grantId, path.sessionId, identity.userId, true).pipe(Effect.mapError(readError)),
        ),
      )
      .handle("getAccessGrantCredential", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.getAccessGrantCredential(path.grantId, path.credentialId, identity.userId).pipe(
            Effect.map((credential) => ({ credential })),
            Effect.mapError(readError),
          ),
        ).pipe(
          Effect.withSpan("control.access_grants.get_credential", {
            attributes: { "proxy.access_grant.id": path.grantId },
          }),
        ),
      )
      .handle("revokeAccessGrantCredential", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.revokeAccessGrantCredential(path.grantId, path.credentialId, identity.userId).pipe(Effect.mapError(readError)),
        ).pipe(
          Effect.withSpan("control.access_grants.revoke_credential", {
            attributes: { "proxy.access_grant.id": path.grantId },
          }),
        ),
      )
      .handle("revokeAccessGrant", ({ path }) =>
        Effect.flatMap(AuthenticatedUser, (identity) =>
          routes.effects.revokeAccessGrant(path.grantId, identity.userId).pipe(Effect.mapError(readError)),
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
  if (payload["endpoints"] !== undefined) {
    const endpoints = expectRecord(payload["endpoints"], "issued-credential response.endpoints");
    const http = rewrite(expectOptionalString(endpoints["http"], "issued-credential response.endpoints.http"));
    const socks5 = rewrite(expectOptionalString(endpoints["socks5"], "issued-credential response.endpoints.socks5"));
    if (http !== undefined) endpoints["http"] = http;
    if (socks5 !== undefined) endpoints["socks5"] = socks5;
  }
  return Buffer.from(JSON.stringify(payload));
}

function normalizeDecodeError(body: Buffer): Buffer {
  try {
    const payload = expectRecord(parseJson(body.toString("utf8"), "control API error response"), "control API error response");
    if (payload["_tag"] !== "HttpApiDecodeError") return body;
    return Buffer.from(
      JSON.stringify({
        code: "validation_error",
        message: "Request payload does not match the control API contract",
        retryable: false,
        requestId: randomUUID(),
      }),
    );
  } catch {
    return body;
  }
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
      if (webResponse.status === 400) {
        responseBody = normalizeDecodeError(responseBody);
        delete responseHeaders["content-length"];
      }
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
