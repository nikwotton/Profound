import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { ActiveConnectionTracker } from "./active-connection-tracker.js";
import { CAPACITY_POLICY } from "./capacity-policy.js";
import {
  AppError,
  AuthenticationError,
  ProviderOverrideUnsatisfiedError,
  ProviderUnavailableError,
  attributeAssignment,
  attributeProvider,
  isRetryableUpstreamFailure,
  safeErrorMessage,
  type RouteServiceError,
} from "./errors.js";
import { abortReason } from "./establishment-budget.js";
import type { Logger } from "./logger.js";
import type { MobileProviderAdapter, ProviderAdapter } from "./providers/provider.js";
import { preferredProviderClass, providerCompatible } from "./provider-selection.js";
import { RouteAdministrationService, type IssuedAccessGrant, type RouteServiceEffects } from "./route-administration.js";
import { MAX_PEERS_PER_PROVIDER, MAX_VERIFICATION_CANDIDATES_PER_PROVIDER, RoutingCandidateRanker } from "./routing-candidate-ranker.js";
import { createResolutionState, type ResolutionState } from "./routing-resolution.js";
import { ROUTING_POLICY, type RoutingScoreComponents, type ScoredRoutingCandidate } from "./routing-policy.js";
import { V0_POLICY } from "./service-policies.js";
import type { RoutingStore } from "./store.js";
import { Telemetry } from "./telemetry.js";
import type {
  AuthenticatedRoute,
  CapacityCircuitReason,
  CapacityCircuitState,
  DataPlaneProtocol,
  ProviderDescriptor,
  ProviderId,
  ProxyTarget,
  PublicAccessGrant,
  PublicAccessGrantCredential,
  PublicLogicalSession,
  PublicRoute,
  RetryPolicy,
  SessionMode,
  StoredLogicalSession,
  StoredRoute,
  UpstreamEndpoint,
} from "./domain/routing.js";
import type { ListenAddress } from "./domain/network.js";
import type { ProviderHealth } from "./domain/health.js";
import type { UsageRecord } from "./domain/usage.js";
import { ACTIVE_CONNECTION_TTL_MS } from "./domain/routing.js";
export type { IssuedAccessGrant, RouteServiceEffects } from "./route-administration.js";

export interface RouteServiceDependencies {
  store: RoutingStore;
  brightData: ProviderAdapter<"bright_data">;
  proxidize: MobileProviderAdapter;
  proxyAddresses: () => { http: ListenAddress; socks5: ListenAddress };
  advertisedProxyHost: string;
  advertisedHttpProxyProtocol: "http" | "https";
  logger: Logger;
  telemetry: Telemetry;
  retryDefaults: RetryPolicy;
  deploymentId: string;
  now?: () => number;
}

const MAX_PROVIDERS_PER_OPERATION = V0_POLICY.establishmentBudget.providersPerOperation;
const AUTHORIZATION_CACHE_TTL_MS = 30_000;
const AUTHORIZATION_EPOCH_REFRESH_MS = 1_000;
const AUTHORIZATION_CACHE_MAX_ENTRIES = 10_000;
const ROUTING_EVIDENCE_RECORD_LIMIT = 2_048;

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

function profileBindingFingerprint(route: StoredRoute): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        providerOverride: route.providerOverride ?? null,
        allowedProtocols: [...route.allowedProtocols].sort(),
        targeting: {
          country: route.targeting.country ?? null,
          region: route.targeting.region ?? null,
          city: route.targeting.city ?? null,
          postalCode: route.targeting.postalCode ?? null,
          asn: route.targeting.asn ?? null,
          carrier: route.targeting.carrier ?? null,
        },
      }),
    )
    .digest("hex");
}

function rebindAffinitySeed(session: StoredLogicalSession, profileFingerprint: string): string {
  return `${session.id}:binding-${session.bindingVersion + 1}:${profileFingerprint}`;
}

function clearPreferredClassHealthWindow(session: StoredLogicalSession): StoredLogicalSession {
  const cleared = { ...session };
  delete cleared.preferredClassHealthySince;
  return cleared;
}

export class RouteService {
  readonly effects: RouteServiceEffects;
  readonly #providers: ReadonlyMap<ProviderId, ProviderAdapter>;
  readonly #rotationDisabledSlots = new Set<string>();
  readonly #authorizationCache = new Map<string, { route: AuthenticatedRoute; expiresAt: number }>();
  #authorizationEpoch = -1;
  #authorizationEpochRefreshAt = 0;
  #authorizationEpochRefresh: Promise<void> | undefined;

  private readonly store: RoutingStore;
  private readonly proxidize: MobileProviderAdapter;
  private readonly logger: Logger;
  private readonly retryDefaults: RetryPolicy;
  private readonly deploymentId: string;
  private readonly now: () => number;
  private readonly administration: RouteAdministrationService;
  private readonly connections: ActiveConnectionTracker;
  private readonly candidateRanker: RoutingCandidateRanker;

  constructor(dependencies: RouteServiceDependencies) {
    this.store = dependencies.store;
    this.proxidize = dependencies.proxidize;
    this.logger = dependencies.logger;
    this.retryDefaults = dependencies.retryDefaults;
    this.deploymentId = dependencies.deploymentId;
    this.now = dependencies.now ?? Date.now;
    this.#providers = new Map<ProviderId, ProviderAdapter>([
      [dependencies.brightData.descriptor.id, dependencies.brightData],
      [dependencies.proxidize.descriptor.id, dependencies.proxidize],
    ]);
    this.connections = new ActiveConnectionTracker(this.store, this.deploymentId, this.now);
    this.candidateRanker = new RoutingCandidateRanker(this.store, this.proxidize, this.logger, this.now);
    this.administration = new RouteAdministrationService({
      store: this.store,
      providers: this.#providers.values(),
      proxyAddresses: dependencies.proxyAddresses,
      advertisedProxyHost: dependencies.advertisedProxyHost,
      advertisedHttpProxyProtocol: dependencies.advertisedHttpProxyProtocol,
      logger: this.logger,
      retryDefaults: this.retryDefaults,
      now: this.now,
      terminateActiveGrant: (grantId) => this.connections.terminateGrant(grantId),
      terminateActiveSession: (sessionId) => this.connections.terminateSession(sessionId),
    });
    const effects = this.administration.effects;
    const invalidateAfter = <A>(operation: Effect.Effect<A, RouteServiceError>): Effect.Effect<A, RouteServiceError> =>
      Effect.tap(operation, () => Effect.sync(() => this.#invalidateAuthorizationCache()));
    this.effects = {
      ...effects,
      update: (id, input, userId) => invalidateAfter(effects.update(id, input, userId)),
      rotateAccessGrantCredential: (id, previousCredentialId, principalId, suspectedCompromise) =>
        invalidateAfter(effects.rotateAccessGrantCredential(id, previousCredentialId, principalId, suspectedCompromise)),
      closeLogicalSession: (grantId, sessionId, principalId, force) =>
        invalidateAfter(effects.closeLogicalSession(grantId, sessionId, principalId, force)),
      revokeAccessGrantCredential: (grantId, credentialId, principalId) =>
        invalidateAfter(effects.revokeAccessGrantCredential(grantId, credentialId, principalId)),
      revokeAccessGrant: (id, principalId) => invalidateAfter(effects.revokeAccessGrant(id, principalId)),
      delete: (id, userId) => invalidateAfter(effects.delete(id, userId)),
    };
  }

  async #refreshAuthorizationEpoch(): Promise<void> {
    if (this.now() < this.#authorizationEpochRefreshAt) return;
    this.#authorizationEpochRefresh ??= this.store
      .getAuthorizationEpoch()
      .then((epoch) => {
        if (this.#authorizationEpoch !== epoch) this.#authorizationCache.clear();
        this.#authorizationEpoch = epoch;
        this.#authorizationEpochRefreshAt = this.now() + AUTHORIZATION_EPOCH_REFRESH_MS;
      })
      .finally(() => {
        this.#authorizationEpochRefresh = undefined;
      });
    await this.#authorizationEpochRefresh;
  }

  #authorizationCacheKey(username: string, token: string): string {
    return createHash("sha256").update(username).update("\0").update(token).digest("hex");
  }

  #cacheAuthorization(key: string, route: AuthenticatedRoute): void {
    if (this.#authorizationCache.size >= AUTHORIZATION_CACHE_MAX_ENTRIES) {
      const oldest = this.#authorizationCache.keys().next().value;
      if (oldest !== undefined) this.#authorizationCache.delete(oldest);
    }
    this.#authorizationCache.set(key, { route: structuredClone(route), expiresAt: this.now() + AUTHORIZATION_CACHE_TTL_MS });
  }

  #invalidateAuthorizationCache(): void {
    this.#authorizationCache.clear();
    this.#authorizationEpoch = -1;
    this.#authorizationEpochRefreshAt = 0;
  }

  #capacityFailureReason(error: unknown): CapacityCircuitReason | undefined {
    if (!isRetryableUpstreamFailure(error)) return undefined;
    if (error instanceof AppError && /hard_limit|capacity_limit/.test(error.code)) return "provider_hard_limit";
    if (error instanceof AppError && error.code.includes("capacity")) return "capacity_failure";
    if (error instanceof Error && "code" in error && error.code === "ETIMEDOUT") return "timeout";
    if (error instanceof ProviderUnavailableError && error.reason === "timeout") return "timeout";
    return "establishment_failure";
  }

  async #recordCapacityFailure(provider: ProviderId, candidateKey: string, error: unknown): Promise<CapacityCircuitState | undefined> {
    const reason = this.#capacityFailureReason(error);
    if (reason === undefined) return undefined;
    const state = await this.store.recordCapacityCircuitFailure(provider, candidateKey, reason, new Date(this.now()).toISOString());
    this.logger.warn("Capacity circuit failure recorded", {
      provider,
      candidateKey,
      reason,
      circuitState: state.status,
      consecutiveFailures: state.consecutiveFailures,
      openCount: state.openCount,
      cooldownUntil: state.cooldownUntil,
      routingPolicyVersion: ROUTING_POLICY.version,
    });
    return state;
  }

  #routeForCredential(
    route: StoredRoute,
    grant: { id: string; principalId: string; jobId?: string },
    credential: { id: string; sessionMode: SessionMode; sessionId?: string },
  ): AuthenticatedRoute {
    return {
      ...route,
      userId: grant.principalId,
      accessGrantId: grant.id,
      credentialId: credential.id,
      ...(grant.jobId === undefined ? {} : { jobId: grant.jobId }),
      sessionMode: credential.sessionMode,
      ...(credential.sessionId === undefined ? {} : { sessionId: credential.sessionId }),
    };
  }

  async #selectProxySlot(
    route: AuthenticatedRoute,
    protocol: DataPlaneProtocol,
    excludedEndpointIds: ReadonlySet<string>,
    signal: AbortSignal,
    state: ResolutionState,
    recentRecords: readonly UsageRecord[],
  ): Promise<{
    endpointId: string;
    activeConnections: number;
    capacityPressure: boolean;
    rotationDisabled: boolean;
    activeLoadClaimId: string;
    routingScore: number;
    routingScoreComponents: RoutingScoreComponents;
  }> {
    const inventory = await this.proxidize.listEndpoints(false, signal);
    const capturedAt = new Date(this.now()).toISOString();
    await this.store
      .saveProviderInventory({
        provider: "proxidize",
        providerAccountId: this.proxidize.providerAccountId,
        slots: inventory.map((endpoint) => ({
          proxySlotId: endpoint.id,
          ...(endpoint.deviceId === undefined ? {} : { deviceId: endpoint.deviceId }),
          country: endpoint.country,
          region: endpoint.region,
          ...(endpoint.city === undefined ? {} : { city: endpoint.city }),
          carrier: endpoint.carrier,
          healthy: endpoint.healthy,
          ...(endpoint.egressIp === undefined ? {} : { egressIp: endpoint.egressIp }),
        })),
        capturedAt,
      })
      .catch((error: unknown) =>
        this.logger.error("Provider inventory persistence failed", {
          provider: "proxidize",
          error: safeErrorMessage(error),
        }),
      );
    const compatibleEndpoints = inventory.filter(
      (endpoint) => endpoint.healthy && !excludedEndpointIds.has(endpoint.id) && this.proxidize.matches(endpoint, route),
    );
    const endpoints: typeof compatibleEndpoints = [];
    for (const endpoint of compatibleEndpoints) {
      if (await this.candidateRanker.capacityCircuitEligible("proxidize", endpoint.id)) endpoints.push(endpoint);
      else state.capacityConstraint = "capacity_circuit";
    }
    if (signal.aborted) throw abortReason(signal);
    if (endpoints.length === 0) {
      state.capacityConstraint ??=
        route.targeting.carrier !== undefined
          ? "carrier"
          : route.targeting.country !== undefined || route.targeting.region !== undefined || route.targeting.city !== undefined
            ? "geography"
            : "slot_exhaustion";
      throw new ProviderUnavailableError("No healthy compatible mobile proxy slot is available");
    }
    let selected: ScoredRoutingCandidate<(typeof endpoints)[number]> | undefined;
    const claimedAt = new Date(this.now()).toISOString();
    const claimed = await this.store.claimActiveTunnelSlot(
      endpoints.map((endpoint) => endpoint.id),
      (loads) => {
        const candidates = endpoints.map((endpoint) => {
          const activeConnections = loads.get(endpoint.id) ?? 0;
          return {
            candidate: endpoint,
            activeConnections,
            ...this.candidateRanker.scoreCandidate(
              this.proxidize,
              recentRecords.filter((record) => record.provider === "proxidize" && record.proxySlotId === endpoint.id),
              activeConnections,
              true,
            ),
          };
        });
        const preferred = candidates.find((candidate) => candidate.candidate.id === state.preferredEndpointId);
        const unsaturated = candidates.filter((candidate) => !candidate.saturated);
        selected =
          preferred ??
          [...(unsaturated.length > 0 ? unsaturated : candidates)].sort(
            (left, right) => left.activeConnections - right.activeConnections || left.candidate.id.localeCompare(right.candidate.id),
          )[0];
        if (selected === undefined) throw new ProviderUnavailableError("No compatible mobile proxy slot is available");
        return selected.candidate.id;
      },
      (endpointId) => ({
        id: randomUUID(),
        deploymentId: this.deploymentId,
        routeId: route.id,
        accessGrantId: route.accessGrantId,
        ...(route.sessionId === undefined ? {} : { sessionId: route.sessionId }),
        protocol,
        provider: "proxidize",
        endpointId,
        routingPolicyVersion: ROUTING_POLICY.version,
        ...(selected === undefined ? {} : { routingScore: selected.score }),
        startedAt: claimedAt,
        lastHeartbeatAt: claimedAt,
        expiresAt: new Date(this.now() + ACTIVE_CONNECTION_TTL_MS).toISOString(),
      }),
    );
    const endpoint = endpoints.find((candidate) => candidate.id === claimed.tunnel.endpointId);
    if (endpoint === undefined || selected === undefined) {
      await this.store.removeActiveTunnel(claimed.tunnel.id).catch(() => undefined);
      throw new ProviderUnavailableError("The selected mobile proxy slot disappeared");
    }
    let rotationDisabled = this.#rotationDisabledSlots.has(endpoint.id);
    if (!rotationDisabled) {
      try {
        await this.proxidize.setRotationInterval(endpoint.id, undefined);
        this.#rotationDisabledSlots.add(endpoint.id);
        rotationDisabled = true;
      } catch (error) {
        this.logger.warn("Provider-managed proxy-slot reassignment could not be disabled", {
          provider: "proxidize",
          proxySlotId: endpoint.id,
          error: safeErrorMessage(error),
        });
      }
    }
    const activeConnections = claimed.activeConnections;
    if (activeConnections >= CAPACITY_POLICY.softConnectionsPerSlot) state.capacityConstraint = "slot_exhaustion";
    return {
      endpointId: endpoint.id,
      activeConnections,
      capacityPressure: activeConnections >= CAPACITY_POLICY.softConnectionsPerSlot,
      rotationDisabled,
      activeLoadClaimId: claimed.tunnel.id,
      routingScore: selected.score,
      routingScoreComponents: selected.components,
    };
  }

  descriptors(): ProviderDescriptor[] {
    return [...this.#providers.values()].map((provider) => provider.descriptor);
  }

  async create(input: unknown, userId: string): Promise<PublicRoute> {
    return this.administration.create(input, userId);
  }

  async update(id: string, input: unknown, userId: string): Promise<PublicRoute> {
    const updated = await this.administration.update(id, input, userId);
    this.#invalidateAuthorizationCache();
    return updated;
  }

  async createAccessGrant(routeId: string, principalId: string, input: unknown): Promise<IssuedAccessGrant> {
    return this.administration.createAccessGrant(routeId, principalId, input);
  }

  async listAccessGrants(routeId: string, principalId: string): Promise<PublicAccessGrant[]> {
    return this.administration.listAccessGrants(routeId, principalId);
  }

  async getAccessGrant(id: string, principalId: string): Promise<PublicAccessGrant> {
    return this.administration.getAccessGrant(id, principalId);
  }

  async getAccessGrantCredential(grantId: string, credentialId: string, principalId: string): Promise<PublicAccessGrantCredential> {
    return this.administration.getAccessGrantCredential(grantId, credentialId, principalId);
  }

  async rotateAccessGrantCredential(
    id: string,
    previousCredentialId: string,
    principalId: string,
    suspectedCompromise = false,
  ): Promise<IssuedAccessGrant> {
    const issued = await this.administration.rotateAccessGrantCredential(id, previousCredentialId, principalId, suspectedCompromise);
    this.#invalidateAuthorizationCache();
    return issued;
  }

  async createManagedSession(grantId: string, principalId: string): Promise<IssuedAccessGrant> {
    return this.administration.createManagedSession(grantId, principalId);
  }

  async createStatelessCredential(grantId: string, principalId: string): Promise<IssuedAccessGrant> {
    return this.administration.createStatelessCredential(grantId, principalId);
  }

  async listLogicalSessions(grantId: string, principalId: string): Promise<PublicLogicalSession[]> {
    return this.administration.listLogicalSessions(grantId, principalId);
  }

  async getLogicalSession(grantId: string, sessionId: string, principalId: string): Promise<PublicLogicalSession> {
    return this.administration.getLogicalSession(grantId, sessionId, principalId);
  }

  async closeLogicalSession(grantId: string, sessionId: string, principalId: string, force = false): Promise<void> {
    await this.administration.closeLogicalSession(grantId, sessionId, principalId, force);
    this.#invalidateAuthorizationCache();
  }

  async revokeAccessGrantCredential(grantId: string, credentialId: string, principalId: string): Promise<void> {
    await this.administration.revokeAccessGrantCredential(grantId, credentialId, principalId);
    this.#invalidateAuthorizationCache();
  }

  async revokeAccessGrant(id: string, principalId: string, terminateActive = false): Promise<void> {
    await this.administration.revokeAccessGrant(id, principalId, terminateActive);
    this.#invalidateAuthorizationCache();
  }

  async list(userId: string): Promise<PublicRoute[]> {
    return this.administration.list(userId);
  }

  async get(id: string, userId: string): Promise<PublicRoute> {
    return this.administration.get(id, userId);
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.administration.delete(id, userId);
    this.#invalidateAuthorizationCache();
  }

  async emergencyRevoke(id: string): Promise<void> {
    await this.administration.emergencyRevoke(id);
    this.#invalidateAuthorizationCache();
    this.connections.terminateRoute(id);
  }

  async trackActiveConnection(
    routeId: string,
    accessGrantId: string,
    sessionId: string | undefined,
    protocol: DataPlaneProtocol,
    upstream: UpstreamEndpoint,
    terminate: () => void,
  ): Promise<() => void> {
    return this.connections.track(routeId, accessGrantId, sessionId, protocol, upstream, terminate);
  }

  async releaseCandidate(upstream: UpstreamEndpoint | undefined): Promise<void> {
    await this.connections.release(upstream);
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
    if (!/^pxy_[a-zA-Z0-9_-]{1,128}$/.test(id) || token.length === 0 || token.length > 512) {
      throw new AuthenticationError();
    }
    await this.#refreshAuthorizationEpoch();
    const cacheKey = this.#authorizationCacheKey(id, token);
    const cached = this.#authorizationCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      this.#authorizationCache.delete(cacheKey);
      this.#authorizationCache.set(cacheKey, cached);
      return structuredClone(cached.route);
    }
    if (cached !== undefined) this.#authorizationCache.delete(cacheKey);
    const authenticated = await this.store.authenticateAccessGrant(id, token);
    if (authenticated === undefined) throw new AuthenticationError();
    if (authenticated.credential.sessionMode === "managed") {
      const sessionId = authenticated.credential.sessionId;
      if (sessionId === undefined) throw new AuthenticationError();
      const session = await this.store.getLogicalSession(sessionId).catch(() => undefined);
      if (
        session === undefined ||
        session.grantId !== authenticated.grant.id ||
        session.routeId !== authenticated.grant.routeId ||
        session.status !== "open"
      ) {
        throw new AuthenticationError();
      }
    }
    const route = this.#routeForCredential(authenticated.route, authenticated.grant, authenticated.credential);
    this.#cacheAuthorization(cacheKey, route);
    return route;
  }

  createResolutionState(): ResolutionState {
    return createResolutionState();
  }

  assertProtocolAllowed(route: StoredRoute, protocol: DataPlaneProtocol): void {
    if (!route.allowedProtocols.includes(protocol)) {
      throw new AppError(`Route does not allow the ${protocol} data-plane protocol`, "protocol_not_allowed", 403);
    }
  }

  async assertNewConnectionAllowed(routeId: string, accessGrantId: string, sessionId?: string): Promise<void> {
    if (!this.connections.canAcceptConnection()) {
      throw new ProviderUnavailableError("Proxy task is at its active-connection admission limit");
    }
    const current = await this.store.get(routeId);
    if (current.status !== "ready") throw new ProviderUnavailableError(`Route is ${current.status}`);
    const grant = await this.store.getAccessGrant(accessGrantId);
    if (grant.routeId !== routeId || grant.status !== "ready") throw new AuthenticationError();
    if (sessionId !== undefined) {
      const session = await this.store.getLogicalSession(sessionId);
      if (session.routeId !== routeId || session.grantId !== accessGrantId || session.status !== "open") throw new AuthenticationError();
    }
  }

  async resolve(
    route: AuthenticatedRoute,
    protocol: DataPlaneProtocol,
    target: ProxyTarget,
    state: ResolutionState,
    context: ResolutionContext,
  ): Promise<UpstreamEndpoint> {
    const current = route;
    if (current.status !== "ready") throw new ProviderUnavailableError(`Route is ${current.status}`);
    this.assertProtocolAllowed(current, protocol);
    const recentTo = new Date(this.now()).toISOString();
    const recentFrom = new Date(this.now() - ROUTING_POLICY.evidenceWindowMs).toISOString();
    const recentRecords = await this.store.listUsageRecords(recentFrom, recentTo, {
      limit: ROUTING_EVIDENCE_RECORD_LIMIT,
      newestFirst: true,
    });
    let logicalSession: StoredLogicalSession | undefined;
    if (current.sessionMode === "managed") {
      if (current.sessionId === undefined) throw new AuthenticationError();
      logicalSession = await this.store.getLogicalSession(current.sessionId);
      if (logicalSession.grantId !== current.accessGrantId || logicalSession.routeId !== current.id || logicalSession.status !== "open") {
        throw new AuthenticationError();
      }
      const desiredClass = preferredProviderClass(current.sessionMode);
      const profileFingerprint = profileBindingFingerprint(current);
      state.desiredProviderClass = desiredClass;
      state.sessionAffinityHit = false;
      if (logicalSession.affinity !== undefined) state.currentProviderClass = logicalSession.affinity.currentProviderClass;
      state.degradedFallback = logicalSession.affinity?.degradedFallback ?? false;
      state.preferredAffinityHandle = logicalSession.affinity?.affinityHandle ?? logicalSession.id;
      const existingProvider = logicalSession.affinity === undefined ? undefined : this.#providers.get(logicalSession.affinity.provider);
      const bindingCompatible =
        existingProvider !== undefined &&
        providerCompatible(existingProvider, current, protocol, target, "managed") &&
        (current.providerOverride === undefined || existingProvider.descriptor.id === current.providerOverride) &&
        logicalSession.affinity?.profileFingerprint === profileFingerprint &&
        !state.excludedEndpointIds.has(logicalSession.affinity.candidateId);
      let preferBinding = bindingCompatible;
      if (
        preferBinding &&
        logicalSession.affinity !== undefined &&
        logicalSession.affinity.currentProviderClass !== desiredClass &&
        current.providerOverride === undefined
      ) {
        const preferredProviders = [...this.#providers.values()].filter(
          (provider) =>
            provider.descriptor.providerClass === desiredClass && providerCompatible(provider, current, protocol, target, "managed"),
        );
        const preferredHealthy = (
          await Promise.all(preferredProviders.map((provider) => provider.health(context.signal).catch(() => undefined)))
        ).some((health) => health?.state === "healthy");
        const nowIso = new Date(this.now()).toISOString();
        if (!preferredHealthy) {
          if (logicalSession.preferredClassHealthySince !== undefined) {
            const updated = {
              ...clearPreferredClassHealthWindow(logicalSession),
              bindingVersion: logicalSession.bindingVersion + 1,
              updatedAt: nowIso,
            };
            if (await this.store.saveLogicalSession(updated, logicalSession.bindingVersion)) logicalSession = updated;
          }
        } else if (logicalSession.preferredClassHealthySince === undefined) {
          const updated = {
            ...logicalSession,
            preferredClassHealthySince: nowIso,
            bindingVersion: logicalSession.bindingVersion + 1,
            updatedAt: nowIso,
          };
          if (await this.store.saveLogicalSession(updated, logicalSession.bindingVersion)) logicalSession = updated;
        } else {
          const activeForSession =
            (await this.store.getActiveConnectionCounts([], [], [logicalSession.id], recentTo)).sessions.get(logicalSession.id) ?? 0;
          const stableFor = this.now() - Date.parse(logicalSession.preferredClassHealthySince);
          const quiescentFor =
            logicalSession.lastDisconnectedAt === undefined
              ? Number.POSITIVE_INFINITY
              : this.now() - Date.parse(logicalSession.lastDisconnectedAt);
          if (
            stableFor >= ROUTING_POLICY.preferredClassStabilizationMs &&
            activeForSession === 0 &&
            quiescentFor >= ROUTING_POLICY.sessionQuiescenceMs
          ) {
            preferBinding = false;
            state.failbackProbe = true;
            state.failbackOutcome = "not_attempted";
          }
        }
      }
      if (preferBinding && logicalSession.affinity !== undefined) {
        state.previousProvider = logicalSession.affinity.provider;
        state.previousCandidateId = logicalSession.affinity.candidateId;
        if (logicalSession.affinity.provider === "proxidize") state.preferredEndpointId = logicalSession.affinity.candidateId;
        else delete state.preferredEndpointId;
      } else if (logicalSession.affinity !== undefined && !bindingCompatible) {
        state.previousProvider = logicalSession.affinity.provider;
        state.previousCandidateId = logicalSession.affinity.candidateId;
        delete state.preferredEndpointId;
        state.preferredAffinityHandle = rebindAffinitySeed(logicalSession, profileFingerprint);
        state.sessionRebindCause = "binding_ineligible";
      }
    }
    const compatibleProviders = (
      await this.candidateRanker.rankProviders(
        [...this.#providers.values()].filter(
          (provider) =>
            providerCompatible(provider, current, protocol, target, current.sessionMode) &&
            (current.providerOverride === undefined || provider.descriptor.id === current.providerOverride),
        ),
        current,
        state,
        recentRecords,
        context.signal,
      )
    ).slice(0, MAX_PROVIDERS_PER_OPERATION);
    if (compatibleProviders.length === 0) {
      if (current.providerOverride !== undefined) throw new ProviderOverrideUnsatisfiedError();
      throw new ProviderUnavailableError("No compatible provider is available");
    }
    for (const provider of compatibleProviders) {
      state.primaryProvider ??= provider.descriptor.id;
      const attempts = state.attemptsByProvider.get(provider.descriptor.id) ?? 0;
      const attemptLimit =
        current.targeting.city !== undefined && provider.descriptor.capabilities.exactCity === "verifiable"
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
      let slotSelection:
        | {
            endpointId: string;
            activeConnections: number;
            capacityPressure: boolean;
            rotationDisabled: boolean;
            activeLoadClaimId: string;
            routingScore: number;
            routingScoreComponents: RoutingScoreComponents;
          }
        | undefined;
      if (provider.descriptor.id === "proxidize") {
        state.capacityPolicyVersion = CAPACITY_POLICY.version;
        const selectionStartedAt = this.now();
        try {
          slotSelection = await this.#selectProxySlot(current, protocol, state.excludedEndpointIds, context.signal, state, recentRecords);
        } finally {
          state.establishmentWaitMs += Math.max(0, this.now() - selectionStartedAt);
        }
        if (slotSelection.capacityPressure) {
          this.logger.info("Proxy-slot selection exceeded the soft capacity limit", {
            logicalOperationId: context.logicalOperationId,
            routeId: current.id,
            provider: "proxidize",
            proxySlotId: slotSelection.endpointId,
            activeConnections: slotSelection.activeConnections,
            softConnectionsPerSlot: CAPACITY_POLICY.softConnectionsPerSlot,
            capacityPolicyVersion: CAPACITY_POLICY.version,
          });
        }
      }
      let endpoint: UpstreamEndpoint;
      try {
        endpoint = await provider.resolve(current, {
          dataPlaneProtocol: protocol,
          target,
          logicalOperationId: context.logicalOperationId,
          sessionMode: current.sessionMode,
          ...(state.preferredAffinityHandle === undefined ? {} : { affinityHandle: state.preferredAffinityHandle }),
          candidateIndex: attempts,
          signal: context.signal,
          excludedEndpointIds: state.excludedEndpointIds,
          ...(slotSelection === undefined ? {} : { selectedEndpointId: slotSelection.endpointId }),
        });
      } catch (error) {
        if (slotSelection !== undefined) await this.store.removeActiveTunnel(slotSelection.activeLoadClaimId).catch(() => undefined);
        await this.#recordCapacityFailure(provider.descriptor.id, slotSelection?.endpointId ?? provider.descriptor.id, error).catch(
          () => undefined,
        );
        throw attributeProvider(error, provider.descriptor.id);
      }
      if (!provider.descriptor.capabilities.upstreamProtocols.has(endpoint.protocol)) {
        throw new ProviderUnavailableError("Provider returned an undeclared upstream proxy protocol");
      }
      if (slotSelection !== undefined) {
        endpoint.proxySlotId = slotSelection.endpointId;
        endpoint.selectedSlotLoad = slotSelection.activeConnections;
        endpoint.capacityPressure = slotSelection.capacityPressure;
        endpoint.capacityPolicyVersion = CAPACITY_POLICY.version;
        endpoint.activeLoadClaimId = slotSelection.activeLoadClaimId;
        endpoint.routingPolicyVersion = ROUTING_POLICY.version;
        endpoint.routingScore = slotSelection.routingScore;
        endpoint.routingScoreComponents = slotSelection.routingScoreComponents;
        endpoint.assignment.providerManagedReassignmentDisabled = slotSelection.rotationDisabled;
      }
      if (state.capacityDrivenFallback === true) {
        endpoint.capacityPressure = true;
        if (state.capacityPressureProvider !== undefined) endpoint.capacityPressureProvider = state.capacityPressureProvider;
      } else if (endpoint.capacityPressure === true) {
        endpoint.capacityPressureProvider = endpoint.provider;
      }
      if (current.targeting.city !== undefined && provider.descriptor.capabilities.exactCity === "verifiable") {
        const expected = endpoint.assignment.expectedCity;
        const observed = endpoint.assignment.observedCity;
        if (
          endpoint.assignment.assignmentMode !== "service_verified" ||
          expected === undefined ||
          observed === undefined ||
          canonicalCity(expected) !== canonicalCity(observed)
        ) {
          await this.releaseCandidate(endpoint).catch(() => undefined);
          state.excludedEndpointIds.add(endpoint.endpointId);
          state.previousCandidateId = endpoint.assignment.candidateId;
          state.previousProvider = endpoint.provider;
          throw attributeProvider(
            attributeAssignment(new ProviderUnavailableError("Candidate exact-city verification failed"), endpoint.assignment),
            provider.descriptor.id,
          );
        }
      }
      const capacityCircuitKey = slotSelection?.endpointId ?? provider.descriptor.id;
      const circuitClaim = await this.store.claimCapacityCircuit(
        provider.descriptor.id,
        capacityCircuitKey,
        new Date(this.now()).toISOString(),
      );
      if (!circuitClaim.allowed) {
        await this.releaseCandidate(endpoint).catch(() => undefined);
        state.capacityConstraint = "capacity_circuit";
        state.excludedEndpointIds.add(endpoint.endpointId);
        throw attributeProvider(new ProviderUnavailableError("Candidate capacity circuit is open"), provider.descriptor.id);
      }
      endpoint.capacityCircuitKey = capacityCircuitKey;
      endpoint.capacityCircuitState = circuitClaim.state?.status ?? "closed";
      if (circuitClaim.state?.reason !== undefined) endpoint.capacityCircuitReason = circuitClaim.state.reason;
      if (circuitClaim.state?.cooldownUntil !== undefined) {
        endpoint.capacityCircuitCooldownUntil = circuitClaim.state.cooldownUntil;
      }
      if (endpoint.activeLoadClaimId === undefined) {
        const providerRecords = recentRecords.filter((record) => record.provider === provider.descriptor.id);
        const providerLoad =
          (await this.store.getActiveConnectionCounts([provider.descriptor.id], [], [], recentTo)).providers.get(provider.descriptor.id) ??
          0;
        const scored = this.candidateRanker.scoreCandidate(provider, providerRecords, providerLoad, false);
        const claimId = randomUUID();
        const claimedAt = new Date(this.now()).toISOString();
        await this.store.registerActiveTunnel({
          id: claimId,
          deploymentId: this.deploymentId,
          routeId: current.id,
          accessGrantId: current.accessGrantId,
          ...(current.sessionId === undefined ? {} : { sessionId: current.sessionId }),
          protocol,
          provider: endpoint.provider,
          endpointId: endpoint.endpointId,
          routingPolicyVersion: ROUTING_POLICY.version,
          routingScore: scored.score,
          startedAt: claimedAt,
          lastHeartbeatAt: claimedAt,
          expiresAt: new Date(this.now() + ACTIVE_CONNECTION_TTL_MS).toISOString(),
        });
        endpoint.activeLoadClaimId = claimId;
        endpoint.routingPolicyVersion = ROUTING_POLICY.version;
        endpoint.routingScore = scored.score;
        endpoint.routingScoreComponents = scored.components;
      }
      if (state.previousCandidateId !== undefined) {
        endpoint.assignment.previousCandidateId = state.previousCandidateId;
      }
      endpoint.assignment.changeReason =
        state.previousProvider === undefined ? "selection" : state.previousProvider === endpoint.provider ? "retry" : "failover";
      if (logicalSession !== undefined) {
        const providerClass = provider.descriptor.providerClass;
        const desiredClass = preferredProviderClass(current.sessionMode);
        const profileFingerprint = profileBindingFingerprint(current);
        const affinityHandle = endpoint.assignment.providerSessionId ?? endpoint.endpointId;
        const previousAffinity = logicalSession.affinity;
        const sameBinding =
          previousAffinity?.provider === endpoint.provider &&
          previousAffinity.candidateId === endpoint.assignment.candidateId &&
          previousAffinity.affinityHandle === affinityHandle &&
          previousAffinity.profileFingerprint === profileFingerprint;
        if (sameBinding) {
          state.sessionAffinityHit = true;
          const nowIso = new Date(this.now()).toISOString();
          const resetFailbackWindow = state.failbackProbe === true && providerClass !== desiredClass;
          const updated: StoredLogicalSession = {
            ...(resetFailbackWindow ? clearPreferredClassHealthWindow(logicalSession) : logicalSession),
            bindingVersion: logicalSession.bindingVersion + 1,
            affinity: { ...previousAffinity, lastUsedAt: nowIso },
            updatedAt: nowIso,
          };
          if (await this.store.saveLogicalSession(updated, logicalSession.bindingVersion)) logicalSession = updated;
        } else {
          const nowIso = new Date(this.now()).toISOString();
          const updated: StoredLogicalSession = {
            ...(providerClass === desiredClass ? clearPreferredClassHealthWindow(logicalSession) : logicalSession),
            bindingVersion: logicalSession.bindingVersion + 1,
            affinity: {
              provider: endpoint.provider,
              providerClass,
              candidateId: endpoint.assignment.candidateId,
              affinityHandle,
              profileFingerprint,
              desiredProviderClass: desiredClass,
              currentProviderClass: providerClass,
              degradedFallback: providerClass !== desiredClass,
              boundAt: nowIso,
              lastUsedAt: nowIso,
            },
            updatedAt: nowIso,
          };
          if (!(await this.store.saveLogicalSession(updated, logicalSession.bindingVersion))) {
            await this.releaseCandidate(endpoint).catch(() => undefined);
            if (state.sessionRebindRetries >= 2) {
              throw new ProviderUnavailableError("Concurrent logical-session rebinding did not converge");
            }
            state.sessionRebindRetries += 1;
            state.sessionRebindCause = "concurrent_rebind";
            delete state.previousProvider;
            delete state.previousCandidateId;
            delete state.preferredEndpointId;
            return this.resolve(route, protocol, target, state, context);
          }
          logicalSession = updated;
          state.sessionRebindCause ??= previousAffinity === undefined ? "initial_binding" : "candidate_ineligible";
        }
        state.desiredProviderClass = desiredClass;
        state.currentProviderClass = providerClass;
        state.degradedFallback = providerClass !== desiredClass;
        if (state.failbackProbe === true) state.failbackOutcome = providerClass === desiredClass ? "success" : "failure";
      }
      state.previousCandidateId = endpoint.assignment.candidateId;
      state.previousProvider = endpoint.provider;
      return endpoint;
    }
    if (current.providerOverride !== undefined) throw new ProviderOverrideUnsatisfiedError();
    throw new ProviderUnavailableError("No compatible healthy provider is available");
  }

  async recordCandidateFailure(upstream: UpstreamEndpoint | undefined, error: unknown): Promise<void> {
    if (upstream === undefined) return;
    const state = await this.#recordCapacityFailure(
      upstream.provider,
      upstream.capacityCircuitKey ?? upstream.proxySlotId ?? upstream.provider,
      error,
    );
    if (state === undefined) return;
    upstream.capacityCircuitState = state.status;
    if (state.reason === undefined) delete upstream.capacityCircuitReason;
    else upstream.capacityCircuitReason = state.reason;
    if (state.cooldownUntil === undefined) delete upstream.capacityCircuitCooldownUntil;
    else upstream.capacityCircuitCooldownUntil = state.cooldownUntil;
  }

  async recordCandidateSuccess(upstream: UpstreamEndpoint): Promise<void> {
    const candidateKey = upstream.capacityCircuitKey ?? upstream.proxySlotId ?? upstream.provider;
    const previous = await this.store.getCapacityCircuit(upstream.provider, candidateKey, new Date(this.now()).toISOString());
    if (previous === undefined) return;
    await this.store.resetCapacityCircuit(upstream.provider, candidateKey);
    upstream.capacityCircuitState = "closed";
    delete upstream.capacityCircuitReason;
    delete upstream.capacityCircuitCooldownUntil;
    this.logger.info("Capacity circuit reset after successful establishment", {
      provider: upstream.provider,
      candidateKey,
      previousState: previous.status,
      routingPolicyVersion: ROUTING_POLICY.version,
    });
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
