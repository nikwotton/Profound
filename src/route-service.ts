import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { AccessGrantService, type IssuedAccessGrant } from "./access-grant-service.js";
import { CAPACITY_POLICY } from "./capacity-policy.js";
import { capacityCircuitAllowsCandidate } from "./capacity-circuit.js";
import {
  AppError,
  AuthenticationError,
  NotFoundError,
  ProviderOverrideUnsatisfiedError,
  ProviderUnavailableError,
  type RouteServiceError,
  attributeAssignment,
  attributeProvider,
  isRetryableUpstreamFailure,
  safeErrorMessage,
  toRouteServiceError,
} from "./errors.js";
import { abortReason } from "./establishment-budget.js";
import type { Logger } from "./logger.js";
import type { MobileProviderAdapter, ProviderAdapter } from "./providers/provider.js";
import { preferredProviderClass, providerCompatible, selectCompatibleProvider } from "./provider-selection.js";
import { RotationCoordinator, type RotationContext } from "./route-rotation.js";
import { DEPLOYMENT_POLL_INTERVAL_MS } from "./release-policy.js";
import {
  historicalRoutingEvidence,
  ROUTING_POLICY,
  scoreRoutingCandidate,
  type RoutingScoreComponents,
  type ScoredRoutingCandidate,
} from "./routing-policy.js";
import { toPublicRoute, type RoutingStore } from "./store.js";
import { Telemetry } from "./telemetry.js";
import { ACTIVE_CONNECTION_TTL_MS } from "./types.js";
import type {
  AuthenticatedRoute,
  ActiveTunnel,
  CapacityCircuitReason,
  CapacityCircuitState,
  DataPlaneProtocol,
  ListenAddress,
  ProviderDescriptor,
  ProviderClass,
  ProviderHealth,
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
  UsageRecord,
} from "./types.js";
import { validateRouteProfile } from "./validation.js";

export type { IssuedAccessGrant } from "./access-grant-service.js";

export interface ResolutionState {
  readonly attemptsByProvider: Map<ProviderId, number>;
  readonly excludedEndpointIds: Set<string>;
  previousCandidateId?: string;
  previousProvider?: ProviderId;
  capacityDrivenFallback?: boolean;
  capacityPressureProvider?: ProviderId;
  capacityConstraint?: "slot_exhaustion" | "geography" | "carrier" | "hard_limit" | "capacity_circuit";
  establishmentWaitMs: number;
  capacityPolicyVersion?: string;
  preferredEndpointId?: string;
  preferredAffinityHandle?: string;
  sessionAffinityHit?: boolean;
  sessionRebindCause?: string;
  desiredProviderClass?: ProviderClass;
  currentProviderClass?: ProviderClass;
  degradedFallback?: boolean;
  failbackOutcome?: "not_attempted" | "success" | "failure";
  failbackProbe?: boolean;
  sessionRebindRetries: number;
}

export function sessionRoutingUsageContext(
  state: ResolutionState,
): Pick<
  UsageRecord,
  "sessionAffinityHit" | "sessionRebindCause" | "desiredProviderClass" | "currentProviderClass" | "degradedFallback" | "failbackOutcome"
> {
  return {
    ...(state.sessionAffinityHit === undefined ? {} : { sessionAffinityHit: state.sessionAffinityHit }),
    ...(state.sessionRebindCause === undefined ? {} : { sessionRebindCause: state.sessionRebindCause }),
    ...(state.desiredProviderClass === undefined ? {} : { desiredProviderClass: state.desiredProviderClass }),
    ...(state.currentProviderClass === undefined ? {} : { currentProviderClass: state.currentProviderClass }),
    ...(state.degradedFallback === undefined ? {} : { degradedFallback: state.degradedFallback }),
    ...(state.failbackOutcome === undefined ? {} : { failbackOutcome: state.failbackOutcome }),
  };
}

export function sessionRoutingTelemetryAttributes(state: ResolutionState): Record<string, string | boolean> {
  return {
    ...(state.sessionAffinityHit === undefined ? {} : { "proxy.session.affinity_hit": state.sessionAffinityHit }),
    ...(state.sessionRebindCause === undefined ? {} : { "proxy.session.rebind_cause": state.sessionRebindCause }),
    ...(state.desiredProviderClass === undefined ? {} : { "proxy.session.desired_provider_class": state.desiredProviderClass }),
    ...(state.currentProviderClass === undefined ? {} : { "proxy.session.current_provider_class": state.currentProviderClass }),
    ...(state.degradedFallback === undefined ? {} : { "proxy.session.degraded_fallback": state.degradedFallback }),
    ...(state.failbackOutcome === undefined ? {} : { "proxy.session.failback_outcome": state.failbackOutcome }),
  };
}

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

export interface RouteServiceEffects {
  ready(): Effect.Effect<boolean, RouteServiceError>;
  create(input: unknown, userId: string): Effect.Effect<PublicRoute, RouteServiceError>;
  update(id: string, input: unknown, userId: string): Effect.Effect<PublicRoute, RouteServiceError>;
  list(userId: string): Effect.Effect<PublicRoute[], RouteServiceError>;
  get(id: string, userId: string): Effect.Effect<PublicRoute, RouteServiceError>;
  delete(id: string, userId: string): Effect.Effect<void, RouteServiceError>;
  createAccessGrant(routeId: string, principalId: string, input: unknown): Effect.Effect<IssuedAccessGrant, RouteServiceError>;
  listAccessGrants(routeId: string, principalId: string): Effect.Effect<PublicAccessGrant[], RouteServiceError>;
  getAccessGrant(id: string, principalId: string): Effect.Effect<PublicAccessGrant, RouteServiceError>;
  getAccessGrantCredential(
    grantId: string,
    credentialId: string,
    principalId: string,
  ): Effect.Effect<PublicAccessGrantCredential, RouteServiceError>;
  rotateAccessGrantCredential(
    id: string,
    previousCredentialId: string,
    principalId: string,
    suspectedCompromise?: boolean,
  ): Effect.Effect<IssuedAccessGrant, RouteServiceError>;
  revokeAccessGrantCredential(grantId: string, credentialId: string, principalId: string): Effect.Effect<void, RouteServiceError>;
  revokeAccessGrant(id: string, principalId: string): Effect.Effect<void, RouteServiceError>;
  createManagedSession(grantId: string, principalId: string): Effect.Effect<IssuedAccessGrant, RouteServiceError>;
  createStatelessCredential(grantId: string, principalId: string, input: unknown): Effect.Effect<IssuedAccessGrant, RouteServiceError>;
  listLogicalSessions(grantId: string, principalId: string): Effect.Effect<PublicLogicalSession[], RouteServiceError>;
  getLogicalSession(grantId: string, sessionId: string, principalId: string): Effect.Effect<PublicLogicalSession, RouteServiceError>;
  closeLogicalSession(grantId: string, sessionId: string, principalId: string, force?: boolean): Effect.Effect<void, RouteServiceError>;
}

const MAX_PROVIDERS_PER_OPERATION = 3;
const MAX_PEERS_PER_PROVIDER = 2;
const MAX_VERIFICATION_CANDIDATES_PER_PROVIDER = 3;
const SLOT_MONTH_SECONDS = (365.25 / 12) * 24 * 60 * 60;

export type ResolutionContext = RotationContext;

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
        provider: route.provider,
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
  readonly #activeByRoute = new Map<string, Set<() => void>>();
  readonly #activeByGrant = new Map<string, Set<() => void>>();
  readonly #activeBySession = new Map<string, Set<() => void>>();
  readonly #rotationDisabledSlots = new Set<string>();

  private readonly store: RoutingStore;
  private readonly proxidize: MobileProviderAdapter;
  private readonly logger: Logger;
  private readonly telemetry: Telemetry;
  private readonly retryDefaults: RetryPolicy;
  private readonly deploymentId: string;
  private readonly now: () => number;
  private readonly accessGrants: AccessGrantService;
  private readonly rotations: RotationCoordinator;

  constructor(dependencies: RouteServiceDependencies) {
    this.store = dependencies.store;
    this.proxidize = dependencies.proxidize;
    this.logger = dependencies.logger;
    this.telemetry = dependencies.telemetry;
    this.retryDefaults = dependencies.retryDefaults;
    this.deploymentId = dependencies.deploymentId;
    this.now = dependencies.now ?? Date.now;
    this.#providers = new Map<ProviderId, ProviderAdapter>([
      [dependencies.brightData.descriptor.id, dependencies.brightData],
      [dependencies.proxidize.descriptor.id, dependencies.proxidize],
    ]);
    this.accessGrants = new AccessGrantService(
      this.store,
      {
        proxyAddresses: dependencies.proxyAddresses,
        advertisedProxyHost: dependencies.advertisedProxyHost,
        advertisedHttpProxyProtocol: dependencies.advertisedHttpProxyProtocol,
        terminateActiveGrant: (grantId) => this.#terminate(this.#activeByGrant.get(grantId)),
        terminateActiveSession: (sessionId) => this.#terminate(this.#activeBySession.get(sessionId)),
        now: this.now,
      },
      this.logger,
    );
    this.rotations = new RotationCoordinator({
      store: this.store,
      providers: this.#providers,
      proxidize: this.proxidize,
      logger: this.logger,
      telemetry: this.telemetry,
      now: this.now,
    });
    const attempt = <A>(operation: () => Promise<A>): Effect.Effect<A, RouteServiceError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) => {
          const normalized = toRouteServiceError(error);
          if (normalized.kind === "internal") {
            this.logger.error("Route service operation failed unexpectedly", { error: normalized });
          }
          return normalized;
        },
      });
    this.effects = {
      ready: () => attempt(() => this.ready()),
      create: (input, userId) => attempt(() => this.create(input, userId)),
      update: (id, input, userId) => attempt(() => this.update(id, input, userId)),
      list: (userId) => attempt(() => this.list(userId)),
      get: (id, userId) => attempt(() => this.get(id, userId)),
      delete: (id, userId) => attempt(() => this.delete(id, userId)),
      createAccessGrant: (routeId, principalId, input) => attempt(() => this.createAccessGrant(routeId, principalId, input)),
      listAccessGrants: (routeId, principalId) => attempt(() => this.listAccessGrants(routeId, principalId)),
      getAccessGrant: (id, principalId) => attempt(() => this.getAccessGrant(id, principalId)),
      getAccessGrantCredential: (grantId, credentialId, principalId) =>
        attempt(() => this.getAccessGrantCredential(grantId, credentialId, principalId)),
      rotateAccessGrantCredential: (id, previousCredentialId, principalId, suspectedCompromise) =>
        attempt(() => this.rotateAccessGrantCredential(id, previousCredentialId, principalId, suspectedCompromise)),
      revokeAccessGrantCredential: (grantId, credentialId, principalId) =>
        attempt(() => this.revokeAccessGrantCredential(grantId, credentialId, principalId)),
      revokeAccessGrant: (id, principalId) => attempt(() => this.revokeAccessGrant(id, principalId)),
      createManagedSession: (grantId, principalId) => attempt(() => this.createManagedSession(grantId, principalId)),
      createStatelessCredential: (grantId, principalId, input) =>
        attempt(() => this.createStatelessCredential(grantId, principalId, input)),
      listLogicalSessions: (grantId, principalId) => attempt(() => this.listLogicalSessions(grantId, principalId)),
      getLogicalSession: (grantId, sessionId, principalId) => attempt(() => this.getLogicalSession(grantId, sessionId, principalId)),
      closeLogicalSession: (grantId, sessionId, principalId, force) =>
        attempt(() => this.closeLogicalSession(grantId, sessionId, principalId, force)),
    };
  }

  #scoreCandidate(
    provider: ProviderAdapter,
    records: readonly UsageRecord[],
    activeConnections: number,
    slotCapacity: boolean,
    pressureRecords: readonly UsageRecord[] = records,
  ): Omit<ScoredRoutingCandidate<never>, "candidate"> {
    const evidence = historicalRoutingEvidence(records, this.now(), ROUTING_POLICY);
    const expectedCostUsd =
      provider.descriptor.pricing.model === "per_gib"
        ? (evidence.expectedBytes / 1024 ** 3) * provider.descriptor.pricing.amountUsd
        : (evidence.expectedConnectionSeconds / SLOT_MONTH_SECONDS) * provider.descriptor.pricing.amountUsd;
    const score = scoreRoutingCandidate({
      reliability: evidence.reliability,
      activeConnections,
      softConnections: slotCapacity ? CAPACITY_POLICY.softConnectionsPerSlot : Number.MAX_SAFE_INTEGER,
      observedMbps: evidence.observedMbps,
      plannedMbps: slotCapacity ? CAPACITY_POLICY.plannedMbpsPerSlot : Number.MAX_SAFE_INTEGER,
      projectedPeriodGb: slotCapacity ? evidence.projectedPeriodGb * ((30 * 24 * 60 * 60_000) / ROUTING_POLICY.evidenceWindowMs) : 0,
      prioritizedPeriodGb: slotCapacity ? CAPACITY_POLICY.prioritizedGbPerSlotPerBillingPeriod : Number.MAX_SAFE_INTEGER,
      performance: evidence.performance,
      expectedCostUsd,
      stability: evidence.stability,
    });
    const recentCapacityPressure = pressureRecords.some(
      (record) =>
        record.kind === "attempt" &&
        record.capacityPressure === true &&
        this.now() - Date.parse(record.completedAt) <= ROUTING_POLICY.evidenceFreshnessMs,
    );
    return { ...score, saturated: score.saturated || recentCapacityPressure };
  }

  async #capacityCircuitEligible(provider: ProviderId, candidateKey: string): Promise<boolean> {
    const state = await this.store.getCapacityCircuit(provider, candidateKey, new Date(this.now()).toISOString());
    return capacityCircuitAllowsCandidate(state, this.now());
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

  async #rankProviders(
    providers: readonly ProviderAdapter[],
    route: AuthenticatedRoute,
    state: ResolutionState,
    recentRecords: readonly UsageRecord[],
    activeConnections: readonly ActiveTunnel[],
    signal: AbortSignal,
  ): Promise<ProviderAdapter[]> {
    const preferredClass = preferredProviderClass(route.sessionMode);
    const scored: Array<ScoredRoutingCandidate<ProviderAdapter> & { activeConnections: number }> = [];
    for (const provider of providers) {
      const providerRecords = recentRecords.filter((record) => record.provider === provider.descriptor.id);
      const providerPressureRecords = recentRecords.filter(
        (record) =>
          record.capacityPressure === true &&
          (record.capacityPressureProvider ?? (record.provider === "unresolved" ? undefined : record.provider)) === provider.descriptor.id,
      );
      if (provider.descriptor.id === "proxidize") {
        const compatibleEndpoints = (await this.proxidize.listEndpoints(true, signal)).filter(
          (endpoint) => endpoint.healthy && !state.excludedEndpointIds.has(endpoint.id) && this.proxidize.matches(endpoint, route),
        );
        const endpoints: typeof compatibleEndpoints = [];
        for (const endpoint of compatibleEndpoints) {
          if (await this.#capacityCircuitEligible("proxidize", endpoint.id)) endpoints.push(endpoint);
          else state.capacityConstraint = "capacity_circuit";
        }
        if (endpoints.length === 0) continue;
        const candidates = endpoints.map((endpoint): ScoredRoutingCandidate<string> & { activeConnections: number } => {
          const load = activeConnections.filter(
            (connection) => connection.provider === "proxidize" && connection.endpointId === endpoint.id,
          ).length;
          return {
            candidate: endpoint.id,
            activeConnections: load,
            ...this.#scoreCandidate(
              provider,
              providerRecords.filter((record) => record.proxySlotId === endpoint.id),
              load,
              true,
              providerPressureRecords.filter((record) => record.proxySlotId === endpoint.id),
            ),
          };
        });
        const unsaturated = candidates.filter((candidate) => !candidate.saturated);
        const best = [...(unsaturated.length > 0 ? unsaturated : candidates)].sort(
          (left, right) => left.activeConnections - right.activeConnections || left.candidate.localeCompare(right.candidate),
        )[0];
        if (best !== undefined)
          scored.push({
            candidate: provider,
            score: best.score,
            components: best.components,
            saturated: unsaturated.length === 0,
            activeConnections: best.activeConnections,
          });
      } else {
        if (!(await this.#capacityCircuitEligible(provider.descriptor.id, provider.descriptor.id))) {
          state.capacityConstraint = "capacity_circuit";
          continue;
        }
        const load = activeConnections.filter((connection) => connection.provider === provider.descriptor.id).length;
        scored.push({
          candidate: provider,
          activeConnections: load,
          ...this.#scoreCandidate(provider, providerRecords, load, false, providerPressureRecords),
        });
      }
    }
    const previous = scored.find(({ candidate }) => candidate.descriptor.id === state.previousProvider);
    if (previous !== undefined) {
      const attempts = state.attemptsByProvider.get(previous.candidate.descriptor.id) ?? 0;
      const limit =
        route.targeting.city !== undefined && previous.candidate.descriptor.capabilities.exactCity === "verifiable"
          ? MAX_VERIFICATION_CANDIDATES_PER_PROVIDER
          : MAX_PEERS_PER_PROVIDER;
      if (attempts < limit) {
        return [
          previous.candidate,
          ...scored
            .filter((candidate) => candidate !== previous)
            .sort(
              (left, right) =>
                left.activeConnections - right.activeConnections ||
                left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
            )
            .map(({ candidate }) => candidate),
        ];
      }
    }
    const preferredTier = scored.filter(({ candidate }) => candidate.descriptor.providerClass === preferredClass);
    const fallbackTier = scored.filter(({ candidate }) => candidate.descriptor.providerClass !== preferredClass);
    if (route.sessionMode === "none" && preferredTier.length > 0 && preferredTier.every(({ saturated }) => saturated)) {
      const eligibleFallback = fallbackTier.filter(({ saturated }) => !saturated);
      if (eligibleFallback.length > 0) {
        const orderedFallback = [...eligibleFallback].sort(
          (left, right) =>
            left.activeConnections - right.activeConnections || left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
        );
        const selected = orderedFallback[0];
        const pressureSource = [...preferredTier].sort(
          (left, right) =>
            left.activeConnections - right.activeConnections || left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
        )[0];
        if (pressureSource === undefined) throw new Error("Residential pressure source is unavailable");
        state.capacityDrivenFallback = true;
        state.capacityPressureProvider = pressureSource.candidate.descriptor.id;
        this.logger.info("Residential soft capacity promoted a device-backed fallback", {
          capacityPressureProvider: state.capacityPressureProvider,
          routingPolicyVersion: ROUTING_POLICY.version,
        });
        return [
          ...(selected === undefined ? [] : [selected.candidate]),
          ...orderedFallback.filter((candidate) => candidate !== selected).map(({ candidate }) => candidate),
          ...preferredTier
            .sort(
              (left, right) =>
                left.activeConnections - right.activeConnections ||
                left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
            )
            .map(({ candidate }) => candidate),
          ...fallbackTier
            .filter(({ saturated }) => saturated)
            .sort(
              (left, right) =>
                left.activeConnections - right.activeConnections ||
                left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
            )
            .map(({ candidate }) => candidate),
        ];
      }
    }
    const primaryTier = preferredTier.length > 0 ? preferredTier : scored;
    const unsaturatedPrimary = primaryTier.filter(({ saturated }) => !saturated);
    const selectionTier = unsaturatedPrimary.length > 0 ? unsaturatedPrimary : primaryTier;
    const selected = [...selectionTier].sort(
      (left, right) =>
        left.activeConnections - right.activeConnections || left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
    )[0];
    return [
      ...(selected === undefined ? [] : [selected.candidate]),
      ...primaryTier
        .filter((candidate) => candidate !== selected)
        .sort(
          (left, right) =>
            Number(left.saturated) - Number(right.saturated) ||
            left.activeConnections - right.activeConnections ||
            left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
        )
        .map(({ candidate }) => candidate),
      ...scored
        .filter((candidate) => !primaryTier.includes(candidate))
        .sort(
          (left, right) =>
            Number(left.saturated) - Number(right.saturated) ||
            left.activeConnections - right.activeConnections ||
            left.candidate.descriptor.id.localeCompare(right.candidate.descriptor.id),
        )
        .map(({ candidate }) => candidate),
    ];
  }

  #routeForCredential(
    route: StoredRoute,
    grant: { id: string; principalId: string; jobId?: string },
    credential: { id: string; sessionMode: SessionMode; sessionId?: string },
  ): AuthenticatedRoute {
    const { endpointId: _routeEndpointId, ...profile } = route;
    void _routeEndpointId;
    return {
      ...profile,
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
    const inventory = await this.proxidize.listEndpoints(true, signal);
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
      if (await this.#capacityCircuitEligible("proxidize", endpoint.id)) endpoints.push(endpoint);
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
            ...this.#scoreCandidate(
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
    const profile = validateRouteProfile(input, userId, this.retryDefaults);
    const id = randomUUID();
    const providerAdapter = selectCompatibleProvider(this.#providers.values(), profile);
    if (providerAdapter === undefined) {
      if (profile.providerOverride !== undefined) throw new ProviderOverrideUnsatisfiedError();
      throw new ProviderUnavailableError("No configured provider is compatible with the proxy policy");
    }
    const provider = providerAdapter.descriptor.id;
    const stored = await this.store.create(id, profile, provider);
    this.logger.info("Route created", {
      routeId: id,
      userId,
      customerId: profile.customerId,
      provider,
      ...(profile.providerOverride === undefined ? {} : { providerOverride: profile.providerOverride }),
    });
    return toPublicRoute(stored);
  }

  async update(id: string, input: unknown, userId: string): Promise<PublicRoute> {
    const existing = await this.#ownedRoute(id, userId);
    const profile = validateRouteProfile(input, existing.userId, this.retryDefaults);
    const provider = selectCompatibleProvider(this.#providers.values(), profile, existing.provider)?.descriptor.id;
    if (provider === undefined) {
      if (profile.providerOverride !== undefined) throw new ProviderOverrideUnsatisfiedError();
      throw new ProviderUnavailableError("No configured provider is compatible with the profile policy");
    }

    const updated = await this.store.update(id, profile, provider);
    this.logger.info("Route profile updated", {
      routeId: id,
      customerId: profile.customerId,
      userId: existing.userId,
      provider,
      ...(profile.providerOverride === undefined ? {} : { providerOverride: profile.providerOverride }),
    });
    return toPublicRoute(updated);
  }

  async createAccessGrant(routeId: string, principalId: string, input: unknown): Promise<IssuedAccessGrant> {
    return this.accessGrants.create(routeId, principalId, input);
  }

  async listAccessGrants(routeId: string, principalId: string): Promise<PublicAccessGrant[]> {
    return this.accessGrants.list(routeId, principalId);
  }

  async getAccessGrant(id: string, principalId: string): Promise<PublicAccessGrant> {
    return this.accessGrants.get(id, principalId);
  }

  async getAccessGrantCredential(grantId: string, credentialId: string, principalId: string): Promise<PublicAccessGrantCredential> {
    return this.accessGrants.getCredential(grantId, credentialId, principalId);
  }

  async rotateAccessGrantCredential(
    id: string,
    previousCredentialId: string,
    principalId: string,
    suspectedCompromise = false,
  ): Promise<IssuedAccessGrant> {
    return this.accessGrants.rotateCredential(id, previousCredentialId, principalId, suspectedCompromise);
  }

  async createManagedSession(grantId: string, principalId: string): Promise<IssuedAccessGrant> {
    return this.accessGrants.createManagedSession(grantId, principalId);
  }

  async createStatelessCredential(grantId: string, principalId: string, input: unknown): Promise<IssuedAccessGrant> {
    return this.accessGrants.createStatelessCredential(grantId, principalId, input);
  }

  async listLogicalSessions(grantId: string, principalId: string): Promise<PublicLogicalSession[]> {
    return this.accessGrants.listLogicalSessions(grantId, principalId);
  }

  async getLogicalSession(grantId: string, sessionId: string, principalId: string): Promise<PublicLogicalSession> {
    return this.accessGrants.getLogicalSession(grantId, sessionId, principalId);
  }

  async closeLogicalSession(grantId: string, sessionId: string, principalId: string, force = false): Promise<void> {
    await this.accessGrants.closeLogicalSession(grantId, sessionId, principalId, force);
  }

  async revokeAccessGrantCredential(grantId: string, credentialId: string, principalId: string): Promise<void> {
    await this.accessGrants.revokeCredential(grantId, credentialId, principalId);
  }

  async revokeAccessGrant(id: string, principalId: string, terminateActive = false): Promise<void> {
    await this.accessGrants.revoke(id, principalId, terminateActive);
  }

  async #ownedRoute(id: string, userId: string, includeRevoked = false): Promise<StoredRoute> {
    const route = await this.store.get(id, includeRevoked);
    if (route.userId !== userId) throw new NotFoundError();
    return route;
  }

  async list(userId: string): Promise<PublicRoute[]> {
    return (await this.store.list()).filter((route) => route.userId === userId).map(toPublicRoute);
  }

  async get(id: string, userId: string): Promise<PublicRoute> {
    return toPublicRoute(await this.#ownedRoute(id, userId));
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.#ownedRoute(id, userId);
    for (const grant of await this.store.listAccessGrants(id)) {
      await this.store.revokeAccessGrant(grant.id, false);
    }
    await this.store.revoke(id, false);
    this.logger.info("Route revoked", { routeId: id });
  }

  async emergencyRevoke(id: string): Promise<void> {
    for (const grant of await this.store.listAccessGrants(id)) await this.store.revokeAccessGrant(grant.id, true);
    await this.store.revoke(id, true);
    this.#terminate(this.#activeByRoute.get(id));
    this.logger.warn("Route emergency-revoked; active connections terminated", { routeId: id });
  }

  #terminate(callbacks: Set<() => void> | undefined): void {
    for (const terminate of [...(callbacks ?? [])]) terminate();
  }

  async trackActiveConnection(
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
    const routeCallbacks = this.#activeByRoute.get(routeId) ?? new Set<() => void>();
    routeCallbacks.add(terminate);
    this.#activeByRoute.set(routeId, routeCallbacks);
    const grantCallbacks = this.#activeByGrant.get(accessGrantId) ?? new Set<() => void>();
    grantCallbacks.add(terminate);
    this.#activeByGrant.set(accessGrantId, grantCallbacks);
    const sessionCallbacks = sessionId === undefined ? undefined : (this.#activeBySession.get(sessionId) ?? new Set<() => void>());
    sessionCallbacks?.add(terminate);
    if (sessionId !== undefined && sessionCallbacks !== undefined) this.#activeBySession.set(sessionId, sessionCallbacks);
    let finished = false;
    let nextTunnelHeartbeatAt = 0;
    let nextDeploymentCheckAt = 0;
    const heartbeatIntervalMs = 30_000;
    const check = async (): Promise<void> => {
      if (finished) return;
      if (await this.store.shouldTerminateActive(routeId, accessGrantId, sessionId)) {
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
      sessionCallbacks?.delete(terminate);
      if (sessionId !== undefined && sessionCallbacks?.size === 0) this.#activeBySession.delete(sessionId);
      void this.store.removeActiveTunnel(activeConnectionId).catch(() => undefined);
      if (sessionId !== undefined) {
        void (async () => {
          const session = await this.store.getLogicalSession(sessionId).catch(() => undefined);
          if (session === undefined) return;
          const disconnectedAt = new Date(this.now()).toISOString();
          await this.store.saveLogicalSession(
            { ...session, lastDisconnectedAt: disconnectedAt, updatedAt: disconnectedAt },
            session.bindingVersion,
          );
        })().catch(() => undefined);
      }
    };
  }

  async releaseCandidate(upstream: UpstreamEndpoint | undefined): Promise<void> {
    if (upstream?.activeLoadClaimId === undefined) return;
    const claimId = upstream.activeLoadClaimId;
    delete upstream.activeLoadClaimId;
    await this.store.removeActiveTunnel(claimId);
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
    return this.#routeForCredential(await this.store.get(authenticated.grant.routeId), authenticated.grant, authenticated.credential);
  }

  createResolutionState(): ResolutionState {
    return { attemptsByProvider: new Map(), excludedEndpointIds: new Set(), establishmentWaitMs: 0, sessionRebindRetries: 0 };
  }

  assertProtocolAllowed(route: StoredRoute, protocol: DataPlaneProtocol): void {
    if (!route.allowedProtocols.includes(protocol)) {
      throw new AppError(`Route does not allow the ${protocol} data-plane protocol`, "protocol_not_allowed", 403);
    }
  }

  async assertNewConnectionAllowed(routeId: string, accessGrantId: string, sessionId?: string): Promise<void> {
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
    const grant = await this.store.getAccessGrant(route.accessGrantId);
    const credential = grant.credentials.find((candidate) => candidate.id === route.credentialId);
    if (credential === undefined) throw new AuthenticationError();
    let current = this.#routeForCredential(await this.store.get(route.id), grant, credential);
    if (current.status !== "ready") throw new ProviderUnavailableError(`Route is ${current.status}`);
    current = this.#routeForCredential(
      await this.rotations.applyScheduled(current, context),
      await this.store.getAccessGrant(route.accessGrantId),
      credential,
    );
    this.assertProtocolAllowed(current, protocol);
    const recentTo = new Date(this.now()).toISOString();
    const recentFrom = new Date(this.now() - ROUTING_POLICY.evidenceWindowMs).toISOString();
    const recentRecords = await this.store.listUsageRecords(recentFrom, recentTo);
    const activeConnections = await this.store.listAllActiveTunnels(recentTo);
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
          const activeForSession = activeConnections.filter((connection) => connection.sessionId === logicalSession?.id).length;
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
      await this.#rankProviders(
        [...this.#providers.values()].filter(
          (provider) =>
            providerCompatible(provider, current, protocol, target, current.sessionMode) &&
            (current.providerOverride === undefined || provider.descriptor.id === current.providerOverride),
        ),
        current,
        state,
        recentRecords,
        activeConnections,
        context.signal,
      )
    ).slice(0, MAX_PROVIDERS_PER_OPERATION);
    if (compatibleProviders.length === 0) {
      if (current.providerOverride !== undefined) throw new ProviderOverrideUnsatisfiedError();
      throw new ProviderUnavailableError("No compatible provider is available");
    }
    for (const provider of compatibleProviders) {
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
      let providerRoute: StoredRoute = current;
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
        providerRoute = { ...current, endpointId: slotSelection.endpointId };
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
        endpoint = await provider.resolve(providerRoute, {
          dataPlaneProtocol: protocol,
          target,
          logicalOperationId: context.logicalOperationId,
          sessionMode: current.sessionMode,
          ...(state.preferredAffinityHandle === undefined ? {} : { affinityHandle: state.preferredAffinityHandle }),
          candidateIndex: attempts,
          signal: context.signal,
          excludedEndpointIds: state.excludedEndpointIds,
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
        const providerLoad = activeConnections.filter((connection) => connection.provider === provider.descriptor.id).length;
        const scored = this.#scoreCandidate(provider, providerRecords, providerLoad, false);
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

  async rotate(id: string, principalId: string): Promise<PublicRoute> {
    return this.rotations.request(id, principalId);
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
