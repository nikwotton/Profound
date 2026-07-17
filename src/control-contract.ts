import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "@effect/platform";
import { Context, Schema } from "effect";

export const CONTROL_API_VERSION = "0.6.0";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { code: Schema.String, message: Schema.String, retryable: Schema.Boolean, requestId: Schema.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { code: Schema.String, message: Schema.String, retryable: Schema.Boolean, requestId: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class RouteNotFound extends Schema.TaggedError<RouteNotFound>()(
  "RouteNotFound",
  { code: Schema.String, message: Schema.String, retryable: Schema.Boolean, requestId: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  "ServiceUnavailable",
  { code: Schema.String, message: Schema.String, retryable: Schema.Boolean, requestId: Schema.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  { code: Schema.String, message: Schema.String, retryable: Schema.Boolean, requestId: Schema.String },
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

const Geography = Schema.Struct({
  countryCode: Schema.optional(Schema.String),
  regionCode: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
}).annotations({ identifier: "Geography", parseOptions: { onExcessProperty: "error" } });

export const RouteProfilePayload = Schema.Unknown.annotations({
  identifier: "RouteProfileInput",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      customerId: { type: "string" },
      geography: {
        type: "object",
        additionalProperties: false,
        properties: {
          countryCode: { type: "string" },
          regionCode: { type: "string" },
          city: { type: "string" },
        },
      },
      carrier: { type: "string" },
      providerOverride: { type: ["string", "null"], enum: ["bright_data", "proxidize", null] },
      isTargetAuthenticated: { type: "boolean" },
      allowConnectionRetry: { type: "boolean" },
    },
    required: ["customerId", "isTargetAuthenticated", "allowConnectionRetry"],
  },
});

const PublicRoute = Schema.Struct({
  profileId: Schema.String,
  customerId: Schema.String,
  geography: Schema.optional(Geography),
  carrier: Schema.optional(Schema.String),
  providerOverride: Schema.NullOr(Schema.Literal("bright_data", "proxidize")),
  isTargetAuthenticated: Schema.Boolean,
  allowConnectionRetry: Schema.Boolean,
  status: Schema.Literal("ready", "rotating", "failed", "revoked"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "RouteProfile" });

const PublicAccessGrantCredential = Schema.Struct({
  credentialId: Schema.String,
  username: Schema.String,
  status: Schema.Literal("active", "overlap", "revoked", "expired"),
  createdAt: Schema.String,
  renewalDueAt: Schema.String,
  renewalDue: Schema.Boolean,
  expiresAt: Schema.String,
  revokeAt: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.String),
}).annotations({ identifier: "AccessGrantCredential" });

const PublicAccessGrant = Schema.Struct({
  grantId: Schema.String,
  profileId: Schema.String,
  status: Schema.Literal("ready", "revoked"),
  credentials: Schema.Array(PublicAccessGrantCredential),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "AccessGrant" });

const IssuedAccessGrant = Schema.Struct({
  grant: PublicAccessGrant,
  credential: Schema.extend(PublicAccessGrantCredential, Schema.Struct({ password: Schema.String })),
  endpoints: Schema.Struct({ http: Schema.String, socks5: Schema.String }),
}).annotations({ identifier: "IssuedAccessGrant" });

const CreatedProfile = Schema.Struct({
  profileId: Schema.String,
}).annotations({ identifier: "CreatedProfile" });

const ProfileResponse = Schema.Struct({ profile: PublicRoute });
const ProfilesResponse = Schema.Struct({ data: Schema.Array(PublicRoute) });
const AccessGrantsResponse = Schema.Struct({ data: Schema.Array(PublicAccessGrant) });
const LiveResponse = Schema.Struct({ status: Schema.Literal("live") });
const ReadyResponse = Schema.Struct({ status: Schema.Literal("ready") });
const profileId = HttpApiSchema.param("id", Schema.String);
const accessGrantId = HttpApiSchema.param("grantId", Schema.String);
const credentialId = HttpApiSchema.param("credentialId", Schema.String);

const health = HttpApiGroup.make("health", { topLevel: true })
  .add(HttpApiEndpoint.get("live", "/health/live").addSuccess(LiveResponse).annotate(OpenApi.Description, "Process liveness"))
  .add(
    HttpApiEndpoint.get("ready", "/health/ready")
      .addSuccess(ReadyResponse)
      .addError(ServiceUnavailable)
      .annotate(OpenApi.Description, "Provider and service readiness"),
  );

const profiles = HttpApiGroup.make("profiles", { topLevel: true })
  .add(
    HttpApiEndpoint.post("createProfile", "/v1/profiles")
      .setPayload(RouteProfilePayload)
      .addSuccess(CreatedProfile, { status: 201 })
      .addError(BadRequest)
      .addError(ServiceUnavailable)
      .addError(InternalError),
  )
  .add(HttpApiEndpoint.get("listProfiles", "/v1/profiles").addSuccess(ProfilesResponse).addError(InternalError))
  .add(
    HttpApiEndpoint.get("getProfile")`/v1/profiles/${profileId}`
      .addSuccess(ProfileResponse)
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.put("updateProfile")`/v1/profiles/${profileId}`
      .setPayload(RouteProfilePayload)
      .addSuccess(ProfileResponse)
      .addError(BadRequest)
      .addError(RouteNotFound)
      .addError(ServiceUnavailable)
      .addError(InternalError)
      .annotate(OpenApi.Description, "Replace provider-neutral routing requirements; changes apply to new connections"),
  )
  .add(HttpApiEndpoint.del("deleteProfile")`/v1/profiles/${profileId}`.addError(RouteNotFound).addError(InternalError))
  .add(
    HttpApiEndpoint.post("createAccessGrant")`/v1/profiles/${profileId}/grants`
      .addSuccess(IssuedAccessGrant, { status: 201 })
      .addError(RouteNotFound)
      .addError(ServiceUnavailable)
      .addError(InternalError)
      .annotate(OpenApi.Description, "Issue a proxy credential whose secret is returned only in this response"),
  )
  .add(
    HttpApiEndpoint.get("listAccessGrants")`/v1/profiles/${profileId}/grants`
      .addSuccess(AccessGrantsResponse)
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(OpenApi.Description, "List the authenticated principal's redacted grants for this route profile"),
  )
  .add(
    HttpApiEndpoint.get("getAccessGrant")`/v1/grants/${accessGrantId}`
      .addSuccess(Schema.Struct({ grant: PublicAccessGrant }))
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("rotateAccessGrantCredential")`/v1/grants/${accessGrantId}/credentials/rotate`
      .addSuccess(IssuedAccessGrant)
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(
        OpenApi.Description,
        "Rotate this grant's bearer credential without creating or changing provider affinity; return the replacement secret only in this response",
      ),
  )
  .add(
    HttpApiEndpoint.post("emergencyRotateAccessGrantCredential")`/v1/grants/${accessGrantId}/credentials/emergency-rotate`
      .addSuccess(IssuedAccessGrant)
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(
        OpenApi.Description,
        "Replace a suspected-compromised credential immediately without overlap; return the replacement secret only in this response",
      ),
  )
  .add(
    HttpApiEndpoint.get("getAccessGrantCredential")`/v1/grants/${accessGrantId}/credentials/${credentialId}`
      .addSuccess(Schema.Struct({ credential: PublicAccessGrantCredential }))
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.del("revokeAccessGrantCredential")`/v1/grants/${accessGrantId}/credentials/${credentialId}`
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(HttpApiEndpoint.del("revokeAccessGrant")`/v1/grants/${accessGrantId}`.addError(RouteNotFound).addError(InternalError))
  .middleware(AdminAuthorization);

export const ControlApi = HttpApi.make("ProfoundControlApi")
  .add(health)
  .add(profiles)
  .annotate(OpenApi.Title, "Profound Proxy Router Control API")
  .annotate(OpenApi.Version, CONTROL_API_VERSION)
  .annotate(
    OpenApi.Description,
    "Manage reusable provider-neutral route profiles, independently revocable access grants, and one-time proxy credentials.",
  );
