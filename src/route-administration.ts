import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { AccessGrantService, type IssuedAccessGrant } from "./access-grant-service.js";
import {
  NotFoundError,
  ProviderOverrideUnsatisfiedError,
  ProviderUnavailableError,
  type RouteServiceError,
  toRouteServiceError,
} from "./errors.js";
import type { Logger } from "./logger.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { selectCompatibleProvider } from "./provider-selection.js";
import { toPublicRoute, type AccessGrantRepository, type LogicalSessionRepository, type RouteRepository } from "./store.js";
import type { ListenAddress } from "./domain/network.js";
import type {
  PublicAccessGrant,
  PublicAccessGrantCredential,
  PublicLogicalSession,
  PublicRoute,
  RetryPolicy,
  StoredRoute,
} from "./domain/routing.js";
import { validateRouteProfile } from "./validation.js";

export type { IssuedAccessGrant } from "./access-grant-service.js";

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
  createStatelessCredential(grantId: string, principalId: string): Effect.Effect<IssuedAccessGrant, RouteServiceError>;
  listLogicalSessions(grantId: string, principalId: string): Effect.Effect<PublicLogicalSession[], RouteServiceError>;
  getLogicalSession(grantId: string, sessionId: string, principalId: string): Effect.Effect<PublicLogicalSession, RouteServiceError>;
  closeLogicalSession(grantId: string, sessionId: string, principalId: string, force?: boolean): Effect.Effect<void, RouteServiceError>;
}

export interface ControlPlaneRouteService {
  readonly effects: RouteServiceEffects;
}

export type RouteAdministrationStore = RouteRepository & AccessGrantRepository & LogicalSessionRepository;

export interface RouteAdministrationDependencies {
  store: RouteAdministrationStore;
  providers: Iterable<ProviderAdapter>;
  proxyAddresses: () => { http: ListenAddress; socks5: ListenAddress };
  advertisedProxyHost: string;
  advertisedHttpProxyProtocol: "http" | "https";
  logger: Logger;
  retryDefaults: RetryPolicy;
  now?: () => number;
  terminateActiveGrant?: (grantId: string) => void;
  terminateActiveSession?: (sessionId: string) => void;
}

export class RouteAdministrationService implements ControlPlaneRouteService {
  readonly effects: RouteServiceEffects;
  readonly #providers: readonly ProviderAdapter[];
  readonly #accessGrants: AccessGrantService;
  readonly #now: () => number;

  constructor(private readonly dependencies: RouteAdministrationDependencies) {
    this.#providers = [...dependencies.providers];
    this.#now = dependencies.now ?? Date.now;
    this.#accessGrants = new AccessGrantService(
      dependencies.store,
      {
        proxyAddresses: dependencies.proxyAddresses,
        advertisedProxyHost: dependencies.advertisedProxyHost,
        advertisedHttpProxyProtocol: dependencies.advertisedHttpProxyProtocol,
        terminateActiveGrant: dependencies.terminateActiveGrant ?? (() => undefined),
        terminateActiveSession: dependencies.terminateActiveSession ?? (() => undefined),
        now: this.#now,
      },
      dependencies.logger,
    );
    const attempt = <A>(operation: () => Promise<A>): Effect.Effect<A, RouteServiceError> =>
      Effect.tryPromise({
        try: operation,
        catch: (error) => {
          const normalized = toRouteServiceError(error);
          if (normalized.kind === "internal") {
            dependencies.logger.error("Route administration operation failed unexpectedly", { error: normalized });
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
      createStatelessCredential: (grantId, principalId) => attempt(() => this.createStatelessCredential(grantId, principalId)),
      listLogicalSessions: (grantId, principalId) => attempt(() => this.listLogicalSessions(grantId, principalId)),
      getLogicalSession: (grantId, sessionId, principalId) => attempt(() => this.getLogicalSession(grantId, sessionId, principalId)),
      closeLogicalSession: (grantId, sessionId, principalId, force) =>
        attempt(() => this.closeLogicalSession(grantId, sessionId, principalId, force)),
    };
  }

  async ready(): Promise<boolean> {
    await this.dependencies.store.list();
    return true;
  }

  async create(input: unknown, userId: string): Promise<PublicRoute> {
    const profile = validateRouteProfile(input, userId, this.dependencies.retryDefaults);
    const provider = selectCompatibleProvider(this.#providers, profile);
    if (provider === undefined) {
      if (profile.providerOverride !== undefined) throw new ProviderOverrideUnsatisfiedError();
      throw new ProviderUnavailableError("No configured provider is compatible with the proxy policy");
    }
    const id = randomUUID();
    const stored = await this.dependencies.store.create(id, profile);
    this.dependencies.logger.info("Route created", {
      routeId: id,
      userId,
      customerId: profile.customerId,
      eligibleProvider: provider.descriptor.id,
      ...(profile.providerOverride === undefined ? {} : { providerOverride: profile.providerOverride }),
    });
    return toPublicRoute(stored);
  }

  async update(id: string, input: unknown, userId: string): Promise<PublicRoute> {
    const existing = await this.#ownedRoute(id, userId);
    const profile = validateRouteProfile(input, existing.userId, this.dependencies.retryDefaults);
    const provider = selectCompatibleProvider(this.#providers, profile)?.descriptor.id;
    if (provider === undefined) {
      if (profile.providerOverride !== undefined) throw new ProviderOverrideUnsatisfiedError();
      throw new ProviderUnavailableError("No configured provider is compatible with the profile policy");
    }
    const updated = await this.dependencies.store.update(id, profile);
    this.dependencies.logger.info("Route profile updated", {
      routeId: id,
      customerId: profile.customerId,
      userId: existing.userId,
      eligibleProvider: provider,
      ...(profile.providerOverride === undefined ? {} : { providerOverride: profile.providerOverride }),
    });
    return toPublicRoute(updated);
  }

  async createAccessGrant(routeId: string, principalId: string, input: unknown): Promise<IssuedAccessGrant> {
    return this.#accessGrants.create(routeId, principalId, input);
  }

  async listAccessGrants(routeId: string, principalId: string): Promise<PublicAccessGrant[]> {
    return this.#accessGrants.list(routeId, principalId);
  }

  async getAccessGrant(id: string, principalId: string): Promise<PublicAccessGrant> {
    return this.#accessGrants.get(id, principalId);
  }

  async getAccessGrantCredential(grantId: string, credentialId: string, principalId: string): Promise<PublicAccessGrantCredential> {
    return this.#accessGrants.getCredential(grantId, credentialId, principalId);
  }

  async rotateAccessGrantCredential(
    id: string,
    previousCredentialId: string,
    principalId: string,
    suspectedCompromise = false,
  ): Promise<IssuedAccessGrant> {
    return this.#accessGrants.rotateCredential(id, previousCredentialId, principalId, suspectedCompromise);
  }

  async createManagedSession(grantId: string, principalId: string): Promise<IssuedAccessGrant> {
    return this.#accessGrants.createManagedSession(grantId, principalId);
  }

  async createStatelessCredential(grantId: string, principalId: string): Promise<IssuedAccessGrant> {
    return this.#accessGrants.createStatelessCredential(grantId, principalId);
  }

  async listLogicalSessions(grantId: string, principalId: string): Promise<PublicLogicalSession[]> {
    return this.#accessGrants.listLogicalSessions(grantId, principalId);
  }

  async getLogicalSession(grantId: string, sessionId: string, principalId: string): Promise<PublicLogicalSession> {
    return this.#accessGrants.getLogicalSession(grantId, sessionId, principalId);
  }

  async closeLogicalSession(grantId: string, sessionId: string, principalId: string, force = false): Promise<void> {
    await this.#accessGrants.closeLogicalSession(grantId, sessionId, principalId, force);
  }

  async revokeAccessGrantCredential(grantId: string, credentialId: string, principalId: string): Promise<void> {
    await this.#accessGrants.revokeCredential(grantId, credentialId, principalId);
  }

  async revokeAccessGrant(id: string, principalId: string, terminateActive = false): Promise<void> {
    await this.#accessGrants.revoke(id, principalId, terminateActive);
  }

  async #ownedRoute(id: string, userId: string, includeRevoked = false): Promise<StoredRoute> {
    const route = await this.dependencies.store.get(id, includeRevoked);
    if (route.userId !== userId) throw new NotFoundError();
    return route;
  }

  async list(userId: string): Promise<PublicRoute[]> {
    return (await this.dependencies.store.list(userId)).map(toPublicRoute);
  }

  async get(id: string, userId: string): Promise<PublicRoute> {
    return toPublicRoute(await this.#ownedRoute(id, userId));
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.#ownedRoute(id, userId);
    for (const grant of await this.dependencies.store.listAccessGrants(id)) {
      await this.dependencies.store.revokeAccessGrant(grant.id, false);
    }
    await this.dependencies.store.revoke(id, false);
    this.dependencies.logger.info("Route revoked", { routeId: id });
  }

  async emergencyRevoke(id: string): Promise<void> {
    for (const grant of await this.dependencies.store.listAccessGrants(id)) {
      await this.dependencies.store.revokeAccessGrant(grant.id, true);
      this.dependencies.terminateActiveGrant?.(grant.id);
    }
    await this.dependencies.store.revoke(id, true);
    this.dependencies.logger.warn("Route emergency-revoked; active connections terminated", { routeId: id });
  }
}
