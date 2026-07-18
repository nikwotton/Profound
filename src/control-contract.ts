import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "@effect/platform";
import { Context, Schema } from "effect";
import { GeographyPayload as Geography, RouteProfilePayload } from "./route-profile-schema.js";

export { RouteProfilePayload } from "./route-profile-schema.js";

export const CONTROL_API_VERSION = "0.7.0";

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

export const PublicRouteSchema = Schema.Struct({
  profileId: Schema.String,
  customerId: Schema.String,
  geography: Schema.optional(Geography),
  carrier: Schema.optional(Schema.String),
  providerOverride: Schema.NullOr(Schema.Literal("bright_data", "proxidize")),
  allowConnectionRetry: Schema.Boolean,
  status: Schema.Literal("ready", "rotating", "failed", "revoked"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "RouteProfile" });

export const PublicAccessGrantCredentialSchema = Schema.Struct({
  credentialId: Schema.String,
  username: Schema.String,
  sessionMode: Schema.Literal("managed", "none"),
  sessionId: Schema.optional(Schema.String),
  status: Schema.Literal("active", "overlap", "revoked", "expired"),
  createdAt: Schema.String,
  renewalDueAt: Schema.String,
  renewalDue: Schema.Boolean,
  expiresAt: Schema.String,
  revokeAt: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.String),
}).annotations({ identifier: "AccessGrantCredential" });

export const PublicAccessGrantSchema = Schema.Struct({
  grantId: Schema.String,
  profileId: Schema.String,
  jobId: Schema.NullOr(Schema.String),
  status: Schema.Literal("ready", "revoked"),
  credentials: Schema.Array(PublicAccessGrantCredentialSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "AccessGrant" });

export const PublicLogicalSessionSchema = Schema.Struct({
  sessionId: Schema.String,
  grantId: Schema.String,
  profileId: Schema.String,
  sessionMode: Schema.Literal("managed"),
  status: Schema.Literal("open", "closed"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.optional(Schema.String),
  closedAt: Schema.optional(Schema.String),
}).annotations({ identifier: "LogicalSession" });

const SessionModePayload = Schema.Struct({ sessionMode: Schema.Literal("managed", "none") }).annotations({
  identifier: "SessionModeInput",
  parseOptions: { onExcessProperty: "error" },
});

const GrantIssuancePayload = Schema.Struct({
  sessionMode: Schema.Literal("managed", "none"),
  jobId: Schema.optional(Schema.String),
}).annotations({ identifier: "GrantIssuanceInput", parseOptions: { onExcessProperty: "error" } });

export const IssuedAccessGrantSchema = Schema.Struct({
  grant: PublicAccessGrantSchema,
  credential: Schema.extend(PublicAccessGrantCredentialSchema, Schema.Struct({ password: Schema.String })),
  session: Schema.optional(PublicLogicalSessionSchema),
  endpoints: Schema.Struct({ http: Schema.String, socks5: Schema.String }),
}).annotations({ identifier: "IssuedAccessGrant" });

export const CreatedProfileSchema = Schema.Struct({
  profileId: Schema.String,
}).annotations({ identifier: "CreatedProfile" });

export const ProfileResponseSchema = Schema.Struct({ profile: PublicRouteSchema });
const ProfilesResponse = Schema.Struct({ data: Schema.Array(PublicRouteSchema) });
const AccessGrantsResponse = Schema.Struct({ data: Schema.Array(PublicAccessGrantSchema) });
const LogicalSessionsResponse = Schema.Struct({ data: Schema.Array(PublicLogicalSessionSchema) });
const LiveResponse = Schema.Struct({ status: Schema.Literal("live") });
const ReadyResponse = Schema.Struct({ status: Schema.Literal("ready") });
const profileId = HttpApiSchema.param("id", Schema.String);
const accessGrantId = HttpApiSchema.param("grantId", Schema.String);
const credentialId = HttpApiSchema.param("credentialId", Schema.String);
const sessionId = HttpApiSchema.param("sessionId", Schema.String);

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
      .addSuccess(CreatedProfileSchema, { status: 201 })
      .addError(BadRequest)
      .addError(ServiceUnavailable)
      .addError(InternalError),
  )
  .add(HttpApiEndpoint.get("listProfiles", "/v1/profiles").addSuccess(ProfilesResponse).addError(InternalError))
  .add(
    HttpApiEndpoint.get("getProfile")`/v1/profiles/${profileId}`
      .addSuccess(ProfileResponseSchema)
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.put("updateProfile")`/v1/profiles/${profileId}`
      .setPayload(RouteProfilePayload)
      .addSuccess(ProfileResponseSchema)
      .addError(BadRequest)
      .addError(RouteNotFound)
      .addError(ServiceUnavailable)
      .addError(InternalError)
      .annotate(OpenApi.Description, "Replace provider-neutral routing requirements; changes apply to new connections"),
  )
  .add(HttpApiEndpoint.del("deleteProfile")`/v1/profiles/${profileId}`.addError(RouteNotFound).addError(InternalError))
  .add(
    HttpApiEndpoint.post("createAccessGrant")`/v1/profiles/${profileId}/grants`
      .setPayload(GrantIssuancePayload)
      .addSuccess(IssuedAccessGrantSchema, { status: 201 })
      .addError(BadRequest)
      .addError(RouteNotFound)
      .addError(ServiceUnavailable)
      .addError(InternalError)
      .annotate(OpenApi.Description, "Create an explicit managed-session or stateless grant and return its secret once"),
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
      .addSuccess(Schema.Struct({ grant: PublicAccessGrantSchema }))
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("createStatelessCredential")`/v1/grants/${accessGrantId}/credentials`
      .setPayload(SessionModePayload)
      .addSuccess(IssuedAccessGrantSchema, { status: 201 })
      .addError(BadRequest)
      .addError(RouteNotFound)
      .addError(ServiceUnavailable)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("rotateAccessGrantCredential")`/v1/grants/${accessGrantId}/credentials/${credentialId}/rotate`
      .addSuccess(IssuedAccessGrantSchema)
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(
        OpenApi.Description,
        "Rotate one credential without changing its stateless or logical-session scope; return the replacement secret only once",
      ),
  )
  .add(
    HttpApiEndpoint.post("emergencyRotateAccessGrantCredential")`/v1/grants/${accessGrantId}/credentials/${credentialId}/emergency-rotate`
      .addSuccess(IssuedAccessGrantSchema)
      .addError(RouteNotFound)
      .addError(InternalError)
      .annotate(
        OpenApi.Description,
        "Replace a suspected-compromised credential immediately without overlap; return the replacement secret only in this response",
      ),
  )
  .add(
    HttpApiEndpoint.post("createLogicalSession")`/v1/grants/${accessGrantId}/sessions`
      .addSuccess(IssuedAccessGrantSchema, { status: 201 })
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get("listLogicalSessions")`/v1/grants/${accessGrantId}/sessions`
      .addSuccess(LogicalSessionsResponse)
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get("getLogicalSession")`/v1/grants/${accessGrantId}/sessions/${sessionId}`
      .addSuccess(Schema.Struct({ session: PublicLogicalSessionSchema }))
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.del("closeLogicalSession")`/v1/grants/${accessGrantId}/sessions/${sessionId}`
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("forceCloseLogicalSession")`/v1/grants/${accessGrantId}/sessions/${sessionId}/force-close`
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.get("getAccessGrantCredential")`/v1/grants/${accessGrantId}/credentials/${credentialId}`
      .addSuccess(Schema.Struct({ credential: PublicAccessGrantCredentialSchema }))
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
    "Manage provider-neutral route profiles, access grants, managed logical sessions, and explicitly stateless credentials.",
  );
