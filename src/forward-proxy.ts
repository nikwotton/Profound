import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { assignmentAttributes, assignmentLogContext } from "./assignment-evidence.js";
import { assertSafeProviderResolution, recordDestinationResolution, resolvedAddressesFromHeader } from "./destination-resolution.js";
import { abortReason, beginAttemptBudget, operationDeadline } from "./establishment-budget.js";
import {
  AuthenticationError,
  AppError,
  ProviderUnavailableError,
  assignmentFromError,
  isRetryableUpstreamFailure,
  providerIdFromError,
} from "./errors.js";
import type { Logger } from "./logger.js";
import { basicAuth, closeServer, listen, parseBasicAuth, parseHostPort } from "./net-utils.js";
import { attemptUsageRecord } from "./proxy-attempt-accounting.js";
import { RouteService } from "./route-service.js";
import { sessionRoutingTelemetryAttributes } from "./routing-resolution.js";
import { routingScoreLogContext, routingScoreTelemetryAttributes } from "./routing-policy.js";
import type { TargetValidator } from "./target-security.js";
import { Telemetry } from "./telemetry.js";
import { establishTunnel } from "./tunnel-operation.js";
import { byteCounter } from "./stream-utils.js";
import { type AuthenticatedRoute, type UpstreamEndpoint } from "./domain/routing.js";
import { type ListenAddress } from "./domain/network.js";
import { type UsageOutcome } from "./domain/usage.js";

export interface ForwardProxyOptions {
  host: string;
  port: number;
  attemptEstablishmentTimeoutMs: number;
  operationEstablishmentTimeoutMs: number;
  streamIdleTimeoutMs: number;
  streamBufferBytes: number;
  maxHeaderBytes: number;
  targetValidator: TargetValidator;
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

function headerBytes(headers: IncomingHttpHeaders): number {
  return Object.entries(headers).reduce((total, [name, value]) => {
    if (value === undefined) return total;
    const values = Array.isArray(value) ? value : [value];
    return total + values.reduce((subtotal, item) => subtotal + Buffer.byteLength(`${name}: ${item}\r\n`), 0);
  }, 2);
}

function usageOutcome(value: string): UsageOutcome {
  if (value === "success" || value === "http_error" || value === "retry" || value === "failure") return value;
  return "failure";
}

function openProviderConnection(host: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onConnect = (): void => {
      settle(() => {
        socket.setNoDelay(true);
        resolve(socket);
      });
    };
    const onError = (error: Error): void => settle(() => reject(error));
    const onAbort = (): void => {
      const reason = abortReason(signal);
      const error = reason instanceof Error ? reason : new Error("Provider connection attempt was cancelled");
      settle(() => {
        socket.destroy(error);
        reject(error);
      });
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export class ForwardProxyServer {
  readonly #server;
  #address?: ListenAddress;

  constructor(
    private readonly routes: RouteService,
    private readonly options: ForwardProxyOptions,
  ) {
    this.#server = createServer({ maxHeaderSize: options.maxHeaderBytes }, (request, response) => {
      void this.#handleRequest(request, response);
    });
    // Header parsing has its own transport safeguard. Keep it long enough that
    // deliberately shorter candidate-attempt budgets do not close CONNECT
    // clients while the router is still selecting an upstream.
    this.#server.headersTimeout = Math.max(options.attemptEstablishmentTimeoutMs, 1_000);
    this.#server.requestTimeout = 0;
    this.#server.on("connect", (request, clientSocket, head) => void this.#handleConnect(request, clientSocket, head));
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

  async #authenticate(request: IncomingMessage): Promise<AuthenticatedRoute> {
    const credentials = parseBasicAuth(first(request.headers["proxy-authorization"]));
    if (credentials === undefined) throw new AuthenticationError();
    return this.routes.authenticate(credentials.username, credentials.password);
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
    const operationId = randomUUID();
    const startedAt = Date.now();
    const operationSpan = this.options.telemetry.startSpan("proxy.http", {
      "proxy.operation.id": operationId,
      "http.request.method": request.method ?? "UNKNOWN",
    });
    let route: AuthenticatedRoute | undefined;
    let finished = false;
    const establishmentDeadline = operationDeadline(startedAt, this.options.operationEstablishmentTimeoutMs);
    let initialBudget: ReturnType<typeof beginAttemptBudget> | undefined;
    const callerController = new AbortController();
    const cancel = (): void => {
      callerController.abort();
    };
    request.once("aborted", cancel);
    response.once("close", () => {
      if (!response.writableFinished) cancel();
    });
    const finishOperation = (outcome: "success" | "failure", error?: unknown): void => {
      if (finished) return;
      finished = true;
      this.options.telemetry.finishSpan(
        operationSpan,
        startedAt,
        {
          plane: "data",
          protocol: "http",
          outcome,
          ...(route === undefined
            ? {}
            : {
                "proxy.route.id": route.id,
                "proxy.access_grant.id": route.accessGrantId,
                "enduser.id": route.userId,
                "customer.id": route.customerId,
              }),
        },
        error,
      );
    };

    try {
      route = await this.#authenticate(request);
      this.routes.assertProtocolAllowed(route, "http");
      operationSpan.setAttributes({
        "proxy.route.id": route.id,
        "proxy.access_grant.id": route.accessGrantId,
        "enduser.id": route.userId,
        "customer.id": route.customerId,
      });
      const target = new URL(request.url ?? "");
      if (target.protocol !== "http:") {
        throw new AppError("Plain proxy requests require an absolute HTTP URL; use CONNECT for HTTPS", "invalid_target", 400);
      }
      if (target.username !== "" || target.password !== "") {
        throw new AppError("Target URLs must not contain credentials", "target_forbidden", 403);
      }
      const port = target.port === "" ? 80 : Number(target.port);
      initialBudget = beginAttemptBudget(establishmentDeadline, this.options.attemptEstablishmentTimeoutMs, callerController.signal);
      const targetValidation = await this.options.targetValidator(target.hostname, port, initialBudget.signal);
      const maxAttempts = route.shouldRetry ? route.retryPolicy.maxAttempts : 1;
      const resolutionState = this.routes.createResolutionState();

      const attempt = async (
        attemptIndex: number,
        budget = beginAttemptBudget(establishmentDeadline, this.options.attemptEstablishmentTimeoutMs, callerController.signal),
      ): Promise<void> => {
        const attemptId = randomUUID();
        const attemptStartedAt = Date.now();
        const attemptSpan = this.options.telemetry.startSpan("proxy.upstream_attempt", {
          "proxy.operation.id": operationId,
          "proxy.attempt.id": attemptId,
          "proxy.attempt.index": attemptIndex,
          "proxy.route.id": route?.id ?? "unknown",
          "proxy.access_grant.id": route?.accessGrantId ?? "unknown",
          "enduser.id": route?.userId ?? "unknown",
          "customer.id": route?.customerId ?? "unknown",
          "http.request.method": request.method ?? "UNKNOWN",
          "server.address": target.hostname,
        });
        let upstream: UpstreamEndpoint | undefined;
        let providerSocket: Socket | undefined;
        let bytesSent = 0;
        let bytesReceived = 0;
        let attemptFinished = false;
        let commitmentState: "pre_commit" | "committed" = "pre_commit";
        let stopTracking: (() => void) | undefined;
        const finishAttempt = (outcome: string, error?: unknown, status?: number): void => {
          if (attemptFinished) return;
          attemptFinished = true;
          stopTracking?.();
          const provider = upstream?.provider ?? providerIdFromError(error) ?? "unresolved";
          this.options.telemetry.finishAttempt(
            attemptSpan,
            attemptStartedAt,
            {
              provider,
              protocol: "http",
              outcome,
              "proxy.commitment_state": commitmentState,
              "proxy.failover":
                provider !== "unresolved" && resolutionState.primaryProvider !== undefined && provider !== resolutionState.primaryProvider,
              "proxy.bytes_sent": bytesSent,
              "proxy.bytes_received": bytesReceived,
              ...(status === undefined ? {} : { "http.response.status_code": status }),
            },
            error,
            route === undefined
              ? undefined
              : {
                  sessionMode: route.sessionMode,
                  ...(route.targeting.country === undefined ? {} : { country: route.targeting.country }),
                  ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
                },
          );
          this.options.logger.info("Upstream proxy attempt completed", {
            logicalOperationId: operationId,
            upstreamAttemptId: attemptId,
            routeId: route?.id,
            accessGrantId: route?.accessGrantId,
            userId: route?.userId,
            customerId: route?.customerId,
            jobId: route?.jobId,
            provider,
            endpointId: upstream?.endpointId,
            protocol: "http",
            outcome,
            commitmentState,
            retryIndex: attemptIndex,
            failover:
              provider !== "unresolved" && resolutionState.primaryProvider !== undefined && provider !== resolutionState.primaryProvider,
            latencyMs: Date.now() - attemptStartedAt,
            bytesSent,
            bytesReceived,
            ...(status === undefined ? {} : { status }),
          });
          if (route !== undefined) {
            const completedAt = new Date().toISOString();
            void this.routes
              .recordUsage(
                attemptUsageRecord(route, resolutionState, {
                  attemptId,
                  operationId,
                  protocol: "http",
                  outcome: usageOutcome(outcome),
                  attemptIndex,
                  attemptStartedAt,
                  completedAt,
                  provider,
                  bytesSent,
                  bytesReceived,
                  target: { host: target.hostname, port, path: target.pathname },
                  ...(upstream === undefined ? {} : { upstream }),
                }),
              )
              .catch((usageError: unknown) => this.options.logger.error("Usage record persistence failed", { error: usageError }));
          }
        };
        const retry = async (error?: unknown): Promise<void> => {
          if (upstream !== undefined) resolutionState.excludedCandidateIds.add(upstream.endpointId);
          budget.finish();
          finishAttempt("retry", error);
          await attempt(attemptIndex + 1);
        };

        try {
          if (route === undefined) throw new ProviderUnavailableError();
          upstream = await this.routes.resolve(route, "http", { host: target.hostname, port }, resolutionState, {
            logicalOperationId: operationId,
            signal: budget.signal,
          });
          const sessionAttributes = sessionRoutingTelemetryAttributes(resolutionState);
          if (Object.keys(sessionAttributes).length > 0) attemptSpan.addEvent("proxy.session.routing", sessionAttributes);
          attemptSpan.setAttributes({
            provider: upstream.provider,
            "proxy.endpoint.id": upstream.endpointId,
            ...assignmentAttributes(upstream.assignment),
            ...routingScoreTelemetryAttributes(upstream),
            ...(route.providerOverride === undefined ? {} : { "proxy.routing.provider_override": route.providerOverride }),
          });
          this.options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "selected", upstream.assignment);
          if (upstream.assignment.previousCandidateId !== undefined) {
            this.options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "changed", upstream.assignment);
          }
          if (upstream.assignment.expectedCity !== undefined) {
            this.options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "verification", upstream.assignment);
          }
          this.options.logger.info("Upstream candidate selected", {
            logicalOperationId: operationId,
            upstreamAttemptId: attemptId,
            routeId: route.id,
            accessGrantId: route.accessGrantId,
            provider: upstream.provider,
            ...(route.providerOverride === undefined ? {} : { providerOverride: route.providerOverride }),
            ...assignmentLogContext(upstream.assignment),
            ...routingScoreLogContext(upstream),
          });
          const connectedProviderSocket = await openProviderConnection(upstream.host, upstream.port, budget.signal);
          providerSocket = connectedProviderSocket;
          budget.finish();
          if (callerController.signal.aborted || response.destroyed) {
            providerSocket.destroy();
            throw new AppError("Caller disconnected during upstream establishment", "caller_cancelled", 499);
          }
          await this.routes.assertNewConnectionAllowed(route.id, route.accessGrantId, route.sessionId);
          const outboundHeaders = forwardHeaders(request.headers, upstream);
          const outboundHeaderBytes =
            Buffer.byteLength(`${request.method ?? "GET"} ${target.toString()} HTTP/1.1\r\n`) + headerBytes(outboundHeaders);
          const upstreamRequest = httpRequest(
            {
              host: upstream.host,
              port: upstream.port,
              method: request.method,
              path: target.toString(),
              headers: outboundHeaders,
              agent: false,
              createConnection: () => connectedProviderSocket,
            },
            (upstreamResponse) => {
              if (upstream !== undefined) void this.routes.recordCandidateSuccess(upstream).catch(() => undefined);
              const status = upstreamResponse.statusCode ?? 502;
              bytesReceived += Buffer.byteLength(`HTTP/1.1 ${status}\r\n`) + headerBytes(upstreamResponse.headers);
              const providerMetadata = (() => {
                const addresses = resolvedAddressesFromHeader(upstreamResponse.headers["x-mock-resolved-destination"]);
                const resolverCountry = first(upstreamResponse.headers["x-mock-resolver-country"]);
                return {
                  ...(addresses === undefined ? {} : { resolvedDestinationAddresses: addresses }),
                  ...(resolverCountry === undefined ? {} : { resolverCountry }),
                };
              })();
              recordDestinationResolution({
                validation: targetValidation,
                providerMetadata,
                expectedCountry: route?.targeting.country,
                logger: this.options.logger,
                span: attemptSpan,
                context: {
                  logicalOperationId: operationId,
                  upstreamAttemptId: attemptId,
                  routeId: route?.id,
                  accessGrantId: route?.accessGrantId,
                  provider: upstream?.provider,
                  dataPlaneProtocol: "http",
                  targetHost: target.hostname,
                  targetPort: port,
                },
              });
              try {
                assertSafeProviderResolution(providerMetadata);
              } catch (error) {
                upstreamResponse.resume();
                finishAttempt("failure", error, status);
                this.#sendError(response, error);
                finishOperation("failure", error);
                return;
              }
              const opaqueIpId = first(upstreamResponse.headers["x-brd-ip"]) ?? first(upstreamResponse.headers["x-mock-exit-ip"]);
              if (opaqueIpId !== undefined && upstream !== undefined) {
                upstream.assignment.opaqueIpId = opaqueIpId;
                this.options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "identity_observed", upstream.assignment);
                this.options.logger.info("Upstream candidate identity observed", {
                  logicalOperationId: operationId,
                  upstreamAttemptId: attemptId,
                  routeId: route?.id,
                  accessGrantId: route?.accessGrantId,
                  provider: upstream.provider,
                  ...assignmentLogContext(upstream.assignment),
                });
              }
              if (status === 407) {
                upstreamResponse.resume();
                const error = new AppError("Upstream provider authentication failed", "upstream_authentication_failed", 502);
                finishAttempt("failure", error, status);
                this.#sendError(response, error);
                finishOperation("failure", error);
                return;
              }
              response.writeHead(status, responseHeaders(upstreamResponse.headers));
              response.once("finish", () => {
                finishAttempt(status >= 500 ? "http_error" : "success", undefined, status);
                finishOperation("success");
              });
              response.once("close", () => {
                if (!response.writableFinished) {
                  const error = new ProviderUnavailableError("Caller response stream closed early");
                  upstreamResponse.destroy(error);
                  finishAttempt("failure", error, status);
                  finishOperation("failure", error);
                }
              });
              const responseStreamError = (error: Error): void => {
                finishAttempt("failure", error, status);
                if (response.headersSent) response.destroy(error);
                else this.#sendError(response, new ProviderUnavailableError("Upstream response stream closed early"));
                finishOperation("failure", error);
              };
              upstreamResponse.once("aborted", () =>
                responseStreamError(new ProviderUnavailableError("Upstream response stream closed early")),
              );
              upstreamResponse.once("error", responseStreamError);
              upstreamResponse
                .pipe(
                  byteCounter((bytes) => {
                    bytesReceived += bytes;
                  }, this.options.streamBufferBytes),
                )
                .pipe(response);
            },
          );
          stopTracking = await this.routes.trackActiveConnection(route.id, route.accessGrantId, route.sessionId, "http", upstream, () => {
            upstreamRequest.destroy(new AppError("Route was emergency-revoked", "route_emergency_revoked", 403));
            response.destroy();
          });
          const abortUpstream = (): void => {
            upstreamRequest.destroy(new AppError("Caller disconnected during proxy streaming", "caller_cancelled", 499));
          };
          callerController.signal.addEventListener("abort", abortUpstream, { once: true });
          upstreamRequest.setTimeout(this.options.streamIdleTimeoutMs, () => {
            upstreamRequest.destroy(new ProviderUnavailableError("Upstream proxy exceeded the stream idle timeout"));
          });
          upstreamRequest.once("error", (error) => {
            callerController.signal.removeEventListener("abort", abortUpstream);
            void (async () => {
              finishAttempt("failure", error);
              this.#sendError(response, new ProviderUnavailableError("Upstream provider connection failed"));
              finishOperation("failure", error);
            })();
          });
          commitmentState = "committed";
          attemptSpan.setAttribute("proxy.commitment_state", commitmentState);
          bytesSent += outboundHeaderBytes;
          request
            .pipe(
              byteCounter((bytes) => {
                bytesSent += bytes;
              }, this.options.streamBufferBytes),
            )
            .pipe(upstreamRequest);
        } catch (error) {
          budget.finish();
          providerSocket?.destroy();
          if (commitmentState === "pre_commit") await this.routes.recordCandidateFailure(upstream, error).catch(() => undefined);
          if (stopTracking === undefined) await this.routes.releaseCandidate(upstream).catch(() => undefined);
          const failedAssignment = assignmentFromError(error);
          if (failedAssignment !== undefined) {
            attemptSpan.setAttributes(assignmentAttributes(failedAssignment));
            this.options.telemetry.recordCandidateEvent(
              attemptSpan,
              providerIdFromError(error) ?? "unresolved",
              "verification",
              failedAssignment,
            );
            this.options.logger.warn("Upstream candidate verification failed", {
              logicalOperationId: operationId,
              upstreamAttemptId: attemptId,
              routeId: route?.id,
              accessGrantId: route?.accessGrantId,
              provider: providerIdFromError(error),
              ...assignmentLogContext(failedAssignment),
            });
          }
          if (
            attemptIndex + 1 < maxAttempts &&
            !response.headersSent &&
            !callerController.signal.aborted &&
            commitmentState === "pre_commit" &&
            isRetryableUpstreamFailure(error)
          ) {
            await retry(error);
            return;
          }
          finishAttempt("failure", error);
          this.#sendError(response, error);
          finishOperation("failure", error);
        }
      };
      await attempt(0, initialBudget);
    } catch (error) {
      initialBudget?.finish();
      this.#sendError(response, error);
      finishOperation("failure", error);
    }
  }

  async #handleConnect(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    const operationId = randomUUID();
    const startedAt = Date.now();
    const operationSpan = this.options.telemetry.startSpan("proxy.connect", { "proxy.operation.id": operationId });
    let route: AuthenticatedRoute | undefined;
    let operationFinished = false;
    const establishmentDeadline = operationDeadline(startedAt, this.options.operationEstablishmentTimeoutMs);
    let initialBudget: ReturnType<typeof beginAttemptBudget> | undefined;
    const callerController = new AbortController();
    clientSocket.once("close", () => {
      callerController.abort();
    });
    const finishOperation = (outcome: "success" | "failure", error?: unknown): void => {
      if (operationFinished) return;
      operationFinished = true;
      this.options.telemetry.finishSpan(
        operationSpan,
        startedAt,
        {
          plane: "data",
          protocol: "https",
          outcome,
          ...(route === undefined
            ? {}
            : {
                "proxy.route.id": route.id,
                "proxy.access_grant.id": route.accessGrantId,
                "enduser.id": route.userId,
                "customer.id": route.customerId,
              }),
        },
        error,
      );
    };

    try {
      route = await this.#authenticate(request);
      this.routes.assertProtocolAllowed(route, "https");
      const target = parseHostPort(request.url ?? "", 443);
      initialBudget = beginAttemptBudget(establishmentDeadline, this.options.attemptEstablishmentTimeoutMs, callerController.signal);
      const targetValidation = await this.options.targetValidator(target.host, target.port, initialBudget.signal);
      operationSpan.setAttributes({
        "proxy.route.id": route.id,
        "proxy.access_grant.id": route.accessGrantId,
        "enduser.id": route.userId,
        "customer.id": route.customerId,
        "server.address": target.host,
        "server.port": target.port,
      });
      await establishTunnel({
        routes: this.routes,
        route,
        protocol: "https",
        target,
        targetValidation,
        clientSocket,
        callerSignal: callerController.signal,
        operationId,
        operationSpan,
        operationFinished: finishOperation,
        establishmentDeadline,
        initialBudget,
        attemptEstablishmentTimeoutMs: this.options.attemptEstablishmentTimeoutMs,
        streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
        streamBufferBytes: this.options.streamBufferBytes,
        maxHandshakeBytes: this.options.maxHeaderBytes,
        logger: this.options.logger,
        telemetry: this.options.telemetry,
        prepareClient: (opened) => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (opened.remainder.length > 0) clientSocket.write(opened.remainder);
          if (head.length > 0) opened.socket.write(head);
          return { bytesSent: head.length, bytesReceived: opened.remainder.length };
        },
      });
    } catch (error) {
      initialBudget?.finish();
      finishOperation("failure", error);
      const appError = error instanceof AppError ? error : new ProviderUnavailableError();
      const status =
        appError.statusCode === 407
          ? "407 Proxy Authentication Required"
          : appError.statusCode === 403
            ? "403 Forbidden"
            : "502 Bad Gateway";
      const authenticate = appError.statusCode === 407 ? 'Proxy-Authenticate: Basic realm="profound"\r\n' : "";
      if (!clientSocket.destroyed) clientSocket.end(`HTTP/1.1 ${status}\r\n${authenticate}Connection: close\r\n\r\n`);
    }
  }
}
