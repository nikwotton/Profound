import { randomUUID } from "node:crypto";
import { AppError, NotFoundError, ProviderUnavailableError, safeErrorMessage } from "./errors.js";
import type { Logger } from "./logger.js";
import type { MobileProviderAdapter, ProviderAdapter } from "./providers/provider.js";
import { toPublicRoute, type RoutingStore } from "./store.js";
import type { Telemetry } from "./telemetry.js";
import type { AuthenticatedRoute, ProviderId, PublicRoute, StoredRoute } from "./types.js";

export interface RotationContext {
  logicalOperationId: string;
  signal: AbortSignal;
}

export interface RotationCoordinatorOptions {
  store: RoutingStore;
  providers: ReadonlyMap<ProviderId, ProviderAdapter>;
  proxidize: MobileProviderAdapter;
  logger: Logger;
  telemetry: Telemetry;
  now: () => number;
}

export class RotationCoordinator {
  constructor(private readonly options: RotationCoordinatorOptions) {}

  async applyScheduled(route: StoredRoute, context: RotationContext): Promise<StoredRoute> {
    if (route.provider !== "proxidize" || route.rotation.mode !== "interval") return route;
    if (context.signal.aborted) throw new ProviderUnavailableError("Candidate establishment was cancelled");
    const dueBefore = new Date(this.options.now() - route.rotation.intervalSeconds * 1_000).toISOString();
    if (route.lastRotationAt > dueBefore) return route;
    const claimed = await this.options.store.claimScheduledRotation(route.id, dueBefore);
    if (claimed === undefined) {
      const current = await this.options.store.get(route.id);
      if (current.status !== "ready") throw new ProviderUnavailableError(`Route is ${current.status}`);
      return current;
    }
    const rotationStartedAt = Date.now();
    const rotationSpan = this.options.telemetry.startSpan("proxy.rotation", {
      "proxy.operation.id": context.logicalOperationId,
      "proxy.route.id": route.id,
      provider: route.provider,
      "proxy.candidate.id": route.endpointId ?? "unknown",
    });
    try {
      await this.options.proxidize.rotate(
        { ...claimed, ...(route.endpointId === undefined ? {} : { endpointId: route.endpointId }) },
        context.signal,
      );
      const completed = await this.options.store.completeRotation(route.id);
      rotationSpan.addEvent("proxy.candidate.rotation", {
        "proxy.candidate.id": route.endpointId ?? "unknown",
        "proxy.assignment.change_reason": "rotation",
      });
      this.finishSpan(rotationSpan, rotationStartedAt, route, "success");
      this.options.logger.info("Scheduled route rotation completed", {
        logicalOperationId: context.logicalOperationId,
        routeId: route.id,
        provider: route.provider,
        endpointId: route.endpointId,
        changeReason: "rotation",
      });
      return completed;
    } catch (error) {
      await this.options.store.setStatus(route.id, "failed", safeErrorMessage(error)).catch(() => undefined);
      this.finishSpan(rotationSpan, rotationStartedAt, route, "failure", error);
      throw error;
    }
  }

  async request(id: string, principalId: string): Promise<PublicRoute> {
    const grant = (await this.options.store.listAccessGrants(id, principalId))[0];
    if (grant === undefined) throw new NotFoundError();
    const stored = await this.options.store.get(id);
    const { endpointId: _routeEndpointId, ...profile } = stored;
    void _routeEndpointId;
    const credential = grant.credentials.find((candidate) => candidate.status === "active");
    if (credential === undefined) throw new NotFoundError();
    const route: AuthenticatedRoute = {
      ...profile,
      userId: grant.principalId,
      accessGrantId: grant.id,
      credentialId: credential.id,
      sessionMode: credential.sessionMode,
      ...(credential.sessionId === undefined ? {} : { sessionId: credential.sessionId }),
      ...(grant.jobId === undefined ? {} : { jobId: grant.jobId }),
    };
    if (route.provider === "proxidize") {
      throw new AppError("Device-backed slot assignment and rerouting are internal", "rotation_not_supported", 409);
    }
    await this.options.store.setStatus(id, "rotating");
    setImmediate(() => void this.perform(route));
    return toPublicRoute(await this.options.store.get(id));
  }

  private async perform(route: StoredRoute): Promise<void> {
    const operationId = randomUUID();
    const startedAt = Date.now();
    const span = this.options.telemetry.startSpan("proxy.rotation", {
      "proxy.operation.id": operationId,
      "proxy.route.id": route.id,
      provider: route.provider,
      "proxy.candidate.id": route.endpointId ?? "unknown",
    });
    try {
      const provider = this.options.providers.get(route.provider);
      if (provider === undefined) throw new ProviderUnavailableError("Route provider is not configured");
      if (route.provider === "bright_data") await this.options.store.incrementRotationEpoch(route.id);
      await provider.rotate({
        ...(await this.options.store.get(route.id)),
        ...(route.endpointId === undefined ? {} : { endpointId: route.endpointId }),
      });
      await this.options.store.completeRotation(route.id);
      span.addEvent("proxy.candidate.rotation", {
        "proxy.candidate.id": route.endpointId ?? "unknown",
        "proxy.assignment.change_reason": "rotation",
      });
      this.finishSpan(span, startedAt, route, "success");
      this.options.logger.info("Route rotation completed", {
        logicalOperationId: operationId,
        routeId: route.id,
        provider: route.provider,
        endpointId: route.endpointId,
        changeReason: "rotation",
      });
    } catch (error) {
      await this.options.store.setStatus(route.id, "failed", safeErrorMessage(error)).catch(() => undefined);
      this.finishSpan(span, startedAt, route, "failure", error);
      this.options.logger.warn("Route rotation failed", {
        logicalOperationId: operationId,
        routeId: route.id,
        provider: route.provider,
        endpointId: route.endpointId,
        changeReason: "rotation",
      });
    }
  }

  private finishSpan(
    span: ReturnType<Telemetry["startSpan"]>,
    startedAt: number,
    route: StoredRoute,
    outcome: "success" | "failure",
    error?: unknown,
  ): void {
    this.options.telemetry.finishSpan(
      span,
      startedAt,
      { plane: "control", protocol: "rotation", outcome, provider: route.provider },
      error,
    );
    this.options.telemetry.recordRotation(route.provider, outcome);
  }
}
