import { randomBytes, randomUUID } from "node:crypto";
import { NotFoundError } from "./errors.js";
import type { Logger } from "./logger.js";
import { toPublicAccessGrant, type AccessGrantRepository, type RouteRepository } from "./store.js";
import type { ListenAddress, PublicAccessGrant, PublicAccessGrantCredential, StoredAccessGrant } from "./types.js";

export interface IssuedAccessGrant {
  grant: PublicAccessGrant;
  credential: PublicAccessGrantCredential & { password: string };
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
}

type AccessGrantStore = AccessGrantRepository & Pick<RouteRepository, "get">;

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

  async create(routeId: string, principalId: string): Promise<IssuedAccessGrant> {
    const route = await this.store.get(routeId);
    if (route.userId !== principalId) throw new NotFoundError();
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

  async rotateCredential(id: string, principalId: string, suspectedCompromise = false): Promise<IssuedAccessGrant> {
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
