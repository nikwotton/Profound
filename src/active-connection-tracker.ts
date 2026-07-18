import { randomUUID } from "node:crypto";
import { DEPLOYMENT_POLL_INTERVAL_MS } from "./release-policy.js";
import type { RoutingStore } from "./store.js";
import { ACTIVE_CONNECTION_TTL_MS } from "./types.js";
import type { ActiveTunnel, DataPlaneProtocol, UpstreamEndpoint } from "./types.js";

export class ActiveConnectionTracker {
  readonly #activeByRoute = new Map<string, Set<() => void>>();
  readonly #activeByGrant = new Map<string, Set<() => void>>();
  readonly #activeBySession = new Map<string, Set<() => void>>();

  constructor(
    private readonly store: RoutingStore,
    private readonly deploymentId: string,
    private readonly now: () => number,
  ) {}

  terminateRoute(routeId: string): void {
    this.#terminate(this.#activeByRoute.get(routeId));
  }

  terminateGrant(grantId: string): void {
    this.#terminate(this.#activeByGrant.get(grantId));
  }

  terminateSession(sessionId: string): void {
    this.#terminate(this.#activeBySession.get(sessionId));
  }

  async track(
    routeId: string,
    accessGrantId: string,
    sessionId: string | undefined,
    protocol: DataPlaneProtocol,
    upstream: UpstreamEndpoint,
    terminate: () => void,
  ): Promise<() => void> {
    const activeConnectionId = upstream.activeLoadClaimId ?? randomUUID();
    const now = new Date(this.now()).toISOString();
    const connection: ActiveTunnel = {
      id: activeConnectionId,
      deploymentId: this.deploymentId,
      routeId,
      accessGrantId,
      ...(sessionId === undefined ? {} : { sessionId }),
      protocol,
      provider: upstream.provider,
      endpointId: upstream.endpointId,
      ...(upstream.routingPolicyVersion === undefined ? {} : { routingPolicyVersion: upstream.routingPolicyVersion }),
      ...(upstream.routingScore === undefined ? {} : { routingScore: upstream.routingScore }),
      startedAt: now,
      lastHeartbeatAt: now,
      expiresAt: new Date(this.now() + ACTIVE_CONNECTION_TTL_MS).toISOString(),
    };
    if (upstream.activeLoadClaimId === undefined) await this.store.registerActiveTunnel(connection);
    else await this.store.heartbeatActiveTunnel(activeConnectionId, now, connection.expiresAt);
    upstream.upstreamConnectionId = activeConnectionId;
    upstream.upstreamConnectionStartedAt = now;
    const routeCallbacks = this.#callbacks(this.#activeByRoute, routeId);
    const grantCallbacks = this.#callbacks(this.#activeByGrant, accessGrantId);
    const sessionCallbacks = sessionId === undefined ? undefined : this.#callbacks(this.#activeBySession, sessionId);
    routeCallbacks.add(terminate);
    grantCallbacks.add(terminate);
    sessionCallbacks?.add(terminate);
    let finished = false;
    let nextTunnelHeartbeatAt = 0;
    let nextDeploymentCheckAt = 0;
    const check = async (): Promise<void> => {
      if (finished) return;
      if (await this.store.shouldTerminateActive(routeId, accessGrantId, sessionId)) return terminate();
      if (this.now() >= nextDeploymentCheckAt) {
        nextDeploymentCheckAt = this.now() + DEPLOYMENT_POLL_INTERVAL_MS;
        if (await this.store.shouldTerminateDeployment(this.deploymentId)) return terminate();
      }
      if (this.now() >= nextTunnelHeartbeatAt) {
        nextTunnelHeartbeatAt = this.now() + 30_000;
        const heartbeat = new Date(this.now()).toISOString();
        await this.store.heartbeatActiveTunnel(
          activeConnectionId,
          heartbeat,
          new Date(this.now() + ACTIVE_CONNECTION_TTL_MS).toISOString(),
        );
      }
    };
    void check().catch(() => terminate());
    const interval = setInterval(() => void check().catch(() => terminate()), 1_000);
    interval.unref();
    return () => {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      this.#remove(this.#activeByRoute, routeId, terminate);
      this.#remove(this.#activeByGrant, accessGrantId, terminate);
      if (sessionId !== undefined) this.#remove(this.#activeBySession, sessionId, terminate);
      void this.store.removeActiveTunnel(activeConnectionId).catch(() => undefined);
      if (sessionId !== undefined) void this.#recordDisconnect(sessionId);
    };
  }

  async release(upstream: UpstreamEndpoint | undefined): Promise<void> {
    if (upstream?.activeLoadClaimId === undefined) return;
    const claimId = upstream.activeLoadClaimId;
    delete upstream.activeLoadClaimId;
    await this.store.removeActiveTunnel(claimId);
  }

  #callbacks(index: Map<string, Set<() => void>>, id: string): Set<() => void> {
    const callbacks = index.get(id) ?? new Set<() => void>();
    index.set(id, callbacks);
    return callbacks;
  }

  #remove(index: Map<string, Set<() => void>>, id: string, callback: () => void): void {
    const callbacks = index.get(id);
    callbacks?.delete(callback);
    if (callbacks?.size === 0) index.delete(id);
  }

  #terminate(callbacks: Set<() => void> | undefined): void {
    for (const terminate of [...(callbacks ?? [])]) terminate();
  }

  async #recordDisconnect(sessionId: string): Promise<void> {
    const session = await this.store.getLogicalSession(sessionId).catch(() => undefined);
    if (session === undefined) return;
    const disconnectedAt = new Date(this.now()).toISOString();
    await this.store.saveLogicalSession(
      { ...session, lastDisconnectedAt: disconnectedAt, updatedAt: disconnectedAt },
      session.bindingVersion,
    );
  }
}
