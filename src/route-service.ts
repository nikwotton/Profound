import { randomBytes, randomUUID } from "node:crypto";
import { AuthenticationError, ProviderUnavailableError, errorMessage } from "./errors.js";
import type { Logger } from "./logger.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { ProxidizeAdapter } from "./providers/proxidize.js";
import { RouteStore, toPublicRoute } from "./store.js";
import { Telemetry } from "./telemetry.js";
import type {
  ListenAddress,
  ProviderHealth,
  PublicRoute,
  StoredRoute,
  UpstreamEndpoint,
} from "./types.js";
import { validateRouteProfile } from "./validation.js";

export interface CreatedRoute {
  route: PublicRoute;
  proxyUrl: string;
}

export class RouteService {
  constructor(
    private readonly store: RouteStore,
    private readonly brightData: ProviderAdapter,
    private readonly proxidize: ProxidizeAdapter,
    private readonly proxyAddress: () => ListenAddress,
    private readonly advertisedProxyHost: string,
    private readonly logger: Logger,
    private readonly telemetry: Telemetry,
  ) {}

  async create(input: unknown): Promise<CreatedRoute> {
    const profile = validateRouteProfile(input);
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const provider = profile.kind === "residential" ? "bright_data" : "proxidize";
    let endpointId: string | undefined;

    if (profile.kind === "mobile") {
      const endpoints = (await this.proxidize.listEndpoints(true)).filter(
        (endpoint) =>
          endpoint.healthy &&
          this.store.assignmentCount(endpoint.id) === 0 &&
          this.proxidize.matches(endpoint, { targeting: profile.targeting }),
      );
      if (endpoints.length === 0) {
        throw new ProviderUnavailableError("No unassigned healthy mobile device matches the requested targeting");
      }
      endpoints.sort((left, right) => {
        const countDifference = this.store.assignmentCount(left.id) - this.store.assignmentCount(right.id);
        return countDifference === 0 ? left.id.localeCompare(right.id) : countDifference;
      });
      endpointId = endpoints[0]?.id;
      if (endpointId === undefined) throw new ProviderUnavailableError("No mobile endpoint could be assigned");
      await this.proxidize.setRotationInterval(
        endpointId,
        profile.rotation.mode === "interval" ? profile.rotation.intervalSeconds : undefined,
      );
    }

    const stored = this.store.create(id, profile, token, provider, endpointId);
    const address = this.proxyAddress();
    const proxyUrl = `http://${encodeURIComponent(id)}:${encodeURIComponent(token)}@${this.advertisedProxyHost}:${address.port}`;
    this.logger.info("Route created", { routeId: id, provider, kind: profile.kind, endpointId });
    return { route: toPublicRoute(stored), proxyUrl };
  }

  list(): PublicRoute[] {
    return this.store.list().map(toPublicRoute);
  }

  get(id: string): PublicRoute {
    return toPublicRoute(this.store.get(id));
  }

  delete(id: string): void {
    this.store.revoke(id);
    this.logger.info("Route revoked", { routeId: id });
  }

  authenticate(id: string, token: string): StoredRoute {
    const route = this.store.authenticate(id, token);
    if (route === undefined) throw new AuthenticationError();
    return route;
  }

  async resolve(route: StoredRoute): Promise<UpstreamEndpoint> {
    const current = this.store.get(route.id);
    if (current.status !== "ready") {
      throw new ProviderUnavailableError(`Route is ${current.status}`);
    }
    return current.provider === "bright_data"
      ? this.brightData.resolve(current)
      : this.proxidize.resolve(current);
  }

  rotate(id: string): PublicRoute {
    const route = this.store.get(id);
    this.store.setStatus(id, "rotating");
    setImmediate(() => {
      void this.#performRotation(route);
    });
    return toPublicRoute(this.store.get(id));
  }

  async #performRotation(route: StoredRoute): Promise<void> {
    try {
      if (route.provider === "bright_data") {
        this.store.incrementRotationEpoch(route.id);
        await this.brightData.rotate(this.store.get(route.id));
      } else {
        await this.proxidize.rotate(route);
      }
      this.store.setStatus(route.id, "ready");
      this.telemetry.recordRotation(route.provider, "success");
      this.logger.info("Route rotation completed", { routeId: route.id, provider: route.provider });
    } catch (error) {
      const message = errorMessage(error);
      this.store.setStatus(route.id, "failed", message);
      this.telemetry.recordRotation(route.provider, "failure");
      this.logger.warn("Route rotation failed", { routeId: route.id, provider: route.provider, error: message });
    }
  }

  async refreshHealth(): Promise<ProviderHealth[]> {
    const health = await Promise.all([this.brightData.health(), this.proxidize.health()]);
    for (const item of health) this.store.saveHealth(item);
    return health;
  }

  storedHealth(): ProviderHealth[] {
    return this.store.listHealth();
  }

  async ready(): Promise<boolean> {
    const health = await this.refreshHealth();
    return health.every((item) => item.state !== "unhealthy");
  }
}
