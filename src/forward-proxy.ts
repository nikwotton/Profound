import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { Transform, type Duplex } from "node:stream";
import { assignmentAttributes, assignmentLogContext } from "./assignment-evidence.js";
import { recordDestinationResolution, resolvedAddressesFromHeader } from "./destination-resolution.js";
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
import { RouteService } from "./route-service.js";
import type { TargetValidator } from "./target-security.js";
import { Telemetry } from "./telemetry.js";
import {
  DEVICE_LEASE_IDLE_TIMEOUT_MS,
  type AuthenticatedRoute,
  type ListenAddress,
  type UpstreamEndpoint,
  type UsageOutcome,
} from "./types.js";
import { openUpstreamTunnel } from "./upstream-tunnel.js";

export interface ForwardProxyOptions {
  host: string;
  port: number;
  attemptEstablishmentTimeoutMs: number;
  operationEstablishmentTimeoutMs: number;
  streamIdleTimeoutMs: number;
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

function counter(onBytes: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
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

function replayable(request: IncomingMessage): boolean {
  const method = request.method ?? "";
  const safeMethod = method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "TRACE";
  const contentLength = Number(request.headers["content-length"] ?? 0);
  return safeMethod && contentLength === 0 && request.headers["transfer-encoding"] === undefined;
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
    let clientCancelled = false;
    const establishmentDeadline = operationDeadline(startedAt, this.options.operationEstablishmentTimeoutMs);
    let initialBudget: ReturnType<typeof beginAttemptBudget> | undefined;
    const callerController = new AbortController();
    const cancel = (): void => {
      clientCancelled = true;
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
        "proxy.provider.primary": route.provider,
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
      const canReplay = replayable(request);
      const maxAttempts = route.shouldRetry && canReplay ? route.retryPolicy.maxAttempts : 1;
      const resolutionState = this.routes.createResolutionState();
      if (canReplay) request.resume();

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
        let bytesSent = 0;
        let bytesReceived = 0;
        let attemptFinished = false;
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
              "proxy.failover": provider !== "unresolved" && provider !== route?.provider,
              "proxy.bytes_sent": bytesSent,
              "proxy.bytes_received": bytesReceived,
              ...(status === undefined ? {} : { "http.response.status_code": status }),
            },
            error,
            route === undefined
              ? undefined
              : {
                  isAuthenticated: route.isAuthenticated,
                  country: route.targeting.country,
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
            provider,
            endpointId: upstream?.endpointId,
            protocol: "http",
            outcome,
            retryIndex: attemptIndex,
            failover: provider !== "unresolved" && provider !== route?.provider,
            latencyMs: Date.now() - attemptStartedAt,
            bytesSent,
            bytesReceived,
            ...(status === undefined ? {} : { status }),
          });
          if (route !== undefined) {
            const completedAt = new Date().toISOString();
            void this.routes
              .recordUsage({
                id: attemptId,
                logicalOperationId: operationId,
                accessGrantId: route.accessGrantId,
                routeId: route.id,
                userId: route.userId,
                customerId: route.customerId,
                provider,
                protocol: "http",
                outcome: usageOutcome(outcome),
                retryIndex: attemptIndex,
                failover: provider !== "unresolved" && provider !== route.provider,
                bytesSent,
                bytesReceived,
                country: route.targeting.country,
                ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
                ...(upstream?.endpointId === undefined ? {} : { endpointId: upstream.endpointId }),
                ...(upstream?.deviceLeaseKey === undefined
                  ? {}
                  : {
                      deviceLeaseKey: upstream.deviceLeaseKey,
                      leaseWindowStartedAt: new Date(attemptStartedAt).toISOString(),
                      leaseWindowEndsAt: new Date(Date.parse(completedAt) + DEVICE_LEASE_IDLE_TIMEOUT_MS).toISOString(),
                    }),
                startedAt: new Date(attemptStartedAt).toISOString(),
                completedAt,
              })
              .catch((usageError) => this.options.logger.error("Usage record persistence failed", { error: usageError }));
          }
        };
        const retry = async (error?: unknown): Promise<void> => {
          if (upstream !== undefined) resolutionState.excludedEndpointIds.add(upstream.endpointId);
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
          attemptSpan.setAttributes({
            provider: upstream.provider,
            "proxy.endpoint.id": upstream.endpointId,
            ...assignmentAttributes(upstream.assignment),
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
            ...assignmentLogContext(upstream.assignment),
          });
          await this.routes.assertNewConnectionAllowed(route.id, route.accessGrantId);
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
            },
            (upstreamResponse) => {
              budget.finish();
              const status = upstreamResponse.statusCode ?? 502;
              bytesReceived += Buffer.byteLength(`HTTP/1.1 ${status}\r\n`) + headerBytes(upstreamResponse.headers);
              recordDestinationResolution({
                validation: targetValidation,
                providerMetadata: (() => {
                  const addresses = resolvedAddressesFromHeader(upstreamResponse.headers["x-mock-resolved-destination"]);
                  const resolverCountry = first(upstreamResponse.headers["x-mock-resolver-country"]);
                  return {
                    ...(addresses === undefined ? {} : { resolvedDestinationAddresses: addresses }),
                    ...(resolverCountry === undefined ? {} : { resolverCountry }),
                  };
                })(),
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
                  const error = new ProviderUnavailableError("Upstream response stream closed early");
                  finishAttempt("failure", error, status);
                  finishOperation("failure", error);
                }
              });
              upstreamResponse
                .pipe(
                  counter((bytes) => {
                    bytesReceived += bytes;
                  }),
                )
                .pipe(response);
            },
          );
          stopTracking = await this.routes.trackActiveConnection(route.id, route.accessGrantId, "http", upstream, () => {
            upstreamRequest.destroy(new AppError("Route was emergency-revoked", "route_emergency_revoked", 403));
            response.destroy();
          });
          const abortUpstream = (): void => {
            upstreamRequest.destroy(abortReason(budget.signal) as Error);
          };
          budget.signal.addEventListener("abort", abortUpstream, { once: true });
          upstreamRequest.setTimeout(budget.remainingMs(), () => {
            upstreamRequest.destroy(new ProviderUnavailableError("Upstream proxy timed out"));
          });
          let upstreamConnected = false;
          upstreamRequest.once("socket", (socket) => {
            if (!socket.connecting) upstreamConnected = true;
            socket.once("connect", () => {
              upstreamConnected = true;
            });
          });
          upstreamRequest.once("finish", () => {
            bytesSent += outboundHeaderBytes;
            budget.finish();
            budget.signal.removeEventListener("abort", abortUpstream);
          });
          upstreamRequest.once("error", (error) => {
            budget.finish();
            budget.signal.removeEventListener("abort", abortUpstream);
            const applicationBytesForwarded = upstreamConnected && (upstreamRequest.socket?.bytesWritten ?? 0) > 0;
            if (
              attemptIndex + 1 < maxAttempts &&
              !response.headersSent &&
              !clientCancelled &&
              !applicationBytesForwarded &&
              isRetryableUpstreamFailure(error)
            ) {
              void retry(error);
              return;
            }
            finishAttempt("failure", error);
            this.#sendError(response, new ProviderUnavailableError("Upstream provider connection failed"));
            finishOperation("failure", error);
          });
          if (canReplay) {
            upstreamRequest.end();
          } else {
            request
              .pipe(
                counter((bytes) => {
                  bytesSent += bytes;
                }),
              )
              .pipe(upstreamRequest);
          }
        } catch (error) {
          budget.finish();
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
          if (attemptIndex + 1 < maxAttempts && !response.headersSent && !clientCancelled && isRetryableUpstreamFailure(error)) {
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
    let clientCancelled = false;
    const establishmentDeadline = operationDeadline(startedAt, this.options.operationEstablishmentTimeoutMs);
    let initialBudget: ReturnType<typeof beginAttemptBudget> | undefined;
    const callerController = new AbortController();
    clientSocket.once("close", () => {
      clientCancelled = true;
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
      const maxAttempts = route.shouldRetry ? route.retryPolicy.maxAttempts : 1;
      const resolutionState = this.routes.createResolutionState();
      let lastError: unknown;

      for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
        const budget =
          attemptIndex === 0 && initialBudget !== undefined
            ? initialBudget
            : beginAttemptBudget(establishmentDeadline, this.options.attemptEstablishmentTimeoutMs, callerController.signal);
        const attemptId = randomUUID();
        const attemptStartedAt = Date.now();
        const attemptSpan = this.options.telemetry.startSpan("proxy.upstream_attempt", {
          "proxy.operation.id": operationId,
          "proxy.attempt.id": attemptId,
          "proxy.attempt.index": attemptIndex,
          "proxy.route.id": route.id,
          "proxy.access_grant.id": route.accessGrantId,
          "enduser.id": route.userId,
          "customer.id": route.customerId,
          "server.address": target.host,
          "server.port": target.port,
        });
        let upstream: UpstreamEndpoint | undefined;
        try {
          upstream = await this.routes.resolve(route, "https", target, resolutionState, {
            logicalOperationId: operationId,
            signal: budget.signal,
          });
          attemptSpan.setAttributes(assignmentAttributes(upstream.assignment));
          this.options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "selected", upstream.assignment);
          if (upstream.assignment.previousCandidateId !== undefined) {
            this.options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "changed", upstream.assignment);
          }
          if (upstream.assignment.expectedCity !== undefined) {
            this.options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "verification", upstream.assignment);
          }
          const opened = await openUpstreamTunnel(target, upstream, {
            connectTimeoutMs: budget.remainingMs(),
            maxHandshakeBytes: this.options.maxHeaderBytes,
            signal: budget.signal,
          });
          budget.finish();
          recordDestinationResolution({
            validation: targetValidation,
            providerMetadata: opened.providerMetadata,
            expectedCountry: route.targeting.country,
            logger: this.options.logger,
            span: attemptSpan,
            context: {
              logicalOperationId: operationId,
              upstreamAttemptId: attemptId,
              routeId: route.id,
              accessGrantId: route.accessGrantId,
              provider: upstream.provider,
              dataPlaneProtocol: "https",
              targetHost: target.host,
              targetPort: target.port,
            },
          });
          if (opened.providerMetadata.opaqueIpId !== undefined) {
            upstream.assignment.opaqueIpId = opened.providerMetadata.opaqueIpId;
            this.options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "identity_observed", upstream.assignment);
            this.options.logger.info("Upstream candidate identity observed", {
              logicalOperationId: operationId,
              upstreamAttemptId: attemptId,
              routeId: route.id,
              accessGrantId: route.accessGrantId,
              provider: upstream.provider,
              ...assignmentLogContext(upstream.assignment),
            });
          }
          if (clientCancelled || clientSocket.destroyed) {
            opened.socket.destroy();
            throw new AppError("Caller disconnected during tunnel establishment", "caller_cancelled", 499);
          }
          try {
            await this.routes.assertNewConnectionAllowed(route.id, route.accessGrantId);
          } catch (error) {
            opened.socket.destroy();
            throw error;
          }
          const stopTracking = await this.routes.trackActiveConnection(route.id, route.accessGrantId, "https", upstream, () => {
            clientSocket.destroy(new AppError("Route was emergency-revoked", "route_emergency_revoked", 403));
            opened.socket.destroy();
          });
          let bytesSent = head.length;
          let bytesReceived = opened.remainder.length;
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (opened.remainder.length > 0) clientSocket.write(opened.remainder);
          if (head.length > 0) opened.socket.write(head);
          opened.socket.setTimeout(this.options.streamIdleTimeoutMs, () => {
            opened.socket.destroy(new ProviderUnavailableError("Proxy tunnel exceeded the stream idle timeout"));
          });
          clientSocket
            .pipe(
              counter((bytes) => {
                bytesSent += bytes;
              }),
            )
            .pipe(opened.socket);
          opened.socket
            .pipe(
              counter((bytes) => {
                bytesReceived += bytes;
              }),
            )
            .pipe(clientSocket);
          let tunnelFinished = false;
          const activeRoute = route;
          const activeUpstream = upstream;
          const finishTunnel = (outcome: "success" | "failure", error?: unknown): void => {
            if (tunnelFinished) return;
            tunnelFinished = true;
            stopTracking();
            this.options.telemetry.finishAttempt(
              attemptSpan,
              attemptStartedAt,
              {
                provider: upstream?.provider ?? "unknown",
                protocol: "https",
                outcome,
                "proxy.failover": upstream?.provider !== route?.provider,
                "proxy.bytes_sent": bytesSent,
                "proxy.bytes_received": bytesReceived,
                "proxy.endpoint.id": upstream?.endpointId ?? "unknown",
              },
              error,
              route === undefined
                ? undefined
                : {
                    isAuthenticated: route.isAuthenticated,
                    country: route.targeting.country,
                    ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
                  },
            );
            this.options.logger.info("Proxy tunnel completed", {
              logicalOperationId: operationId,
              upstreamAttemptId: attemptId,
              routeId: route?.id,
              accessGrantId: route?.accessGrantId,
              userId: route?.userId,
              customerId: route?.customerId,
              provider: upstream?.provider,
              endpointId: upstream?.endpointId,
              dataPlaneProtocol: "https",
              retryIndex: attemptIndex,
              failover: upstream?.provider !== route?.provider,
              targetHost: target.host,
              targetPort: target.port,
              outcome,
              latencyMs: Date.now() - attemptStartedAt,
              bytesSent,
              bytesReceived,
            });
            const completedAt = new Date().toISOString();
            void this.routes
              .recordUsage({
                id: attemptId,
                logicalOperationId: operationId,
                accessGrantId: activeRoute.accessGrantId,
                routeId: activeRoute.id,
                userId: activeRoute.userId,
                customerId: activeRoute.customerId,
                provider: activeUpstream.provider,
                protocol: "https",
                outcome,
                retryIndex: attemptIndex,
                failover: activeUpstream.provider !== activeRoute.provider,
                bytesSent,
                bytesReceived,
                country: activeRoute.targeting.country,
                ...(activeRoute.targeting.city === undefined ? {} : { city: activeRoute.targeting.city }),
                ...(activeUpstream.endpointId === undefined ? {} : { endpointId: activeUpstream.endpointId }),
                ...(activeUpstream.deviceLeaseKey === undefined
                  ? {}
                  : {
                      deviceLeaseKey: activeUpstream.deviceLeaseKey,
                      leaseWindowStartedAt: new Date(attemptStartedAt).toISOString(),
                      leaseWindowEndsAt: new Date(Date.parse(completedAt) + DEVICE_LEASE_IDLE_TIMEOUT_MS).toISOString(),
                    }),
                startedAt: new Date(attemptStartedAt).toISOString(),
                completedAt,
              })
              .catch((usageError) => this.options.logger.error("Usage record persistence failed", { error: usageError }));
            finishOperation(outcome, error);
          };
          clientSocket.once("close", () => finishTunnel("success"));
          clientSocket.once("error", (error) => finishTunnel("failure", error));
          opened.socket.once("error", (error) => finishTunnel("failure", error));
          this.options.logger.info("Proxy tunnel opened", {
            logicalOperationId: operationId,
            upstreamAttemptId: attemptId,
            routeId: route.id,
            accessGrantId: route.accessGrantId,
            userId: route.userId,
            customerId: route.customerId,
            provider: upstream.provider,
            endpointId: upstream.endpointId,
            ...assignmentLogContext(upstream.assignment),
            dataPlaneProtocol: "https",
            targetHost: target.host,
            targetPort: target.port,
          });
          return;
        } catch (error) {
          budget.finish();
          lastError = error;
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
              routeId: route.id,
              accessGrantId: route.accessGrantId,
              provider: providerIdFromError(error),
              ...assignmentLogContext(failedAssignment),
            });
          }
          if (upstream !== undefined) resolutionState.excludedEndpointIds.add(upstream.endpointId);
          const retry = !clientCancelled && attemptIndex + 1 < maxAttempts && isRetryableUpstreamFailure(error);
          const attemptedProvider = upstream?.provider ?? providerIdFromError(error);
          this.options.telemetry.finishAttempt(
            attemptSpan,
            attemptStartedAt,
            {
              provider: attemptedProvider ?? "unresolved",
              protocol: "https",
              outcome: retry ? "retry" : "failure",
              "proxy.failover": attemptedProvider !== undefined && attemptedProvider !== route.provider,
              "proxy.bytes_sent": 0,
              "proxy.bytes_received": 0,
            },
            error,
            {
              isAuthenticated: route.isAuthenticated,
              country: route.targeting.country,
              ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
            },
          );
          this.options.logger.warn("Proxy tunnel establishment failed", {
            logicalOperationId: operationId,
            upstreamAttemptId: attemptId,
            routeId: route.id,
            accessGrantId: route.accessGrantId,
            userId: route.userId,
            customerId: route.customerId,
            provider: attemptedProvider,
            endpointId: upstream?.endpointId,
            dataPlaneProtocol: "https",
            targetHost: target.host,
            targetPort: target.port,
            outcome: retry ? "retry" : "failure",
            retryIndex: attemptIndex,
            failover: attemptedProvider !== undefined && attemptedProvider !== route.provider,
          });
          const completedAt = new Date().toISOString();
          void this.routes
            .recordUsage({
              id: attemptId,
              logicalOperationId: operationId,
              accessGrantId: route.accessGrantId,
              routeId: route.id,
              userId: route.userId,
              customerId: route.customerId,
              provider: attemptedProvider ?? "unresolved",
              protocol: "https",
              outcome: retry ? "retry" : "failure",
              retryIndex: attemptIndex,
              failover: attemptedProvider !== undefined && attemptedProvider !== route.provider,
              bytesSent: 0,
              bytesReceived: 0,
              country: route.targeting.country,
              ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
              ...(upstream?.endpointId === undefined ? {} : { endpointId: upstream.endpointId }),
              startedAt: new Date(attemptStartedAt).toISOString(),
              completedAt,
            })
            .catch((usageError) => this.options.logger.error("Usage record persistence failed", { error: usageError }));
          if (!retry) break;
        }
      }
      throw lastError ?? new ProviderUnavailableError("No provider could establish the tunnel");
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
