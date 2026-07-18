import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { Transform } from "node:stream";
import { assignmentAttributes, assignmentLogContext } from "./assignment-evidence.js";
import { expectBufferChunk } from "./decoding.js";
import { assertSafeProviderResolution, recordDestinationResolution } from "./destination-resolution.js";
import { beginAttemptBudget, operationDeadline } from "./establishment-budget.js";
import {
  AppError,
  AuthenticationError,
  ProviderUnavailableError,
  assignmentFromError,
  isRetryableUpstreamFailure,
  providerIdFromError,
} from "./errors.js";
import type { Logger } from "./logger.js";
import { closeServer, listen } from "./net-utils.js";
import { RouteService } from "./route-service.js";
import { routingScoreLogContext, routingScoreTelemetryAttributes } from "./routing-policy.js";
import type { TargetValidator } from "./target-security.js";
import { Telemetry } from "./telemetry.js";
import type { AuthenticatedRoute, ListenAddress, UpstreamEndpoint } from "./types.js";
import { openUpstreamTunnel } from "./upstream-tunnel.js";

export interface Socks5ProxyOptions {
  host: string;
  port: number;
  attemptEstablishmentTimeoutMs: number;
  operationEstablishmentTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxHandshakeBytes: number;
  targetValidator: TargetValidator;
  logger: Logger;
  telemetry: Telemetry;
}

function counter(onBytes: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
}

class HandshakeReader {
  #consumed = 0;

  constructor(
    private readonly socket: Socket,
    private readonly maximumBytes: number,
  ) {}

  async read(length: number): Promise<Buffer> {
    this.#consumed += length;
    if (this.#consumed > this.maximumBytes) throw new AppError("SOCKS5 handshake is too large", "invalid_socks5", 400);
    const chunks: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const rawChunk: unknown = this.socket.read(remaining);
      if (rawChunk !== null) {
        const chunk = expectBufferChunk(rawChunk, "SOCKS5 handshake chunk");
        chunks.push(chunk);
        remaining -= chunk.length;
        continue;
      }
      if (this.socket.readableEnded || this.socket.destroyed) {
        throw new AppError("SOCKS5 handshake ended early", "invalid_socks5", 400);
      }
      await once(this.socket, "readable");
    }
    return Buffer.concat(chunks, length);
  }
}

function ipv6Text(bytes: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16));
  return groups.join(":");
}

async function readTarget(reader: HandshakeReader, addressType: number): Promise<string> {
  if (addressType === 0x01) return [...(await reader.read(4))].join(".");
  if (addressType === 0x04) return ipv6Text(await reader.read(16));
  if (addressType === 0x03) {
    const length = (await reader.read(1)).readUInt8(0);
    if (length === 0) throw new AppError("SOCKS5 target hostname is empty", "invalid_socks5", 400);
    return (await reader.read(length)).toString("utf8");
  }
  throw new AppError("SOCKS5 address type is not supported", "unsupported_socks5_address", 400);
}

function sendReply(socket: Socket, code: number): void {
  if (!socket.destroyed) socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
}

export class Socks5ProxyServer {
  readonly #server;
  #address?: ListenAddress;

  constructor(
    private readonly routes: RouteService,
    private readonly options: Socks5ProxyOptions,
  ) {
    this.#server = createServer((socket) => void this.#handle(socket));
  }

  async start(): Promise<ListenAddress> {
    this.#address = await listen(this.#server, this.options.host, this.options.port);
    return this.#address;
  }

  address(): ListenAddress {
    if (this.#address === undefined) throw new Error("SOCKS5 proxy has not started");
    return this.#address;
  }

  async stop(): Promise<void> {
    await closeServer(this.#server);
  }

  async #handle(clientSocket: Socket): Promise<void> {
    // Handshake failures are normalized below; prevent unhandled socket errors.
    clientSocket.on("error", () => undefined);
    const operationId = randomUUID();
    const startedAt = Date.now();
    const operationSpan = this.options.telemetry.startSpan("proxy.socks5", { "proxy.operation.id": operationId });
    const reader = new HandshakeReader(clientSocket, this.options.maxHandshakeBytes);
    let route: AuthenticatedRoute | undefined;
    let requestAccepted = false;
    let finished = false;
    const establishmentDeadline = operationDeadline(startedAt, this.options.operationEstablishmentTimeoutMs);
    let initialBudget: ReturnType<typeof beginAttemptBudget> | undefined;
    const callerController = new AbortController();
    clientSocket.once("close", () => {
      callerController.abort();
    });
    const finishOperation = (outcome: "success" | "failure", error?: unknown): void => {
      if (finished) return;
      finished = true;
      this.options.telemetry.finishSpan(
        operationSpan,
        startedAt,
        {
          plane: "data",
          protocol: "socks5",
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

    clientSocket.setTimeout(this.options.attemptEstablishmentTimeoutMs, () => {
      clientSocket.destroy(new ProviderUnavailableError("SOCKS5 handshake timed out"));
    });
    try {
      const greeting = await reader.read(2);
      if (greeting.readUInt8(0) !== 0x05) throw new AppError("SOCKS5 version 5 is required", "invalid_socks5", 400);
      const methods = await reader.read(greeting.readUInt8(1));
      if (!methods.includes(0x02)) {
        clientSocket.end(Buffer.from([0x05, 0xff]));
        throw new AuthenticationError("SOCKS5 username/password authentication is required");
      }
      clientSocket.write(Buffer.from([0x05, 0x02]));

      const authHeader = await reader.read(2);
      if (authHeader.readUInt8(0) !== 0x01 || authHeader.readUInt8(1) === 0) throw new AuthenticationError();
      const username = (await reader.read(authHeader.readUInt8(1))).toString("utf8");
      const passwordLength = (await reader.read(1)).readUInt8(0);
      const password = (await reader.read(passwordLength)).toString("utf8");
      try {
        route = await this.routes.authenticate(username, password);
      } catch {
        clientSocket.end(Buffer.from([0x01, 0x01]));
        throw new AuthenticationError();
      }
      clientSocket.write(Buffer.from([0x01, 0x00]));

      const request = await reader.read(4);
      requestAccepted = true;
      if (request.readUInt8(0) !== 0x05 || request.readUInt8(2) !== 0x00) {
        throw new AppError("Invalid SOCKS5 request", "invalid_socks5", 400);
      }
      const targetHost = await readTarget(reader, request.readUInt8(3));
      const targetPort = (await reader.read(2)).readUInt16BE(0);
      if (request.readUInt8(1) !== 0x01) {
        sendReply(clientSocket, 0x07);
        clientSocket.end();
        finishOperation("failure", new AppError("SOCKS5 supports TCP CONNECT only", "unsupported_socks5_command", 400));
        return;
      }
      this.routes.assertProtocolAllowed(route, "socks5");
      initialBudget = beginAttemptBudget(establishmentDeadline, this.options.attemptEstablishmentTimeoutMs, callerController.signal);
      const targetValidation = await this.options.targetValidator(targetHost, targetPort, initialBudget.signal);
      operationSpan.setAttributes({
        "proxy.route.id": route.id,
        "proxy.access_grant.id": route.accessGrantId,
        "proxy.provider.primary": route.provider,
        "enduser.id": route.userId,
        "customer.id": route.customerId,
        "server.address": targetHost,
        "server.port": targetPort,
      });

      const maxAttempts = route.shouldRetry ? route.retryPolicy.maxAttempts : 1;
      const resolutionState = this.routes.createResolutionState();
      let lastError: unknown;
      for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
        const budget =
          attemptIndex === 0
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
          "server.address": targetHost,
          "server.port": targetPort,
        });
        let upstream: UpstreamEndpoint | undefined;
        try {
          upstream = await this.routes.resolve(route, "socks5", { host: targetHost, port: targetPort }, resolutionState, {
            logicalOperationId: operationId,
            signal: budget.signal,
          });
          attemptSpan.setAttributes({
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
          const opened = await openUpstreamTunnel({ host: targetHost, port: targetPort }, upstream, {
            connectTimeoutMs: budget.remainingMs(),
            maxHandshakeBytes: this.options.maxHandshakeBytes,
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
              dataPlaneProtocol: "socks5",
              targetHost,
              targetPort,
            },
          });
          try {
            assertSafeProviderResolution(opened.providerMetadata);
          } catch (error) {
            opened.socket.destroy();
            throw error;
          }
          await this.routes.recordCandidateSuccess(upstream);
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
          if (callerController.signal.aborted || clientSocket.destroyed) {
            opened.socket.destroy();
            throw new AppError("Caller disconnected during tunnel establishment", "caller_cancelled", 499);
          }
          try {
            await this.routes.assertNewConnectionAllowed(route.id, route.accessGrantId);
          } catch (error) {
            opened.socket.destroy();
            throw error;
          }
          const stopTracking = await this.routes.trackActiveConnection(route.id, route.accessGrantId, "socks5", upstream, () => {
            clientSocket.destroy(new AppError("Route was emergency-revoked", "route_emergency_revoked", 403));
            opened.socket.destroy();
          });
          let bytesSent = 0;
          let bytesReceived = opened.remainder.length;
          clientSocket.setTimeout(this.options.streamIdleTimeoutMs, () => {
            clientSocket.destroy(new ProviderUnavailableError("SOCKS5 tunnel exceeded the stream idle timeout"));
          });
          opened.socket.setTimeout(this.options.streamIdleTimeoutMs, () => {
            opened.socket.destroy(new ProviderUnavailableError("SOCKS5 tunnel exceeded the stream idle timeout"));
          });
          sendReply(clientSocket, 0x00);
          if (opened.remainder.length > 0) clientSocket.write(opened.remainder);
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
                protocol: "socks5",
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
                    ...(route.targeting.country === undefined ? {} : { country: route.targeting.country }),
                    ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
                  },
            );
            this.options.logger.info("SOCKS5 tunnel completed", {
              logicalOperationId: operationId,
              upstreamAttemptId: attemptId,
              routeId: route?.id,
              accessGrantId: route?.accessGrantId,
              userId: route?.userId,
              customerId: route?.customerId,
              provider: upstream?.provider,
              endpointId: upstream?.endpointId,
              ...(upstream === undefined ? {} : assignmentLogContext(upstream.assignment)),
              dataPlaneProtocol: "socks5",
              retryIndex: attemptIndex,
              failover: upstream?.provider !== route?.provider,
              targetHost,
              targetPort,
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
                protocol: "socks5",
                outcome,
                retryIndex: attemptIndex,
                failover: activeUpstream.provider !== activeRoute.provider,
                bytesSent,
                bytesReceived,
                ...(activeRoute.targeting.country === undefined ? {} : { country: activeRoute.targeting.country }),
                ...(activeRoute.targeting.city === undefined ? {} : { city: activeRoute.targeting.city }),
                ...(activeRoute.providerOverride === undefined ? {} : { providerOverride: activeRoute.providerOverride }),
                endpointId: activeUpstream.endpointId,
                ...(activeUpstream.proxySlotId === undefined
                  ? {}
                  : {
                      proxySlotId: activeUpstream.proxySlotId,
                      ...(activeUpstream.upstreamConnectionId === undefined
                        ? {}
                        : { upstreamConnectionId: activeUpstream.upstreamConnectionId }),
                      connectionStartedAt: activeUpstream.upstreamConnectionStartedAt ?? new Date(attemptStartedAt).toISOString(),
                      connectionEndedAt: completedAt,
                      selectedSlotLoad: activeUpstream.selectedSlotLoad,
                    }),
                ...(activeUpstream.capacityPressure === true
                  ? {
                      capacityPressure: true,
                      capacityPressureProvider: activeUpstream.capacityPressureProvider ?? activeUpstream.provider,
                      ...(activeUpstream.capacityPolicyVersion === undefined
                        ? {}
                        : { capacityPolicyVersion: activeUpstream.capacityPolicyVersion }),
                    }
                  : {}),
                ...(resolutionState.capacityConstraint === undefined ? {} : { capacityConstraint: resolutionState.capacityConstraint }),
                ...(activeUpstream.capacityCircuitState === undefined
                  ? {}
                  : {
                      capacityCircuitState: activeUpstream.capacityCircuitState,
                      capacityCircuitReason: activeUpstream.capacityCircuitReason,
                      capacityCircuitCooldownUntil: activeUpstream.capacityCircuitCooldownUntil,
                    }),
                ...(activeUpstream.routingPolicyVersion === undefined
                  ? {}
                  : {
                      routingPolicyVersion: activeUpstream.routingPolicyVersion,
                      routingScore: activeUpstream.routingScore,
                      routingScoreComponents: activeUpstream.routingScoreComponents,
                    }),
                establishmentWaitMs: resolutionState.establishmentWaitMs,
                startedAt: new Date(attemptStartedAt).toISOString(),
                completedAt,
              })
              .catch((usageError: unknown) => this.options.logger.error("Usage record persistence failed", { error: usageError }));
            finishOperation(outcome, error);
          };
          clientSocket.once("close", () => finishTunnel("success"));
          clientSocket.once("error", (error) => finishTunnel("failure", error));
          opened.socket.once("error", (error) => finishTunnel("failure", error));
          return;
        } catch (error) {
          budget.finish();
          await this.routes.recordCandidateFailure(upstream, error).catch(() => undefined);
          await this.routes.releaseCandidate(upstream).catch(() => undefined);
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
          const retry = !callerController.signal.aborted && attemptIndex + 1 < maxAttempts && isRetryableUpstreamFailure(error);
          const attemptedProvider = upstream?.provider ?? providerIdFromError(error);
          this.options.telemetry.finishAttempt(
            attemptSpan,
            attemptStartedAt,
            {
              provider: attemptedProvider ?? "unresolved",
              protocol: "socks5",
              outcome: retry ? "retry" : "failure",
              "proxy.failover": attemptedProvider !== undefined && attemptedProvider !== route.provider,
              "proxy.bytes_sent": 0,
              "proxy.bytes_received": 0,
            },
            error,
            {
              isAuthenticated: route.isAuthenticated,
              ...(route.targeting.country === undefined ? {} : { country: route.targeting.country }),
              ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
            },
          );
          this.options.logger.warn("SOCKS5 tunnel establishment failed", {
            logicalOperationId: operationId,
            upstreamAttemptId: attemptId,
            routeId: route.id,
            accessGrantId: route.accessGrantId,
            userId: route.userId,
            customerId: route.customerId,
            provider: attemptedProvider,
            endpointId: upstream?.endpointId,
            dataPlaneProtocol: "socks5",
            targetHost,
            targetPort,
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
              protocol: "socks5",
              outcome: retry ? "retry" : "failure",
              retryIndex: attemptIndex,
              failover: attemptedProvider !== undefined && attemptedProvider !== route.provider,
              bytesSent: 0,
              bytesReceived: 0,
              ...(route.targeting.country === undefined ? {} : { country: route.targeting.country }),
              ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
              ...(route.providerOverride === undefined ? {} : { providerOverride: route.providerOverride }),
              ...(upstream?.endpointId === undefined ? {} : { endpointId: upstream.endpointId }),
              ...(resolutionState.capacityConstraint === undefined ? {} : { capacityConstraint: resolutionState.capacityConstraint }),
              ...(upstream?.capacityCircuitState === undefined
                ? {}
                : {
                    capacityCircuitState: upstream.capacityCircuitState,
                    capacityCircuitReason: upstream.capacityCircuitReason,
                    capacityCircuitCooldownUntil: upstream.capacityCircuitCooldownUntil,
                  }),
              ...(resolutionState.capacityPolicyVersion === undefined
                ? {}
                : { capacityPolicyVersion: resolutionState.capacityPolicyVersion }),
              ...(upstream?.routingPolicyVersion === undefined
                ? {}
                : {
                    routingPolicyVersion: upstream.routingPolicyVersion,
                    routingScore: upstream.routingScore,
                    routingScoreComponents: upstream.routingScoreComponents,
                  }),
              establishmentWaitMs: resolutionState.establishmentWaitMs,
              startedAt: new Date(attemptStartedAt).toISOString(),
              completedAt,
            })
            .catch((usageError: unknown) => this.options.logger.error("Usage record persistence failed", { error: usageError }));
          if (!retry) break;
        }
      }
      throw lastError instanceof Error ? lastError : new ProviderUnavailableError("No provider could establish the SOCKS5 tunnel");
    } catch (error) {
      initialBudget?.finish();
      finishOperation("failure", error);
      if (requestAccepted && !clientSocket.destroyed) {
        const replyCode =
          error instanceof AppError && error.code === "unsupported_socks5_address"
            ? 0x08
            : error instanceof AppError && error.statusCode === 403
              ? 0x02
              : 0x01;
        sendReply(clientSocket, replyCode);
        clientSocket.end();
      } else if (!clientSocket.destroyed && !clientSocket.writableEnded) {
        clientSocket.destroy();
      }
    }
  }
}
