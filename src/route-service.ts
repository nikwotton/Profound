import { randomBytes, randomUUID } from "node:crypto";
import { CAPACITY_POLICY } from "./capacity-policy.js";
import { capacityCircuitAllowsCandidate } from "./capacity-circuit.js";
import {
  AppError,
  AuthenticationError,
  NotFoundError,
  ProviderOverrideUnsatisfiedError,
  ProviderUnavailableError,
  attributeAssignment,
  attributeProvider,
  isRetryableUpstreamFailure,
  safeErrorMessage,
} from "./errors.js";
import { abortReason } from "./establishment-budget.js";
import type { Logger } from "./logger.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { ProxidizeAdapter } from "./providers/proxidize.js";
import { DEPLOYMENT_POLL_INTERVAL_MS } from "./release-policy.js";
import {
  historicalRoutingEvidence,
  ROUTING_POLICY,
  scoreRoutingCandidate,
  selectTopBandCandidate,
  type RoutingScoreComponents,
  type ScoredRoutingCandidate,
} from "./routing-policy.js";
import { toPublicAccessGrant, toPublicRoute, type RouteStore } from "./store.js";
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
  PublicRoute,
  RetryPolicy,
  RouteProfile,
  StoredRoute,
  UpstreamEndpoint,
  UsageRecord,
} from "./types.js";
import { validateRouteProfile } from "./validation.js";

export interface IssuedAccessGrant {
  grant: PublicAccessGrant;
  credential: PublicAccessGrantCredential & { password: string };
  endpoints: {
    http: string;
    socks5: string;
  };
}

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
}

const MAX_PROVIDERS_PER_OPERATION = 3;
const MAX_PEERS_PER_PROVIDER = 2;
const MAX_VERIFICATION_CANDIDATES_PER_PROVIDER = 3;
const SLOT_MONTH_SECONDS = (365.25 / 12) * 24 * 60 * 60;

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
  const deviceBackedUnauthenticatedOverflow =
    !route.isAuthenticated && route.rotation.mode === "per_request" && provider.descriptor.providerClass === "device_backed";
  if (!capabilities.rotation.has(route.rotation.mode) && !deviceBackedUnauthenticatedOverflow) return false;
  if (target !== undefined && capabilities.targetPorts !== "any_public" && !capabilities.targetPorts.has(target.port)) {
    return false;
  }
  if (
    route.targeting.country !== undefined &&
    capabilities.countries !== undefined &&
    !capabilities.countries.has(route.targeting.country)
  ) {
    return false;
  }
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
  readonly #rotationDisabledSlots = new Set<string>();

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
    _legacyDeviceLeaseIdleTimeoutMs: number,
    private readonly deploymentId: string,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {
    void _legacyDeviceLeaseIdleTimeoutMs;
    this.#providers = new Map([
      [brightData.descriptor.id, brightData],
      [proxidize.descriptor.id, proxidize],
    ]);
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
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ETIMEDOUT") return "timeout";
    if (error instanceof ProviderUnavailableError && /timed out|timeout/i.test(error.message)) return "timeout";
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
    const preferredClass = preferredProviderClass(route);
    const scored: Array<ScoredRoutingCandidate<ProviderAdapter>> = [];
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
        const endpoints = [] as typeof compatibleEndpoints;
        for (const endpoint of compatibleEndpoints) {
          if (await this.#capacityCircuitEligible("proxidize", endpoint.id)) endpoints.push(endpoint);
          else state.capacityConstraint = "capacity_circuit";
        }
        if (endpoints.length === 0) continue;
        const candidates = endpoints.map((endpoint): ScoredRoutingCandidate<string> => {
          const load = activeConnections.filter(
            (connection) => connection.provider === "proxidize" && connection.endpointId === endpoint.id,
          ).length;
          return {
            candidate: endpoint.id,
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
        const best = [...(unsaturated.length > 0 ? unsaturated : candidates)].sort((left, right) => right.score - left.score)[0];
        if (best !== undefined)
          scored.push({ candidate: provider, score: best.score, components: best.components, saturated: unsaturated.length === 0 });
      } else {
        if (!(await this.#capacityCircuitEligible(provider.descriptor.id, provider.descriptor.id))) {
          state.capacityConstraint = "capacity_circuit";
          continue;
        }
        const load = activeConnections.filter((connection) => connection.provider === provider.descriptor.id).length;
        scored.push({
          candidate: provider,
          ...this.#scoreCandidate(provider, providerRecords, load, false, providerPressureRecords),
        });
      }
    }
    const previous = scored.find(({ candidate }) => candidate.descriptor.id === state.previousProvider);
    if (previous !== undefined) {
      const attempts = state.attemptsByProvider.get(previous.candidate.descriptor.id) ?? 0;
      const limit =
        route.isAuthenticated && previous.candidate.descriptor.capabilities.exactCity === "verifiable"
          ? MAX_VERIFICATION_CANDIDATES_PER_PROVIDER
          : MAX_PEERS_PER_PROVIDER;
      if (attempts < limit) {
        return [
          previous.candidate,
          ...scored
            .filter((candidate) => candidate !== previous)
            .sort((a, b) => b.score - a.score)
            .map(({ candidate }) => candidate),
        ];
      }
    }
    const preferredTier = scored.filter(({ candidate }) => candidate.descriptor.providerClass === preferredClass);
    const fallbackTier = scored.filter(({ candidate }) => candidate.descriptor.providerClass !== preferredClass);
    if (!route.isAuthenticated && preferredTier.length > 0 && preferredTier.every(({ saturated }) => saturated)) {
      const eligibleFallback = fallbackTier.filter(({ saturated }) => !saturated);
      if (eligibleFallback.length > 0) {
        const selected = selectTopBandCandidate(eligibleFallback, ROUTING_POLICY, this.random);
        const pressureSource = [...preferredTier].sort((left, right) => right.score - left.score)[0];
        if (pressureSource === undefined) throw new Error("Residential pressure source is unavailable");
        state.capacityDrivenFallback = true;
        state.capacityPressureProvider = pressureSource.candidate.descriptor.id;
        this.logger.info("Residential soft capacity promoted a device-backed fallback", {
          capacityPressureProvider: state.capacityPressureProvider,
          routingPolicyVersion: ROUTING_POLICY.version,
        });
        return [
          ...(selected === undefined ? [] : [selected.candidate]),
          ...eligibleFallback
            .filter((candidate) => candidate !== selected)
            .sort((left, right) => right.score - left.score)
            .map(({ candidate }) => candidate),
          ...preferredTier.sort((left, right) => right.score - left.score).map(({ candidate }) => candidate),
          ...fallbackTier
            .filter(({ saturated }) => saturated)
            .sort((left, right) => right.score - left.score)
            .map(({ candidate }) => candidate),
        ];
      }
    }
    const primaryTier = preferredTier.length > 0 ? preferredTier : scored;
    const unsaturatedPrimary = primaryTier.filter(({ saturated }) => !saturated);
    const selectionTier = unsaturatedPrimary.length > 0 ? unsaturatedPrimary : primaryTier;
    const selected = selectTopBandCandidate(selectionTier, ROUTING_POLICY, this.random);
    return [
      ...(selected === undefined ? [] : [selected.candidate]),
      ...primaryTier
        .filter((candidate) => candidate !== selected)
        .sort((left, right) => Number(left.saturated) - Number(right.saturated) || right.score - left.score)
        .map(({ candidate }) => candidate),
      ...scored
        .filter((candidate) => !primaryTier.includes(candidate))
        .sort((left, right) => Number(left.saturated) - Number(right.saturated) || right.score - left.score)
        .map(({ candidate }) => candidate),
    ];
  }

  #routeForGrant(route: StoredRoute, grant: { id: string; principalId: string }): AuthenticatedRoute {
    const { endpointId: _routeEndpointId, ...profile } = route;
    void _routeEndpointId;
    return {
      ...profile,
      userId: grant.principalId,
      accessGrantId: grant.id,
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
    const endpoints = [] as typeof compatibleEndpoints;
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
        const unsaturated = candidates.filter((candidate) => !candidate.saturated);
        selected = selectTopBandCandidate(unsaturated.length > 0 ? unsaturated : candidates, ROUTING_POLICY, this.random);
        if (selected === undefined) throw new ProviderUnavailableError("No scored mobile proxy slot is available");
        return selected.candidate.id;
      },
      (endpointId) => ({
        id: randomUUID(),
        deploymentId: this.deploymentId,
        routeId: route.id,
        accessGrantId: route.accessGrantId,
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
    const candidates = [...this.#providers.values()]
      .filter(
        (provider) =>
          compatible(provider, profile) && (profile.providerOverride === undefined || provider.descriptor.id === profile.providerOverride),
      )
      .sort((left, right) => compareProviders(left, right, profile));
    const providerAdapter = candidates[0];
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
      isTargetAuthenticated: profile.isTargetAuthenticated,
    });
    return toPublicRoute(stored);
  }

  async update(id: string, input: unknown, userId: string): Promise<PublicRoute> {
    const existing = await this.#ownedRoute(id, userId);
    const profile = validateRouteProfile(input, existing.userId, this.retryDefaults);
    const candidates = [...this.#providers.values()]
      .filter(
        (provider) =>
          compatible(provider, profile) && (profile.providerOverride === undefined || provider.descriptor.id === profile.providerOverride),
      )
      .sort((left, right) => compareProviders(left, right, profile, existing.provider));
    const provider = candidates[0]?.descriptor.id;
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

  #proxyEndpoints(): IssuedAccessGrant["endpoints"] {
    const addresses = this.proxyAddresses();
    return {
      http: `${this.advertisedHttpProxyProtocol}://${this.advertisedProxyHost}:${addresses.http.port}`,
      // socks5h asks URL-aware clients to preserve domain names for proxy-side resolution.
      socks5: `socks5h://${this.advertisedProxyHost}:${addresses.socks5.port}`,
    };
  }

  async #issueAccessGrant(routeId: string, principalId: string): Promise<IssuedAccessGrant> {
    await this.store.get(routeId);
    const grantId = randomUUID();
    const credentialId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const grant = await this.store.createAccessGrant(grantId, routeId, principalId, credentialId, token);
    const publicGrant = toPublicAccessGrant(grant);
    const credential = publicGrant.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (credential === undefined) throw new Error("New access-grant credential was not persisted");
    this.logger.info("Access grant issued", { routeId, accessGrantId: grantId, userId: principalId });
    return {
      grant: publicGrant,
      credential: { ...credential, password: token },
      endpoints: this.#proxyEndpoints(),
    };
  }

  async createAccessGrant(routeId: string, principalId: string): Promise<IssuedAccessGrant> {
    await this.#ownedRoute(routeId, principalId);
    return this.#issueAccessGrant(routeId, principalId);
  }

  async listAccessGrants(routeId: string, principalId: string): Promise<PublicAccessGrant[]> {
    await this.#ownedRoute(routeId, principalId);
    return (await this.store.listAccessGrants(routeId, principalId)).map(toPublicAccessGrant);
  }

  async getAccessGrant(id: string, principalId: string): Promise<PublicAccessGrant> {
    return toPublicAccessGrant(await this.#ownedAccessGrant(id, principalId, true));
  }

  async getAccessGrantCredential(grantId: string, credentialId: string, principalId: string): Promise<PublicAccessGrantCredential> {
    const grant = await this.getAccessGrant(grantId, principalId);
    const credential = grant.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (credential === undefined) throw new NotFoundError();
    return credential;
  }

  async rotateAccessGrantCredential(id: string, principalId: string, suspectedCompromise = false): Promise<IssuedAccessGrant> {
    const existing = await this.#ownedAccessGrant(id, principalId);
    const credentialId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const rotated = await this.store.rotateAccessGrantCredential(existing.id, credentialId, token, suspectedCompromise);
    const grant = toPublicAccessGrant(rotated);
    const credential = grant.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (credential === undefined) throw new Error("Rotated access-grant credential was not persisted");
    this.logger.info("Access grant credential rotated", {
      routeId: existing.routeId,
      accessGrantId: existing.id,
      userId: principalId,
      suspectedCompromise,
    });
    return {
      grant,
      credential: { ...credential, password: token },
      endpoints: this.#proxyEndpoints(),
    };
  }

  async revokeAccessGrantCredential(grantId: string, credentialId: string, principalId: string): Promise<void> {
    await this.#ownedAccessGrant(grantId, principalId, true);
    await this.store.revokeAccessGrantCredential(grantId, credentialId);
    this.logger.info("Access grant credential revoked", { accessGrantId: grantId, credentialId, userId: principalId });
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
    let finished = false;
    let nextTunnelHeartbeatAt = 0;
    let nextDeploymentCheckAt = 0;
    const heartbeatIntervalMs = 30_000;
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
      void this.store.removeActiveTunnel(activeConnectionId).catch(() => undefined);
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
    const grant = await this.store.authenticateAccessGrant(id, token);
    if (grant === undefined) throw new AuthenticationError();
    return this.#routeForGrant(await this.store.get(grant.routeId), grant);
  }

  createResolutionState(): ResolutionState {
    return { attemptsByProvider: new Map(), excludedEndpointIds: new Set(), establishmentWaitMs: 0 };
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
    const recentTo = new Date(this.now()).toISOString();
    const recentFrom = new Date(this.now() - ROUTING_POLICY.evidenceWindowMs).toISOString();
    const recentRecords = await this.store.listUsageRecords(recentFrom, recentTo);
    const activeConnections = await this.store.listAllActiveTunnels(recentTo);
    const compatibleProviders = (
      await this.#rankProviders(
        [...this.#providers.values()].filter(
          (provider) =>
            compatible(provider, current, protocol, target) &&
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
      if (current.isAuthenticated && provider.descriptor.capabilities.exactCity === "verifiable") {
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
    const route: AuthenticatedRoute = this.#routeForGrant(await this.store.get(id), grant);
    if (route.provider === "proxidize") {
      throw new AppError("Device-backed slot assignment and rerouting are internal", "rotation_not_supported", 409);
    }
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
