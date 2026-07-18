import { randomUUID } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import { Transform, type Duplex } from "node:stream";
import { assignmentAttributes, assignmentLogContext } from "./assignment-evidence.js";
import { assertSafeProviderResolution, recordDestinationResolution } from "./destination-resolution.js";
import { beginAttemptBudget, type AttemptBudget } from "./establishment-budget.js";
import { AppError, ProviderUnavailableError, assignmentFromError, isRetryableUpstreamFailure, providerIdFromError } from "./errors.js";
import type { Logger } from "./logger.js";
import { routingScoreLogContext, routingScoreTelemetryAttributes } from "./routing-policy.js";
import type { ResolutionState, RouteService } from "./route-service.js";
import type { TargetValidation } from "./target-security.js";
import type { Telemetry } from "./telemetry.js";
import type { AuthenticatedRoute, ProxyTarget, UpstreamEndpoint } from "./types.js";
import { openUpstreamTunnel, type OpenedUpstreamTunnel } from "./upstream-tunnel.js";

export type TunnelProtocol = "https" | "socks5";

export interface TunnelOperationOptions {
  routes: RouteService;
  route: AuthenticatedRoute;
  protocol: TunnelProtocol;
  target: ProxyTarget;
  targetValidation: TargetValidation | undefined;
  clientSocket: Duplex;
  callerSignal: AbortSignal;
  operationId: string;
  operationSpan: Span;
  operationFinished: (outcome: "success" | "failure", error?: unknown) => void;
  establishmentDeadline: number;
  initialBudget: AttemptBudget;
  attemptEstablishmentTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxHandshakeBytes: number;
  logger: Logger;
  telemetry: Telemetry;
  prepareClient(opened: OpenedUpstreamTunnel): { bytesSent: number; bytesReceived: number };
}

function counter(onBytes: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
}

function passiveContext(route: AuthenticatedRoute) {
  return {
    isAuthenticated: route.isAuthenticated,
    ...(route.targeting.country === undefined ? {} : { country: route.targeting.country }),
    ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
  };
}

function establishedUsage(
  route: AuthenticatedRoute,
  upstream: UpstreamEndpoint,
  state: ResolutionState,
  options: {
    attemptId: string;
    operationId: string;
    protocol: TunnelProtocol;
    outcome: "success" | "failure";
    attemptIndex: number;
    attemptStartedAt: number;
    bytesSent: number;
    bytesReceived: number;
    completedAt: string;
  },
) {
  return {
    id: options.attemptId,
    logicalOperationId: options.operationId,
    accessGrantId: route.accessGrantId,
    routeId: route.id,
    userId: route.userId,
    customerId: route.customerId,
    provider: upstream.provider,
    protocol: options.protocol,
    outcome: options.outcome,
    retryIndex: options.attemptIndex,
    failover: upstream.provider !== route.provider,
    bytesSent: options.bytesSent,
    bytesReceived: options.bytesReceived,
    ...(route.targeting.country === undefined ? {} : { country: route.targeting.country }),
    ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
    ...(route.providerOverride === undefined ? {} : { providerOverride: route.providerOverride }),
    endpointId: upstream.endpointId,
    ...(upstream.proxySlotId === undefined
      ? {}
      : {
          proxySlotId: upstream.proxySlotId,
          ...(upstream.upstreamConnectionId === undefined ? {} : { upstreamConnectionId: upstream.upstreamConnectionId }),
          connectionStartedAt: upstream.upstreamConnectionStartedAt ?? new Date(options.attemptStartedAt).toISOString(),
          connectionEndedAt: options.completedAt,
          selectedSlotLoad: upstream.selectedSlotLoad,
        }),
    ...(upstream.capacityPressure === true
      ? {
          capacityPressure: true as const,
          capacityPressureProvider: upstream.capacityPressureProvider ?? upstream.provider,
          ...(upstream.capacityPolicyVersion === undefined ? {} : { capacityPolicyVersion: upstream.capacityPolicyVersion }),
        }
      : {}),
    ...(state.capacityConstraint === undefined ? {} : { capacityConstraint: state.capacityConstraint }),
    ...(upstream.capacityCircuitState === undefined
      ? {}
      : {
          capacityCircuitState: upstream.capacityCircuitState,
          capacityCircuitReason: upstream.capacityCircuitReason,
          capacityCircuitCooldownUntil: upstream.capacityCircuitCooldownUntil,
        }),
    ...(upstream.routingPolicyVersion === undefined
      ? {}
      : {
          routingPolicyVersion: upstream.routingPolicyVersion,
          routingScore: upstream.routingScore,
          routingScoreComponents: upstream.routingScoreComponents,
        }),
    establishmentWaitMs: state.establishmentWaitMs,
    startedAt: new Date(options.attemptStartedAt).toISOString(),
    completedAt: options.completedAt,
  };
}

function failedUsage(
  route: AuthenticatedRoute,
  upstream: UpstreamEndpoint | undefined,
  state: ResolutionState,
  options: {
    attemptId: string;
    operationId: string;
    protocol: TunnelProtocol;
    outcome: "retry" | "failure";
    attemptIndex: number;
    attemptStartedAt: number;
    attemptedProvider: ReturnType<typeof providerIdFromError>;
    completedAt: string;
  },
) {
  return {
    id: options.attemptId,
    logicalOperationId: options.operationId,
    accessGrantId: route.accessGrantId,
    routeId: route.id,
    userId: route.userId,
    customerId: route.customerId,
    provider: options.attemptedProvider ?? ("unresolved" as const),
    protocol: options.protocol,
    outcome: options.outcome,
    retryIndex: options.attemptIndex,
    failover: options.attemptedProvider !== undefined && options.attemptedProvider !== route.provider,
    bytesSent: 0,
    bytesReceived: 0,
    ...(route.targeting.country === undefined ? {} : { country: route.targeting.country }),
    ...(route.targeting.city === undefined ? {} : { city: route.targeting.city }),
    ...(route.providerOverride === undefined ? {} : { providerOverride: route.providerOverride }),
    ...(upstream?.endpointId === undefined ? {} : { endpointId: upstream.endpointId }),
    ...(state.capacityConstraint === undefined ? {} : { capacityConstraint: state.capacityConstraint }),
    ...(upstream?.capacityCircuitState === undefined
      ? {}
      : {
          capacityCircuitState: upstream.capacityCircuitState,
          capacityCircuitReason: upstream.capacityCircuitReason,
          capacityCircuitCooldownUntil: upstream.capacityCircuitCooldownUntil,
        }),
    ...(state.capacityPolicyVersion === undefined ? {} : { capacityPolicyVersion: state.capacityPolicyVersion }),
    ...(upstream?.routingPolicyVersion === undefined
      ? {}
      : {
          routingPolicyVersion: upstream.routingPolicyVersion,
          routingScore: upstream.routingScore,
          routingScoreComponents: upstream.routingScoreComponents,
        }),
    establishmentWaitMs: state.establishmentWaitMs,
    startedAt: new Date(options.attemptStartedAt).toISOString(),
    completedAt: options.completedAt,
  };
}

export async function establishTunnel(options: TunnelOperationOptions): Promise<void> {
  const { route, target, protocol } = options;
  const maxAttempts = route.shouldRetry ? route.retryPolicy.maxAttempts : 1;
  const resolutionState = options.routes.createResolutionState();
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const budget =
      attemptIndex === 0
        ? options.initialBudget
        : beginAttemptBudget(options.establishmentDeadline, options.attemptEstablishmentTimeoutMs, options.callerSignal);
    const attemptId = randomUUID();
    const attemptStartedAt = Date.now();
    const attemptSpan = options.telemetry.startSpan("proxy.upstream_attempt", {
      "proxy.operation.id": options.operationId,
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
      upstream = await options.routes.resolve(route, protocol, target, resolutionState, {
        logicalOperationId: options.operationId,
        signal: budget.signal,
      });
      attemptSpan.setAttributes({
        ...assignmentAttributes(upstream.assignment),
        ...routingScoreTelemetryAttributes(upstream),
        ...(route.providerOverride === undefined ? {} : { "proxy.routing.provider_override": route.providerOverride }),
      });
      options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "selected", upstream.assignment);
      if (upstream.assignment.previousCandidateId !== undefined) {
        options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "changed", upstream.assignment);
      }
      if (upstream.assignment.expectedCity !== undefined) {
        options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "verification", upstream.assignment);
      }
      options.logger.info("Upstream candidate selected", {
        logicalOperationId: options.operationId,
        upstreamAttemptId: attemptId,
        routeId: route.id,
        accessGrantId: route.accessGrantId,
        provider: upstream.provider,
        ...(route.providerOverride === undefined ? {} : { providerOverride: route.providerOverride }),
        ...assignmentLogContext(upstream.assignment),
        ...routingScoreLogContext(upstream),
      });
      const opened = await openUpstreamTunnel(target, upstream, {
        connectTimeoutMs: budget.remainingMs(),
        maxHandshakeBytes: options.maxHandshakeBytes,
        signal: budget.signal,
      });
      budget.finish();
      recordDestinationResolution({
        validation: options.targetValidation,
        providerMetadata: opened.providerMetadata,
        expectedCountry: route.targeting.country,
        logger: options.logger,
        span: attemptSpan,
        context: {
          logicalOperationId: options.operationId,
          upstreamAttemptId: attemptId,
          routeId: route.id,
          accessGrantId: route.accessGrantId,
          provider: upstream.provider,
          dataPlaneProtocol: protocol,
          targetHost: target.host,
          targetPort: target.port,
        },
      });
      try {
        assertSafeProviderResolution(opened.providerMetadata);
      } catch (error) {
        opened.socket.destroy();
        throw error;
      }
      await options.routes.recordCandidateSuccess(upstream);
      if (opened.providerMetadata.opaqueIpId !== undefined) {
        upstream.assignment.opaqueIpId = opened.providerMetadata.opaqueIpId;
        options.telemetry.recordCandidateEvent(attemptSpan, upstream.provider, "identity_observed", upstream.assignment);
        options.logger.info("Upstream candidate identity observed", {
          logicalOperationId: options.operationId,
          upstreamAttemptId: attemptId,
          routeId: route.id,
          accessGrantId: route.accessGrantId,
          provider: upstream.provider,
          ...assignmentLogContext(upstream.assignment),
        });
      }
      if (options.callerSignal.aborted || options.clientSocket.destroyed) {
        opened.socket.destroy();
        throw new AppError("Caller disconnected during tunnel establishment", "caller_cancelled", 499);
      }
      try {
        await options.routes.assertNewConnectionAllowed(route.id, route.accessGrantId);
      } catch (error) {
        opened.socket.destroy();
        throw error;
      }
      const stopTracking = await options.routes.trackActiveConnection(route.id, route.accessGrantId, protocol, upstream, () => {
        options.clientSocket.destroy(new AppError("Route was emergency-revoked", "route_emergency_revoked", 403));
        opened.socket.destroy();
      });
      let bytesSent: number;
      let bytesReceived: number;
      try {
        ({ bytesSent, bytesReceived } = options.prepareClient(opened));
      } catch (error) {
        stopTracking();
        opened.socket.destroy();
        throw error;
      }
      opened.socket.setTimeout(options.streamIdleTimeoutMs, () => {
        opened.socket.destroy(new ProviderUnavailableError("Proxy tunnel exceeded the stream idle timeout"));
      });
      options.clientSocket
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
        .pipe(options.clientSocket);
      let tunnelFinished = false;
      const activeUpstream = upstream;
      const finishTunnel = (outcome: "success" | "failure", error?: unknown): void => {
        if (tunnelFinished) return;
        tunnelFinished = true;
        stopTracking();
        options.telemetry.finishAttempt(
          attemptSpan,
          attemptStartedAt,
          {
            provider: activeUpstream.provider,
            protocol,
            outcome,
            "proxy.failover": activeUpstream.provider !== route.provider,
            "proxy.bytes_sent": bytesSent,
            "proxy.bytes_received": bytesReceived,
            "proxy.endpoint.id": activeUpstream.endpointId,
          },
          error,
          passiveContext(route),
        );
        options.logger.info(protocol === "socks5" ? "SOCKS5 tunnel completed" : "Proxy tunnel completed", {
          logicalOperationId: options.operationId,
          upstreamAttemptId: attemptId,
          routeId: route.id,
          accessGrantId: route.accessGrantId,
          userId: route.userId,
          customerId: route.customerId,
          provider: activeUpstream.provider,
          endpointId: activeUpstream.endpointId,
          ...assignmentLogContext(activeUpstream.assignment),
          dataPlaneProtocol: protocol,
          retryIndex: attemptIndex,
          failover: activeUpstream.provider !== route.provider,
          targetHost: target.host,
          targetPort: target.port,
          outcome,
          latencyMs: Date.now() - attemptStartedAt,
          bytesSent,
          bytesReceived,
        });
        const completedAt = new Date().toISOString();
        void options.routes
          .recordUsage(
            establishedUsage(route, activeUpstream, resolutionState, {
              attemptId,
              operationId: options.operationId,
              protocol,
              outcome,
              attemptIndex,
              attemptStartedAt,
              bytesSent,
              bytesReceived,
              completedAt,
            }),
          )
          .catch((usageError: unknown) => options.logger.error("Usage record persistence failed", { error: usageError }));
        options.operationFinished(outcome, error);
      };
      options.clientSocket.once("close", () => finishTunnel("success"));
      options.clientSocket.once("error", (error) => finishTunnel("failure", error));
      opened.socket.once("error", (error) => finishTunnel("failure", error));
      options.logger.info("Proxy tunnel opened", {
        logicalOperationId: options.operationId,
        upstreamAttemptId: attemptId,
        routeId: route.id,
        accessGrantId: route.accessGrantId,
        userId: route.userId,
        customerId: route.customerId,
        provider: activeUpstream.provider,
        endpointId: activeUpstream.endpointId,
        ...assignmentLogContext(activeUpstream.assignment),
        dataPlaneProtocol: protocol,
        targetHost: target.host,
        targetPort: target.port,
      });
      return;
    } catch (error) {
      budget.finish();
      await options.routes.recordCandidateFailure(upstream, error).catch(() => undefined);
      await options.routes.releaseCandidate(upstream).catch(() => undefined);
      lastError = error;
      const failedAssignment = assignmentFromError(error);
      if (failedAssignment !== undefined) {
        attemptSpan.setAttributes(assignmentAttributes(failedAssignment));
        options.telemetry.recordCandidateEvent(attemptSpan, providerIdFromError(error) ?? "unresolved", "verification", failedAssignment);
        options.logger.warn("Upstream candidate verification failed", {
          logicalOperationId: options.operationId,
          upstreamAttemptId: attemptId,
          routeId: route.id,
          accessGrantId: route.accessGrantId,
          provider: providerIdFromError(error),
          ...assignmentLogContext(failedAssignment),
        });
      }
      if (upstream !== undefined) resolutionState.excludedEndpointIds.add(upstream.endpointId);
      const retry = !options.callerSignal.aborted && attemptIndex + 1 < maxAttempts && isRetryableUpstreamFailure(error);
      const attemptedProvider = upstream?.provider ?? providerIdFromError(error);
      const outcome = retry ? "retry" : "failure";
      options.telemetry.finishAttempt(
        attemptSpan,
        attemptStartedAt,
        {
          provider: attemptedProvider ?? "unresolved",
          protocol,
          outcome,
          "proxy.failover": attemptedProvider !== undefined && attemptedProvider !== route.provider,
          "proxy.bytes_sent": 0,
          "proxy.bytes_received": 0,
        },
        error,
        passiveContext(route),
      );
      options.logger.warn(protocol === "socks5" ? "SOCKS5 tunnel establishment failed" : "Proxy tunnel establishment failed", {
        logicalOperationId: options.operationId,
        upstreamAttemptId: attemptId,
        routeId: route.id,
        accessGrantId: route.accessGrantId,
        userId: route.userId,
        customerId: route.customerId,
        provider: attemptedProvider,
        endpointId: upstream?.endpointId,
        dataPlaneProtocol: protocol,
        targetHost: target.host,
        targetPort: target.port,
        outcome,
        retryIndex: attemptIndex,
        failover: attemptedProvider !== undefined && attemptedProvider !== route.provider,
      });
      const completedAt = new Date().toISOString();
      void options.routes
        .recordUsage(
          failedUsage(route, upstream, resolutionState, {
            attemptId,
            operationId: options.operationId,
            protocol,
            outcome,
            attemptIndex,
            attemptStartedAt,
            attemptedProvider,
            completedAt,
          }),
        )
        .catch((usageError: unknown) => options.logger.error("Usage record persistence failed", { error: usageError }));
      if (!retry) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ProviderUnavailableError(
        protocol === "socks5" ? "No provider could establish the SOCKS5 tunnel" : "No provider could establish the tunnel",
      );
}
