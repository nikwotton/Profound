import { randomBytes, randomUUID } from "node:crypto";
import { NotFoundError, ValidationError } from "./errors.js";
import type { Logger } from "./logger.js";
import {
  toPublicAccessGrant,
  toPublicLogicalSession,
  type AccessGrantRepository,
  type LogicalSessionRepository,
  type RouteRepository,
} from "./store.js";
import type {
  ListenAddress,
  PublicAccessGrant,
  PublicAccessGrantCredential,
  PublicLogicalSession,
  SessionMode,
  StoredAccessGrant,
  StoredLogicalSession,
} from "./types.js";
import { validateGrantIssuance, validateSessionMode } from "./validation.js";

export interface IssuedAccessGrant {
  grant: PublicAccessGrant;
  credential: PublicAccessGrantCredential & { password: string };
  session?: PublicLogicalSession;
  endpoints: {
    http: string;
    socks5: string;
  };
}

export interface AccessGrantServiceOptions {
  proxyAddresses: () => { http: ListenAddress; socks5: ListenAddress };
  advertisedProxyHost: string;
  advertisedHttpProxyProtocol: "http" | "https";
  terminateActiveGrant: (grantId: string) => void;
  terminateActiveSession: (sessionId: string) => void;
  now?: () => number;
}

type AccessGrantStore = AccessGrantRepository & LogicalSessionRepository & Pick<RouteRepository, "get">;

export class AccessGrantService {
  constructor(
    private readonly store: AccessGrantStore,
    private readonly options: AccessGrantServiceOptions,
    private readonly logger: Logger,
  ) {}

  #proxyEndpoints(): IssuedAccessGrant["endpoints"] {
    const addresses = this.options.proxyAddresses();
    return {
      http: `${this.options.advertisedHttpProxyProtocol}://${this.options.advertisedProxyHost}:${addresses.http.port}`,
      // socks5h asks URL-aware clients to preserve domain names for proxy-side resolution.
      socks5: `socks5h://${this.options.advertisedProxyHost}:${addresses.socks5.port}`,
    };
  }

  async #ownedAccessGrant(id: string, principalId: string, includeRevoked = false): Promise<StoredAccessGrant> {
    const grant = await this.store.getAccessGrant(id, includeRevoked);
    if (grant.principalId !== principalId) throw new NotFoundError();
    return grant;
  }

  #newLogicalSession(id: string, grantId: string, routeId: string): StoredLogicalSession {
    const now = new Date(this.options.now?.() ?? Date.now()).toISOString();
    return {
      id,
      grantId,
      routeId,
      status: "open",
      terminateActive: false,
      bindingVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async #issue(routeId: string, principalId: string, sessionMode: SessionMode, jobId?: string): Promise<IssuedAccessGrant> {
    const grantId = randomUUID();
    const credentialId = randomUUID();
    const sessionId = sessionMode === "managed" ? randomUUID() : undefined;
    const token = randomBytes(32).toString("base64url");
    const grant = await this.store.createAccessGrant(grantId, routeId, principalId, credentialId, token, sessionMode, sessionId, jobId);
    const session = sessionId === undefined ? undefined : this.#newLogicalSession(sessionId, grantId, routeId);
    if (session !== undefined) await this.store.createLogicalSession(session);
    const publicGrant = toPublicAccessGrant(grant);
    const credential = publicGrant.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (credential === undefined) throw new Error("New access-grant credential was not persisted");
    this.logger.info("Access grant issued", { routeId, accessGrantId: grantId, userId: principalId });
    return {
      grant: publicGrant,
      credential: { ...credential, password: token },
      ...(session === undefined ? {} : { session: toPublicLogicalSession(session) }),
      endpoints: this.#proxyEndpoints(),
    };
  }

  async create(routeId: string, principalId: string, input: unknown): Promise<IssuedAccessGrant> {
    const route = await this.store.get(routeId);
    if (route.userId !== principalId) throw new NotFoundError();
    const issuance = validateGrantIssuance(input);
    return this.#issue(routeId, principalId, issuance.sessionMode, issuance.jobId);
  }

  async createManagedSession(grantId: string, principalId: string): Promise<IssuedAccessGrant> {
    const existing = await this.#ownedAccessGrant(grantId, principalId);
    const sessionId = randomUUID();
    const credentialId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const session = this.#newLogicalSession(sessionId, existing.id, existing.routeId);
    await this.store.createLogicalSession(session);
    const grant = await this.store.addAccessGrantCredential(existing.id, credentialId, token, "managed", sessionId);
    const publicGrant = toPublicAccessGrant(grant);
    const credential = publicGrant.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (credential === undefined) throw new Error("Managed-session credential was not persisted");
    return {
      grant: publicGrant,
      session: toPublicLogicalSession(session),
      credential: { ...credential, password: token },
      endpoints: this.#proxyEndpoints(),
    };
  }

  async createStatelessCredential(grantId: string, principalId: string, input: unknown): Promise<IssuedAccessGrant> {
    if (validateSessionMode(input) !== "none") {
      throw new ValidationError("Stateless credential issuance requires sessionMode none");
    }
    const existing = await this.#ownedAccessGrant(grantId, principalId);
    const credentialId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const grant = await this.store.addAccessGrantCredential(existing.id, credentialId, token, "none");
    const publicGrant = toPublicAccessGrant(grant);
    const credential = publicGrant.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (credential === undefined) throw new Error("Stateless credential was not persisted");
    return { grant: publicGrant, credential: { ...credential, password: token }, endpoints: this.#proxyEndpoints() };
  }

  async listLogicalSessions(grantId: string, principalId: string): Promise<PublicLogicalSession[]> {
    await this.#ownedAccessGrant(grantId, principalId, true);
    return (await this.store.listLogicalSessions(grantId)).map(toPublicLogicalSession);
  }

  async getLogicalSession(grantId: string, sessionId: string, principalId: string): Promise<PublicLogicalSession> {
    await this.#ownedAccessGrant(grantId, principalId, true);
    const session = await this.store.getLogicalSession(sessionId, true);
    if (session.grantId !== grantId) throw new NotFoundError();
    return toPublicLogicalSession(session);
  }

  async closeLogicalSession(grantId: string, sessionId: string, principalId: string, force = false): Promise<void> {
    await this.#ownedAccessGrant(grantId, principalId, true);
    const session = await this.store.getLogicalSession(sessionId, true);
    if (session.grantId !== grantId) throw new NotFoundError();
    await this.store.closeLogicalSession(sessionId, force);
    if (force) this.options.terminateActiveSession(sessionId);
  }

  async list(routeId: string, principalId: string): Promise<PublicAccessGrant[]> {
    const route = await this.store.get(routeId);
    if (route.userId !== principalId) throw new NotFoundError();
    return (await this.store.listAccessGrants(routeId, principalId)).map(toPublicAccessGrant);
  }

  async get(id: string, principalId: string): Promise<PublicAccessGrant> {
    return toPublicAccessGrant(await this.#ownedAccessGrant(id, principalId, true));
  }

  async getCredential(grantId: string, credentialId: string, principalId: string): Promise<PublicAccessGrantCredential> {
    const grant = await this.get(grantId, principalId);
    const credential = grant.credentials.find((candidate) => candidate.credentialId === credentialId);
    if (credential === undefined) throw new NotFoundError();
    return credential;
  }

  async rotateCredential(
    id: string,
    previousCredentialId: string,
    principalId: string,
    suspectedCompromise = false,
  ): Promise<IssuedAccessGrant> {
    const existing = await this.#ownedAccessGrant(id, principalId);
    const credentialId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const rotated = await this.store.rotateAccessGrantCredential(
      existing.id,
      previousCredentialId,
      credentialId,
      token,
      suspectedCompromise,
    );
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

  async revokeCredential(grantId: string, credentialId: string, principalId: string): Promise<void> {
    await this.#ownedAccessGrant(grantId, principalId, true);
    await this.store.revokeAccessGrantCredential(grantId, credentialId);
    this.logger.info("Access grant credential revoked", { accessGrantId: grantId, credentialId, userId: principalId });
  }

  async revoke(id: string, principalId: string, terminateActive = false): Promise<void> {
    const grant = await this.#ownedAccessGrant(id, principalId, true);
    await this.store.revokeAccessGrant(id, terminateActive);
    if (terminateActive) this.options.terminateActiveGrant(id);
    this.logger.info("Access grant revoked", {
      routeId: grant.routeId,
      accessGrantId: id,
      userId: principalId,
      terminateActive,
    });
  }
}
