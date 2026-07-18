import { randomUUID } from "node:crypto";
import { DEPLOYMENT_POLL_INTERVAL_MS } from "./release-policy.js";
import { TRANSPORT_POLICY } from "./service-policies.js";
import type { RoutingStore } from "./store.js";
import { ACTIVE_CONNECTION_TTL_MS } from "./types.js";
import type { ActiveTunnel, DataPlaneProtocol, UpstreamEndpoint } from "./types.js";

interface TrackedConnection {
  routeId: string;
  accessGrantId: string;
  sessionId?: string;
  terminate: () => void;
  nextHeartbeatAt: number;
}

export class ActiveConnectionTracker {
  readonly #activeByRoute = new Map<string, Set<() => void>>();
  readonly #activeByGrant = new Map<string, Set<() => void>>();
  readonly #activeBySession = new Map<string, Set<() => void>>();
  readonly #connections = new Map<string, TrackedConnection>();
  #pollTimer: NodeJS.Timeout | undefined;
  #polling = false;
  #authorizationEpoch = -1;
  #nextDeploymentCheckAt = 0;

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

  canAcceptConnection(): boolean {
    return this.#connections.size < TRANSPORT_POLICY.maxActiveConnectionsPerTask;
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
    this.#connections.set(activeConnectionId, {
      routeId,
      accessGrantId,
      ...(sessionId === undefined ? {} : { sessionId }),
      terminate,
      nextHeartbeatAt: this.now() + 30_000,
    });
    this.#startPoller();
    return () => {
      if (finished) return;
      finished = true;
      this.#connections.delete(activeConnectionId);
      this.#stopPollerWhenIdle();
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

  #startPoller(): void {
    if (this.#pollTimer !== undefined) return;
    void this.#poll().catch(() => this.#terminateAll());
    this.#pollTimer = setInterval(() => void this.#poll().catch(() => this.#terminateAll()), 1_000);
    this.#pollTimer.unref();
  }

  #stopPollerWhenIdle(): void {
    if (this.#connections.size > 0 || this.#pollTimer === undefined) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#connections.size === 0) return;
    this.#polling = true;
    try {
      const epoch = await this.store.getAuthorizationEpoch();
      if (epoch !== this.#authorizationEpoch) {
        this.#authorizationEpoch = epoch;
        const unique = new Map<string, TrackedConnection>();
        for (const connection of this.#connections.values()) {
          unique.set(`${connection.routeId}\0${connection.accessGrantId}\0${connection.sessionId ?? ""}`, connection);
        }
        await Promise.all(
          [...unique.values()].map(async (connection) => {
            if (await this.store.shouldTerminateActive(connection.routeId, connection.accessGrantId, connection.sessionId)) {
              connection.terminate();
            }
          }),
        );
      }
      if (this.now() >= this.#nextDeploymentCheckAt) {
        this.#nextDeploymentCheckAt = this.now() + DEPLOYMENT_POLL_INTERVAL_MS;
        if (await this.store.shouldTerminateDeployment(this.deploymentId)) this.#terminateAll();
      }
      const heartbeat = new Date(this.now()).toISOString();
      await Promise.all(
        [...this.#connections.entries()].map(async ([id, connection]) => {
          if (this.now() < connection.nextHeartbeatAt) return;
          connection.nextHeartbeatAt = this.now() + 30_000;
          await this.store.heartbeatActiveTunnel(id, heartbeat, new Date(this.now() + ACTIVE_CONNECTION_TTL_MS).toISOString());
        }),
      );
    } finally {
      this.#polling = false;
    }
  }

  #terminateAll(): void {
    for (const connection of this.#connections.values()) connection.terminate();
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
