import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "@effect/platform";
import { Context, Schema } from "effect";

export const CONTROL_API_VERSION = "0.5.0";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { code: Schema.String, message: Schema.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { code: Schema.String, message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class RouteNotFound extends Schema.TaggedError<RouteNotFound>()(
  "RouteNotFound",
  { code: Schema.String, message: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  "ServiceUnavailable",
  { code: Schema.String, message: Schema.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  { code: Schema.String, message: Schema.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export class AuthenticatedUser extends Context.Tag("Profound/AuthenticatedUser")<AuthenticatedUser, { readonly userId: string }>() {}

export class AdminAuthorization extends HttpApiMiddleware.Tag<AdminAuthorization>()("Profound/AdminAuthorization", {
  failure: Unauthorized,
  provides: AuthenticatedUser,
  security: {
    bearer: HttpApiSecurity.bearer.pipe(
      HttpApiSecurity.annotate(OpenApi.Description, "Administrator token supplied through CONTROL_API_TOKEN"),
    ),
  },
}) {}

const Targeting = Schema.Struct({
  country: Schema.String,
  region: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  postalCode: Schema.optional(Schema.String),
  asn: Schema.optional(Schema.Number),
  carrier: Schema.optional(Schema.String),
}).annotations({ identifier: "Targeting" });

const Rotation = Schema.Union(
  Schema.Struct({ mode: Schema.Literal("per_request") }),
  Schema.Struct({ mode: Schema.Literal("interval"), intervalSeconds: Schema.Number }),
  Schema.Struct({ mode: Schema.Literal("manual") }),
).annotations({ identifier: "RotationPolicy" });

export const RouteProfilePayload = Schema.Struct({
  name: Schema.String,
  allowedProtocols: Schema.optional(Schema.Array(Schema.Literal("http", "https", "socks5"))),
  targeting: Targeting,
  rotation: Schema.optional(Rotation),
  session: Schema.optional(
    Schema.Struct({
      mode: Schema.Literal("none", "sticky"),
      id: Schema.optional(Schema.String),
      requireGeographicContinuity: Schema.optional(Schema.Boolean),
    }),
  ),
  customerId: Schema.String,
  isAuthenticated: Schema.Boolean,
  shouldRetry: Schema.Boolean,
  retryPolicy: Schema.optional(
    Schema.Struct({
      maxAttempts: Schema.optional(Schema.Number),
    }),
  ),
  forceProvider: Schema.optional(Schema.Literal("bright_data", "proxidize")),
}).annotations({ identifier: "RouteProfileInput" });

const PublicRoute = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  allowedProtocols: Schema.Array(Schema.Literal("http", "https", "socks5")),
  targeting: Targeting,
  rotation: Rotation,
  session: Schema.Union(
    Schema.Struct({ mode: Schema.Literal("none"), requireGeographicContinuity: Schema.Literal(false) }),
    Schema.Struct({
      mode: Schema.Literal("sticky"),
      id: Schema.optional(Schema.String),
      requireGeographicContinuity: Schema.Boolean,
    }),
  ),
  customerId: Schema.String,
  userId: Schema.String,
  isAuthenticated: Schema.Boolean,
  shouldRetry: Schema.Boolean,
  retryPolicy: Schema.Struct({ maxAttempts: Schema.Number }),
  forceProvider: Schema.optional(Schema.Literal("bright_data", "proxidize")),
  provider: Schema.Literal("bright_data", "proxidize"),
  status: Schema.Literal("ready", "rotating", "failed", "revoked"),
  lastError: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "Route" });

const PublicAccessGrantCredential = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("active", "overlap", "revoked", "expired"),
  createdAt: Schema.String,
  renewalDueAt: Schema.String,
  renewalDue: Schema.Boolean,
  expiresAt: Schema.String,
  revokeAt: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.String),
}).annotations({ identifier: "AccessGrantCredential" });

const PublicAccessGrant = Schema.Struct({
  id: Schema.String,
  routeId: Schema.String,
  principalId: Schema.String,
  status: Schema.Literal("ready", "revoked"),
  credentials: Schema.Array(PublicAccessGrantCredential),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "AccessGrant" });

const IssuedAccessGrant = Schema.Struct({
  accessGrant: PublicAccessGrant,
  credential: PublicAccessGrantCredential,
  proxyUsername: Schema.String,
  proxyUrls: Schema.Struct({ http: Schema.String, socks5: Schema.String }),
}).annotations({ identifier: "IssuedAccessGrant" });

const CreatedRoute = Schema.Struct({
  route: PublicRoute,
  accessGrant: PublicAccessGrant,
  credential: PublicAccessGrantCredential,
  proxyUsername: Schema.String,
  proxyUrls: Schema.Struct({ http: Schema.String, socks5: Schema.String }),
}).annotations({ identifier: "CreatedRoute" });

const RouteResponse = Schema.Struct({ route: PublicRoute });
const RoutesResponse = Schema.Struct({ data: Schema.Array(PublicRoute) });
const AccessGrantsResponse = Schema.Struct({ data: Schema.Array(PublicAccessGrant) });
const LiveResponse = Schema.Struct({ status: Schema.Literal("live") });
const ReadyResponse = Schema.Struct({ status: Schema.Literal("ready") });
const ProviderHealth = Schema.Struct({
  provider: Schema.Literal("bright_data", "proxidize"),
  state: Schema.Literal("healthy", "degraded", "unhealthy"),
  checkedAt: Schema.String,
  message: Schema.optional(Schema.String),
});
const ProvidersHealthResponse = Schema.Struct({ data: Schema.Array(ProviderHealth) });
const ProviderDescriptor = Schema.Struct({
  id: Schema.Literal("bright_data", "proxidize"),
  providerClass: Schema.Literal("residential", "device_backed"),
  capabilities: Schema.Struct({
    clientProtocols: Schema.Array(Schema.String),
    upstreamProtocols: Schema.Array(Schema.String),
    authenticatedTraffic: Schema.Boolean,
    unauthenticatedTraffic: Schema.Boolean,
    geography: Schema.Array(Schema.String),
    countries: Schema.optional(Schema.Array(Schema.String)),
    sessions: Schema.Boolean,
    exactCity: Schema.Literal("provider_guaranteed", "verifiable", "unsupported"),
    assignmentControl: Schema.Struct({
      providerManagedReassignment: Schema.Literal("disabled", "observable", "uncontrolled"),
      providerManagedRotation: Schema.Literal("disabled", "uncontrolled"),
    }),
    rotation: Schema.Array(Schema.String),
    targetPorts: Schema.Union(Schema.Literal("any_public"), Schema.Array(Schema.Number)),
    dnsResolution: Schema.Struct({
      http: Schema.Literal("provider_configurable", "provider_remote", "unverified"),
      socks5: Schema.Literal("provider_configurable", "provider_remote", "unverified"),
    }),
  }),
  pricing: Schema.Struct({
    source: Schema.Literal("provider_api", "versioned_config"),
    version: Schema.String,
    model: Schema.Literal("per_gib", "per_device_month"),
    amountUsd: Schema.Number,
  }),
  usageDimensions: Schema.Struct({ common: Schema.Array(Schema.String), providerSpecific: Schema.Array(Schema.String) }),
  costRank: Schema.Number,
});
const ProviderDescriptorsResponse = Schema.Struct({ data: Schema.Array(ProviderDescriptor) });
const routeId = HttpApiSchema.param("id", Schema.String);
const accessGrantId = HttpApiSchema.param("grantId", Schema.String);

const health = HttpApiGroup.make("health", { topLevel: true })
  .add(HttpApiEndpoint.get("live", "/health/live").addSuccess(LiveResponse).annotate(OpenApi.Description, "Process liveness"))
  .add(
    HttpApiEndpoint.get("ready", "/health/ready")
      .addSuccess(ReadyResponse)
      .addError(ServiceUnavailable)
      .annotate(OpenApi.Description, "Provider and service readiness"),
  );

const routes = HttpApiGroup.make("routes", { topLevel: true })
  .add(
    HttpApiEndpoint.post("createRoute", "/v1/routes")
      .setPayload(RouteProfilePayload)
      .addSuccess(CreatedRoute, { status: 201 })
      .addError(BadRequest)
      .addError(ServiceUnavailable)
      .addError(InternalError),
  )
  .add(HttpApiEndpoint.get("listRoutes", "/v1/routes").addSuccess(RoutesResponse).addError(InternalError))
  .add(HttpApiEndpoint.get("getRoute")`/v1/routes/${routeId}`.addSuccess(RouteResponse).addError(RouteNotFound).addError(InternalError))
  .add(HttpApiEndpoint.del("deleteRoute")`/v1/routes/${routeId}`.addError(RouteNotFound).addError(InternalError))
  .add(
    HttpApiEndpoint.post("rotateRoute")`/v1/routes/${routeId}/rotate`
      .addSuccess(RouteResponse, { status: 202 })
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("createAccessGrant")`/v1/routes/${routeId}/access-grants`
      .addSuccess(IssuedAccessGrant, { status: 201 })
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(OpenApi.Description, "Issue a proxy credential whose secret is returned only in this response"),
  )
  .add(
    HttpApiEndpoint.get("listAccessGrants")`/v1/routes/${routeId}/access-grants`
      .addSuccess(AccessGrantsResponse)
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(OpenApi.Description, "List the authenticated principal's redacted grants for this route profile"),
  )
  .add(
    HttpApiEndpoint.post("rotateAccessGrantCredential")`/v1/access-grants/${accessGrantId}/credentials/rotate`
      .addSuccess(IssuedAccessGrant)
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(
        OpenApi.Description,
        "Rotate this grant's bearer credential without changing its device lease; return the replacement secret only in this response",
      ),
  )
  .add(
    HttpApiEndpoint.post("emergencyRotateAccessGrantCredential")`/v1/access-grants/${accessGrantId}/credentials/emergency-rotate`
      .addSuccess(IssuedAccessGrant)
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(
        OpenApi.Description,
        "Replace a suspected-compromised credential immediately without overlap; return the replacement secret only in this response",
      ),
  )
  .add(HttpApiEndpoint.del("revokeAccessGrant")`/v1/access-grants/${accessGrantId}`.addError(RouteNotFound).addError(InternalError))
  .add(
    HttpApiEndpoint.post("releaseAccessGrantLease")`/v1/access-grants/${accessGrantId}/release`
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(OpenApi.Description, "Explicitly release this grant's device-backed session lease"),
  )
  .add(
    HttpApiEndpoint.post("emergencyRevokeAccessGrant")`/v1/access-grants/${accessGrantId}/emergency-revoke`
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(OpenApi.Description, "Revoke this grant and terminate only its established connections"),
  )
  .add(
    HttpApiEndpoint.post("emergencyRevokeRoute")`/v1/routes/${routeId}/emergency-revoke`
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(OpenApi.Description, "Revoke the route and terminate its established connections"),
  )
  .middleware(AdminAuthorization);

const providers = HttpApiGroup.make("providers", { topLevel: true })
  .add(HttpApiEndpoint.get("providerDescriptors", "/v1/providers").addSuccess(ProviderDescriptorsResponse).addError(InternalError))
  .add(HttpApiEndpoint.get("providerHealth", "/v1/providers/health").addSuccess(ProvidersHealthResponse).addError(InternalError))
  .middleware(AdminAuthorization);

export const ControlApi = HttpApi.make("ProfoundControlApi")
  .add(health)
  .add(routes)
  .add(providers)
  .annotate(OpenApi.Title, "Profound Proxy Router Control API")
  .annotate(OpenApi.Version, CONTROL_API_VERSION)
  .annotate(OpenApi.Description, "Create reusable route profiles and independently revocable per-principal proxy access grants.");
