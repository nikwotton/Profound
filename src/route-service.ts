import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AppError,
  AuthenticationError,
  NotFoundError,
  ProviderUnavailableError,
  attributeAssignment,
  attributeProvider,
  safeErrorMessage,
} from "./errors.js";
import { abortReason } from "./establishment-budget.js";
import type { Logger } from "./logger.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { ProxidizeAdapter } from "./providers/proxidize.js";
import { DEPLOYMENT_POLL_INTERVAL_MS } from "./release-policy.js";
import { toPublicAccessGrant, toPublicRoute, type RouteStore } from "./store.js";
import { Telemetry } from "./telemetry.js";
import type {
  AuthenticatedRoute,
  ActiveTunnel,
  DataPlaneProtocol,
  ListenAddress,
  ProviderDescriptor,
  ProviderClass,
  ProviderHealth,
  ProviderId,
  ProxyTarget,
  PublicAccessGrant,
  PublicAccessGrantCredential,
  PublicRoute,
  RetryPolicy,
  RouteProfile,
  StoredRoute,
  UpstreamEndpoint,
  UsageRecord,
} from "./types.js";
import { validateRouteProfile } from "./validation.js";

export interface CreatedRoute {
  route: PublicRoute;
  accessGrant: PublicAccessGrant;
  credential: PublicAccessGrantCredential;
  proxyUsername: string;
  proxyUrls: {
    http: string;
    socks5: string;
  };
}

export interface IssuedAccessGrant {
  accessGrant: PublicAccessGrant;
  credential: PublicAccessGrantCredential;
  proxyUsername: string;
  proxyUrls: {
    http: string;
    socks5: string;
  };
}

export interface ResolutionState {
  readonly attemptsByProvider: Map<ProviderId, number>;
  readonly excludedEndpointIds: Set<string>;
  previousCandidateId?: string;
  previousProvider?: ProviderId;
}

const MAX_PROVIDERS_PER_OPERATION = 3;
const MAX_PEERS_PER_PROVIDER = 2;
const MAX_VERIFICATION_CANDIDATES_PER_PROVIDER = 2;

export interface ResolutionContext {
  logicalOperationId: string;
  signal: AbortSignal;
}

function canonicalCity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function compatible(provider: ProviderAdapter, route: RouteProfile, protocol?: DataPlaneProtocol, target?: ProxyTarget): boolean {
  const capabilities = provider.descriptor.capabilities;
  if (protocol !== undefined && !capabilities.clientProtocols.has(protocol)) return false;
  if (protocol === undefined && !route.allowedProtocols.some((candidate) => capabilities.clientProtocols.has(candidate))) {
    return false;
  }
  if (route.isAuthenticated ? !capabilities.authenticatedTraffic : !capabilities.unauthenticatedTraffic) return false;
  if (route.session.mode === "sticky" && !capabilities.sessions) return false;
  if (route.isAuthenticated && capabilities.exactCity === "unsupported") return false;
  if (!capabilities.rotation.has(route.rotation.mode)) return false;
  if (target !== undefined && capabilities.targetPorts !== "any_public" && !capabilities.targetPorts.has(target.port)) {
    return false;
  }
  if (capabilities.countries !== undefined && !capabilities.countries.has(route.targeting.country)) return false;
  return Object.entries(route.targeting).every(
    ([key, value]) => value === undefined || capabilities.geography.has(key as keyof RouteProfile["targeting"]),
  );
}

function preferredProviderClass(route: Pick<RouteProfile, "isAuthenticated">): ProviderClass {
  return route.isAuthenticated ? "device_backed" : "residential";
}

function compareProviders(
  left: ProviderAdapter,
  right: ProviderAdapter,
  route: Pick<RouteProfile, "isAuthenticated">,
  currentProvider?: ProviderId,
): number {
  const preferredClass = preferredProviderClass(route);
  const classDifference =
    Number(left.descriptor.providerClass !== preferredClass) - Number(right.descriptor.providerClass !== preferredClass);
  if (classDifference !== 0) return classDifference;
  if (left.descriptor.id === currentProvider) return -1;
  if (right.descriptor.id === currentProvider) return 1;
  return left.descriptor.costRank - right.descriptor.costRank;
}

export class RouteService {
  readonly #providers: ReadonlyMap<ProviderId, ProviderAdapter>;
  readonly #activeByRoute = new Map<string, Set<() => void>>();
  readonly #activeByGrant = new Map<string, Set<() => void>>();
  readonly #activeByLease = new Map<string, Set<() => void>>();

  constructor(
    private readonly store: RouteStore,
    brightData: ProviderAdapter,
    private readonly proxidize: ProxidizeAdapter,
    private readonly proxyAddresses: () => { http: ListenAddress; socks5: ListenAddress },
    private readonly advertisedProxyHost: string,
    private readonly advertisedHttpProxyProtocol: "http" | "https",
    private readonly logger: Logger,
    private readonly telemetry: Telemetry,
    private readonly retryDefaults: RetryPolicy,
    private readonly deviceLeaseIdleTimeoutMs: number,
    private readonly deploymentId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.#providers = new Map([
      [brightData.descriptor.id, brightData],
      [proxidize.descriptor.id, proxidize],
    ]);
  }

  #leaseKey(route: Pick<AuthenticatedRoute, "accessGrantId" | "session">): string {
    const identity =
      route.session.mode === "sticky" && route.session.id !== undefined
        ? `grant\0${route.accessGrantId}\0session\0${route.session.id}`
        : `grant\0${route.accessGrantId}`;
    return createHash("sha256").update(identity).digest("hex");
  }

  #routeForGrant(route: StoredRoute, grant: { id: string; principalId: string; endpointId?: string }): AuthenticatedRoute {
    const { endpointId: _routeEndpointId, ...profile } = route;
    return {
      ...profile,
      userId: grant.principalId,
      accessGrantId: grant.id,
      ...(grant.endpointId === undefined ? {} : { endpointId: grant.endpointId }),
    };
  }

  async #ensureDeviceLease(route: AuthenticatedRoute): Promise<{ route: AuthenticatedRoute; leaseKey: string }> {
    const leaseKey = this.#leaseKey(route);
    const endpoints = (await this.proxidize.listEndpoints(true))
      .filter((endpoint) => endpoint.healthy && this.proxidize.matches(endpoint, route))
      .sort((left, right) => left.id.localeCompare(right.id));
    const lease = await this.store.acquireDeviceLease(
      leaseKey,
      route.id,
      endpoints.map((endpoint) => endpoint.id),
      new Date(this.now()).toISOString(),
      this.deviceLeaseIdleTimeoutMs,
    );
    if (lease === undefined) {
      throw new ProviderUnavailableError("No healthy unleased mobile device matches the route policy");
    }
    if (route.endpointId !== lease.endpointId) await this.proxidize.setRotationInterval(lease.endpointId, undefined);
    let current = route;
    if (route.endpointId !== lease.endpointId) {
      const grant = await this.store.setAccessGrantEndpoint(route.accessGrantId, lease.endpointId);
      current = this.#routeForGrant(await this.store.get(route.id), grant);
    }
    return { route: current, leaseKey };
  }

  descriptors(): ProviderDescriptor[] {
    return [...this.#providers.values()].map((provider) => provider.descriptor);
  }

  async create(input: unknown, userId: string): Promise<CreatedRoute> {
    const profile = validateRouteProfile(input, userId, this.retryDefaults);
    const id = randomUUID();
    const candidates = [...this.#providers.values()]
      .filter((provider) => compatible(provider, profile))
      .filter((provider) => profile.forceProvider === undefined || provider.descriptor.id === profile.forceProvider)
      .sort((left, right) => compareProviders(left, right, profile));
    const providerAdapter = candidates[0];
    if (providerAdapter === undefined) {
      const qualifier = profile.forceProvider === undefined ? "route policy" : `forced provider ${profile.forceProvider}`;
      throw new ProviderUnavailableError(`No configured provider is compatible with the ${qualifier}`);
    }
    const provider = providerAdapter.descriptor.id;
    const stored = await this.store.create(id, profile, provider);
    const issued = await this.#issueAccessGrant(id, userId);
    let assigned = this.#routeForGrant(stored, await this.store.getAccessGrant(issued.accessGrant.id));
    if (provider === "proxidize") {
      try {
        const leased = await this.#ensureDeviceLease(assigned);
        assigned = leased.route;
      } catch (error) {
        await this.store.revokeAccessGrant(issued.accessGrant.id, false).catch(() => undefined);
        await this.store.revoke(id, false).catch(() => undefined);
        throw error;
      }
    }
    this.logger.info("Route created", {
      routeId: id,
      accessGrantId: issued.accessGrant.id,
      userId,
      customerId: profile.customerId,
      provider,
      endpointId: assigned.endpointId,
      isAuthenticated: profile.isAuthenticated,
    });
    return { route: toPublicRoute(assigned), ...issued };
  }

  #proxyCredentials(grantId: string, token: string): Omit<IssuedAccessGrant, "accessGrant" | "credential"> {
    const addresses = this.proxyAddresses();
    const credentials = `${encodeURIComponent(grantId)}:${encodeURIComponent(token)}`;
    const proxyUrls = {
      http: `${this.advertisedHttpProxyProtocol}://${credentials}@${this.advertisedProxyHost}:${addresses.http.port}`,
      // socks5h asks URL-aware clients to preserve domain names for proxy-side resolution.
      socks5: `socks5h://${credentials}@${this.advertisedProxyHost}:${addresses.socks5.port}`,
    };
    return { proxyUsername: grantId, proxyUrls };
  }

  async #issueAccessGrant(routeId: string, principalId: string): Promise<IssuedAccessGrant> {
    await this.store.get(routeId);
    const grantId = randomUUID();
    const credentialId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const grant = await this.store.createAccessGrant(grantId, routeId, principalId, credentialId, token);
    const accessGrant = toPublicAccessGrant(grant);
    this.logger.info("Access grant issued", { routeId, accessGrantId: grantId, userId: principalId });
    return {
      accessGrant,
      credential: accessGrant.credentials.find((candidate) => candidate.id === credentialId)!,
      ...this.#proxyCredentials(grantId, token),
    };
  }

  async createAccessGrant(routeId: string, principalId: string): Promise<IssuedAccessGrant> {
    return this.#issueAccessGrant(routeId, principalId);
  }

  async listAccessGrants(routeId: string, principalId: string): Promise<PublicAccessGrant[]> {
    return (await this.store.listAccessGrants(routeId, principalId)).map(toPublicAccessGrant);
  }

  async rotateAccessGrantCredential(id: string, principalId: string, suspectedCompromise = false): Promise<IssuedAccessGrant> {
    const existing = await this.#ownedAccessGrant(id, principalId);
    const credentialId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const rotated = await this.store.rotateAccessGrantCredential(existing.id, credentialId, token, suspectedCompromise);
    const accessGrant = toPublicAccessGrant(rotated);
    this.logger.info("Access grant credential rotated", {
      routeId: existing.routeId,
      accessGrantId: existing.id,
      userId: principalId,
      suspectedCompromise,
    });
    return {
      accessGrant,
      credential: accessGrant.credentials.find((candidate) => candidate.id === credentialId)!,
      ...this.#proxyCredentials(rotated.id, token),
    };
  }

  async revokeAccessGrant(id: string, principalId: string, terminateActive = false): Promise<void> {
    const grant = await this.#ownedAccessGrant(id, principalId, true);
    await this.store.revokeAccessGrant(id, terminateActive);
    if (terminateActive) this.#terminate(this.#activeByGrant.get(id));
    this.logger.info("Access grant revoked", {
      routeId: grant.routeId,
      accessGrantId: id,
      userId: principalId,
      terminateActive,
    });
  }

  async #ownedAccessGrant(id: string, principalId: string, includeRevoked = false) {
    const grant = await this.store.getAccessGrant(id, includeRevoked);
    if (grant.principalId !== principalId) throw new NotFoundError();
    return grant;
  }

  async list(): Promise<PublicRoute[]> {
    return (await this.store.list()).map(toPublicRoute);
  }

  async get(id: string): Promise<PublicRoute> {
    return toPublicRoute(await this.store.get(id));
  }

  async delete(id: string): Promise<void> {
    await this.store.revoke(id, false);
    this.logger.info("Route revoked", { routeId: id });
  }

  async emergencyRevoke(id: string): Promise<void> {
    await this.store.revoke(id, true);
    this.#terminate(this.#activeByRoute.get(id));
    this.logger.warn("Route emergency-revoked; active connections terminated", { routeId: id });
  }

  async releaseDeviceLease(id: string, principalId: string): Promise<void> {
    const grant = await this.#ownedAccessGrant(id, principalId);
    const route = this.#routeForGrant(await this.store.get(grant.routeId, true), grant);
    const leaseKey = this.#leaseKey(route);
    await this.store.releaseDeviceLease(leaseKey);
    if (grant.status !== "revoked") await this.store.setAccessGrantEndpoint(id, undefined);
    this.#terminate(this.#activeByLease.get(leaseKey));
    this.logger.info("Device lease explicitly released", { routeId: route.id, accessGrantId: id });
  }

  #terminate(callbacks: Set<() => void> | undefined): void {
    for (const terminate of [...(callbacks ?? [])]) terminate();
  }

  async trackActiveConnection(
    routeId: string,
    accessGrantId: string,
    protocol: DataPlaneProtocol,
    upstream: UpstreamEndpoint,
    terminate: () => void,
  ): Promise<() => void> {
    const tunnelProtocol = protocol === "http" ? undefined : protocol;
    const activeTunnelId = tunnelProtocol === undefined ? undefined : randomUUID();
    if (activeTunnelId !== undefined) {
      const now = new Date(this.now()).toISOString();
      const tunnel: ActiveTunnel = {
        id: activeTunnelId,
        deploymentId: this.deploymentId,
        routeId,
        accessGrantId,
        protocol: tunnelProtocol!,
        provider: upstream.provider,
        ...(upstream.endpointId === undefined ? {} : { endpointId: upstream.endpointId }),
        startedAt: now,
        lastHeartbeatAt: now,
        expiresAt: new Date(this.now() + 120_000).toISOString(),
      };
      await this.store.registerActiveTunnel(tunnel);
    }
    const routeCallbacks = this.#activeByRoute.get(routeId) ?? new Set<() => void>();
    routeCallbacks.add(terminate);
    this.#activeByRoute.set(routeId, routeCallbacks);
    const grantCallbacks = this.#activeByGrant.get(accessGrantId) ?? new Set<() => void>();
    grantCallbacks.add(terminate);
    this.#activeByGrant.set(accessGrantId, grantCallbacks);
    const leaseKey = upstream.deviceLeaseKey;
    if (leaseKey !== undefined) {
      const leaseCallbacks = this.#activeByLease.get(leaseKey) ?? new Set<() => void>();
      leaseCallbacks.add(terminate);
      this.#activeByLease.set(leaseKey, leaseCallbacks);
    }
    let finished = false;
    let nextHeartbeatAt = 0;
    let nextTunnelHeartbeatAt = 0;
    let nextDeploymentCheckAt = 0;
    const heartbeatIntervalMs = Math.min(30_000, Math.max(1_000, Math.floor(this.deviceLeaseIdleTimeoutMs / 3)));
    const check = async (): Promise<void> => {
      if (finished) return;
      if (await this.store.shouldTerminateActive(routeId, accessGrantId)) {
        terminate();
        return;
      }
      if (this.now() >= nextDeploymentCheckAt) {
        nextDeploymentCheckAt = this.now() + DEPLOYMENT_POLL_INTERVAL_MS;
        if (await this.store.shouldTerminateDeployment(this.deploymentId)) {
          terminate();
          return;
        }
      }
      if (activeTunnelId !== undefined && this.now() >= nextTunnelHeartbeatAt) {
        nextTunnelHeartbeatAt = this.now() + 30_000;
        const heartbeat = new Date(this.now()).toISOString();
        await this.store.heartbeatActiveTunnel(activeTunnelId, heartbeat, new Date(this.now() + 120_000).toISOString());
      }
      if (leaseKey !== undefined && this.now() >= nextHeartbeatAt) {
        nextHeartbeatAt = this.now() + heartbeatIntervalMs;
        const now = new Date(this.now()).toISOString();
        const activeUntil = new Date(this.now() + Math.max(60_000, heartbeatIntervalMs * 2)).toISOString();
        const lease = await this.store.renewDeviceLease(leaseKey, now, activeUntil, false);
        if (lease === undefined) terminate();
      } else if (leaseKey !== undefined && (await this.store.getDeviceLease(leaseKey)) === undefined) {
        terminate();
      }
    };
    void check().catch(() => terminate());
    const interval = setInterval(() => void check().catch(() => terminate()), Math.min(1_000, heartbeatIntervalMs));
    interval.unref();
    return () => {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      routeCallbacks.delete(terminate);
      if (routeCallbacks.size === 0) this.#activeByRoute.delete(routeId);
      grantCallbacks.delete(terminate);
      if (grantCallbacks.size === 0) this.#activeByGrant.delete(accessGrantId);
      if (leaseKey !== undefined) {
        const leaseCallbacks = this.#activeByLease.get(leaseKey);
        leaseCallbacks?.delete(terminate);
        if (leaseCallbacks?.size === 0) this.#activeByLease.delete(leaseKey);
        const now = new Date(this.now()).toISOString();
        void this.store.renewDeviceLease(leaseKey, now, now, true).catch(() => undefined);
      }
      if (activeTunnelId !== undefined) void this.store.removeActiveTunnel(activeTunnelId).catch(() => undefined);
    };
  }

  async recordUsage(record: Omit<UsageRecord, "kind" | "pricingVersion" | "pricingModel" | "priceUsd">): Promise<boolean> {
    const descriptor = record.provider === "unresolved" ? undefined : this.#providers.get(record.provider)?.descriptor;
    return this.store.recordUsage({
      ...record,
      kind: "attempt",
      ...(descriptor === undefined
        ? {}
        : {
            pricingVersion: descriptor.pricing.version,
            pricingModel: descriptor.pricing.model,
            priceUsd: descriptor.pricing.amountUsd,
          }),
    });
  }

  async authenticate(id: string, token: string): Promise<AuthenticatedRoute> {
    const grant = await this.store.authenticateAccessGrant(id, token);
    if (grant === undefined) throw new AuthenticationError();
    return this.#routeForGrant(await this.store.get(grant.routeId), grant);
  }

  createResolutionState(): ResolutionState {
    return { attemptsByProvider: new Map(), excludedEndpointIds: new Set() };
  }

  assertProtocolAllowed(route: StoredRoute, protocol: DataPlaneProtocol): void {
    if (!route.allowedProtocols.includes(protocol)) {
      throw new AppError(`Route does not allow the ${protocol} data-plane protocol`, "protocol_not_allowed", 403);
    }
  }

  async assertNewConnectionAllowed(routeId: string, accessGrantId: string): Promise<void> {
    const current = await this.store.get(routeId);
    if (current.status !== "ready") throw new ProviderUnavailableError(`Route is ${current.status}`);
    const grant = await this.store.getAccessGrant(accessGrantId);
    if (grant.routeId !== routeId || grant.status !== "ready") throw new AuthenticationError();
  }

  async resolve(
    route: AuthenticatedRoute,
    protocol: DataPlaneProtocol,
    target: ProxyTarget,
    state: ResolutionState,
    context: ResolutionContext,
  ): Promise<UpstreamEndpoint> {
    const grant = await this.store.getAccessGrant(route.accessGrantId);
    let current = this.#routeForGrant(await this.store.get(route.id), grant);
    if (current.status !== "ready") throw new ProviderUnavailableError(`Route is ${current.status}`);
    current = this.#routeForGrant(
      await this.#applyScheduledRotation(current, context),
      await this.store.getAccessGrant(route.accessGrantId),
    );
    this.assertProtocolAllowed(current, protocol);
    const compatibleProviders = [...this.#providers.values()]
      .filter((provider) => compatible(provider, current, protocol, target))
      .filter((provider) => current.forceProvider === undefined || provider.descriptor.id === current.forceProvider)
      .sort((left, right) => compareProviders(left, right, current, current.provider))
      .slice(0, MAX_PROVIDERS_PER_OPERATION);
    if (compatibleProviders.length === 0) {
      const suffix = current.forceProvider === undefined ? "" : "; forced-provider fallback is disabled";
      throw new ProviderUnavailableError(`No compatible provider is available${suffix}`);
    }
    for (const provider of compatibleProviders) {
      const attempts = state.attemptsByProvider.get(provider.descriptor.id) ?? 0;
      const attemptLimit =
        current.isAuthenticated && provider.descriptor.capabilities.exactCity === "verifiable"
          ? MAX_VERIFICATION_CANDIDATES_PER_PROVIDER
          : MAX_PEERS_PER_PROVIDER;
      if (attempts >= attemptLimit) continue;
      const health = await provider.health(context.signal);
      if (context.signal.aborted) throw abortReason(context.signal);
      if (health.state === "unhealthy") {
        state.attemptsByProvider.set(provider.descriptor.id, attemptLimit);
        continue;
      }
      state.attemptsByProvider.set(provider.descriptor.id, attempts + 1);
      let deviceLeaseKey: string | undefined;
      if (provider.descriptor.id === "proxidize") {
        const leased = await this.#ensureDeviceLease(current);
        current = leased.route;
        deviceLeaseKey = leased.leaseKey;
      }
      let endpoint: UpstreamEndpoint;
      try {
        endpoint = await provider.resolve(current, {
          dataPlaneProtocol: protocol,
          target,
          logicalOperationId: context.logicalOperationId,
          candidateIndex: attempts,
          signal: context.signal,
          excludedEndpointIds: state.excludedEndpointIds,
        });
      } catch (error) {
        throw attributeProvider(error, provider.descriptor.id);
      }
      if (!provider.descriptor.capabilities.upstreamProtocols.has(endpoint.protocol)) {
        throw new ProviderUnavailableError("Provider returned an undeclared upstream proxy protocol");
      }
      if (deviceLeaseKey !== undefined) endpoint.deviceLeaseKey = deviceLeaseKey;
      if (current.isAuthenticated && provider.descriptor.capabilities.exactCity === "verifiable") {
        const expected = endpoint.assignment.expectedCity;
        const observed = endpoint.assignment.observedCity;
        if (
          endpoint.assignment.assignmentMode !== "service_verified" ||
          expected === undefined ||
          observed === undefined ||
          canonicalCity(expected) !== canonicalCity(observed)
        ) {
          state.excludedEndpointIds.add(endpoint.endpointId);
          state.previousCandidateId = endpoint.assignment.candidateId;
          state.previousProvider = endpoint.provider;
          throw attributeProvider(
            attributeAssignment(new ProviderUnavailableError("Candidate exact-city verification failed"), endpoint.assignment),
            provider.descriptor.id,
          );
        }
      }
      if (state.previousCandidateId !== undefined) {
        endpoint.assignment.previousCandidateId = state.previousCandidateId;
      }
      endpoint.assignment.changeReason =
        state.previousProvider === undefined ? "selection" : state.previousProvider === endpoint.provider ? "retry" : "failover";
      state.previousCandidateId = endpoint.assignment.candidateId;
      state.previousProvider = endpoint.provider;
      return endpoint;
    }
    const suffix = current.forceProvider === undefined ? "" : "; forced-provider fallback is disabled";
    throw new ProviderUnavailableError(`No compatible healthy provider is available${suffix}`);
  }

  async #applyScheduledRotation(route: StoredRoute, context: ResolutionContext): Promise<StoredRoute> {
    if (route.provider !== "proxidize" || route.rotation.mode !== "interval") return route;
    if (context.signal.aborted) throw new ProviderUnavailableError("Candidate establishment was cancelled");
    const dueBefore = new Date(this.now() - route.rotation.intervalSeconds * 1_000).toISOString();
    if (route.lastRotationAt > dueBefore) return route;
    const claimed = await this.store.claimScheduledRotation(route.id, dueBefore);
    if (claimed === undefined) {
      const current = await this.store.get(route.id);
      if (current.status !== "ready") throw new ProviderUnavailableError(`Route is ${current.status}`);
      return current;
    }
    const rotationStartedAt = Date.now();
    const rotationSpan = this.telemetry.startSpan("proxy.rotation", {
      "proxy.operation.id": context.logicalOperationId,
      "proxy.route.id": route.id,
      provider: route.provider,
      "proxy.candidate.id": route.endpointId ?? "unknown",
    });
    try {
      await this.proxidize.rotate(
        { ...claimed, ...(route.endpointId === undefined ? {} : { endpointId: route.endpointId }) },
        context.signal,
      );
      const completed = await this.store.completeRotation(route.id);
      rotationSpan.addEvent("proxy.candidate.rotation", {
        "proxy.candidate.id": route.endpointId ?? "unknown",
        "proxy.assignment.change_reason": "rotation",
      });
      this.telemetry.finishSpan(rotationSpan, rotationStartedAt, {
        plane: "control",
        protocol: "rotation",
        outcome: "success",
        provider: route.provider,
      });
      this.telemetry.recordRotation(route.provider, "success");
      this.logger.info("Scheduled route rotation completed", {
        logicalOperationId: context.logicalOperationId,
        routeId: route.id,
        provider: route.provider,
        endpointId: route.endpointId,
        changeReason: "rotation",
      });
      return completed;
    } catch (error) {
      await this.store.setStatus(route.id, "failed", safeErrorMessage(error)).catch(() => undefined);
      this.telemetry.finishSpan(
        rotationSpan,
        rotationStartedAt,
        {
          plane: "control",
          protocol: "rotation",
          outcome: "failure",
          provider: route.provider,
        },
        error,
      );
      this.telemetry.recordRotation(route.provider, "failure");
      throw error;
    }
  }

  async rotate(id: string, principalId: string): Promise<PublicRoute> {
    const grant = (await this.store.listAccessGrants(id, principalId))[0];
    if (grant === undefined) throw new NotFoundError();
    let route: AuthenticatedRoute = this.#routeForGrant(await this.store.get(id), grant);
    if (route.provider === "proxidize") route = (await this.#ensureDeviceLease(route)).route;
    await this.store.setStatus(id, "rotating");
    setImmediate(() => void this.#performRotation(route));
    return toPublicRoute(await this.store.get(id));
  }

  async #performRotation(route: StoredRoute): Promise<void> {
    const rotationOperationId = randomUUID();
    const rotationStartedAt = Date.now();
    const rotationSpan = this.telemetry.startSpan("proxy.rotation", {
      "proxy.operation.id": rotationOperationId,
      "proxy.route.id": route.id,
      provider: route.provider,
      "proxy.candidate.id": route.endpointId ?? "unknown",
    });
    try {
      const provider = this.#providers.get(route.provider);
      if (provider === undefined) throw new ProviderUnavailableError("Route provider is not configured");
      if (route.provider === "bright_data") await this.store.incrementRotationEpoch(route.id);
      await provider.rotate({
        ...(await this.store.get(route.id)),
        ...(route.endpointId === undefined ? {} : { endpointId: route.endpointId }),
      });
      await this.store.completeRotation(route.id);
      rotationSpan.addEvent("proxy.candidate.rotation", {
        "proxy.candidate.id": route.endpointId ?? "unknown",
        "proxy.assignment.change_reason": "rotation",
      });
      this.telemetry.finishSpan(rotationSpan, rotationStartedAt, {
        plane: "control",
        protocol: "rotation",
        outcome: "success",
        provider: route.provider,
      });
      this.telemetry.recordRotation(route.provider, "success");
      this.logger.info("Route rotation completed", {
        logicalOperationId: rotationOperationId,
        routeId: route.id,
        provider: route.provider,
        endpointId: route.endpointId,
        changeReason: "rotation",
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.store.setStatus(route.id, "failed", message).catch(() => undefined);
      this.telemetry.finishSpan(
        rotationSpan,
        rotationStartedAt,
        {
          plane: "control",
          protocol: "rotation",
          outcome: "failure",
          provider: route.provider,
        },
        error,
      );
      this.telemetry.recordRotation(route.provider, "failure");
      this.logger.warn("Route rotation failed", {
        logicalOperationId: rotationOperationId,
        routeId: route.id,
        provider: route.provider,
        endpointId: route.endpointId,
        changeReason: "rotation",
      });
    }
  }

  async refreshHealth(): Promise<ProviderHealth[]> {
    const health = await Promise.all([...this.#providers.values()].map((provider) => provider.health()));
    await Promise.all(health.map((item) => this.store.saveHealth(item)));
    return health;
  }

  async storedHealth(): Promise<ProviderHealth[]> {
    return this.store.listHealth();
  }

  async ready(): Promise<boolean> {
    return (await this.refreshHealth()).some((item) => item.state !== "unhealthy");
  }
}
