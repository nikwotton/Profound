import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "@effect/platform";
import { Context, Schema } from "effect";
import { isUnknownRecord } from "./decoding.js";
import { GeographyPayload as Geography, RouteProfilePayload } from "./route-profile-schema.js";

export { RouteProfilePayload } from "./route-profile-schema.js";

export const CONTROL_API_VERSION = "0.8.0";
const exactOptional = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });

export const ApiError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  requestId: Schema.String,
}).annotations({ identifier: "ApiError" });

export type ApiError = typeof ApiError.Type;

const Unauthorized = ApiError.annotations(HttpApiSchema.annotations({ status: 401 }));
const BadRequest = ApiError.annotations(HttpApiSchema.annotations({ status: 400 }));
const RouteNotFound = ApiError.annotations(HttpApiSchema.annotations({ status: 404 }));
const ServiceUnavailable = ApiError.annotations(HttpApiSchema.annotations({ status: 503 }));
const InternalError = ApiError.annotations(HttpApiSchema.annotations({ status: 500 }));

const API_ERROR_OPENAPI_SCHEMA = {
  type: "object",
  required: ["code", "message", "retryable", "requestId"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    retryable: { type: "boolean" },
    requestId: { type: "string" },
  },
  additionalProperties: false,
} as const;

export class AuthenticatedUser extends Context.Tag("Profound/AuthenticatedUser")<AuthenticatedUser, { readonly userId: string }>() {}

export class AdminAuthorization extends HttpApiMiddleware.Tag<AdminAuthorization>()("Profound/AdminAuthorization", {
  failure: Unauthorized,
  provides: AuthenticatedUser,
  security: {
    bearer: HttpApiSecurity.bearer.pipe(
      HttpApiSecurity.annotate(OpenApi.Description, "Control-plane bearer token issued by the platform operator"),
    ),
  },
}) {}

export const PublicRouteSchema = Schema.Struct({
  profileId: Schema.String,
  customerId: Schema.String,
  geography: exactOptional(Geography),
  carrier: exactOptional(Schema.String),
  providerOverride: exactOptional(Schema.Literal("bright_data", "proxidize")),
  allowConnectionRetry: Schema.Boolean,
  status: Schema.Literal("ready", "rotating", "failed", "revoked"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "RouteProfile" });

export const PublicAccessGrantCredentialSchema = Schema.Struct({
  credentialId: Schema.String,
  username: Schema.String,
  sessionMode: Schema.Literal("managed", "stateless"),
  sessionId: exactOptional(Schema.String),
  status: Schema.Literal("active", "overlap", "revoked", "expired"),
  createdAt: Schema.String,
  renewalDueAt: Schema.String,
  renewalDue: Schema.Boolean,
  expiresAt: Schema.String,
  revokeAt: exactOptional(Schema.String),
  lastUsedAt: exactOptional(Schema.String),
}).annotations({ identifier: "AccessGrantCredential" });

export const PublicAccessGrantSchema = Schema.Struct({
  grantId: Schema.String,
  profileId: Schema.String,
  jobId: exactOptional(Schema.String),
  status: Schema.Literal("ready", "revoked"),
  credentials: Schema.mutable(Schema.Array(PublicAccessGrantCredentialSchema)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "AccessGrant" });

export const PublicLogicalSessionSchema = Schema.Struct({
  sessionId: Schema.String,
  grantId: Schema.String,
  profileId: Schema.String,
  status: Schema.Literal("open", "closed"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: exactOptional(Schema.String),
  closedAt: exactOptional(Schema.String),
}).annotations({ identifier: "LogicalSession" });

const GrantIssuancePayload = Schema.Struct({
  sessionMode: Schema.Literal("managed", "stateless"),
  jobId: exactOptional(Schema.String),
}).annotations({ identifier: "GrantIssuanceInput", parseOptions: { onExcessProperty: "error" } });

const IssuedGrantSchema = Schema.Struct({
  grantId: Schema.String,
  profileId: Schema.String,
  jobId: exactOptional(Schema.String),
  status: Schema.Literal("ready", "revoked"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "IssuedGrant" });

export const IssuedAccessGrantSchema = Schema.Struct({
  grant: IssuedGrantSchema,
  credential: Schema.extend(PublicAccessGrantCredentialSchema, Schema.Struct({ password: Schema.String })),
  session: exactOptional(PublicLogicalSessionSchema),
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
      .addSuccess(IssuedAccessGrantSchema, { status: 201 })
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
  )
  .annotate(OpenApi.Transform, normalizeControlOpenApi);

function normalizeOpenApiNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOpenApiNode);
  if (!isUnknownRecord(value)) return value;
  const normalized = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeOpenApiNode(entry)]));
  if (normalized["$ref"] === "#/components/schemas/HttpApiDecodeError") {
    return { ...normalized, $ref: "#/components/schemas/ApiError" };
  }
  if (isApiErrorOpenApiSchema(normalized)) return { $ref: "#/components/schemas/ApiError" };
  const alternatives = normalized["anyOf"];
  if (Array.isArray(alternatives)) {
    const unique = [...new Map(alternatives.map((alternative) => [JSON.stringify(alternative), alternative])).values()];
    if (unique.length === 1 && Object.keys(normalized).length === 1) return unique[0];
    normalized["anyOf"] = unique;
  }
  return normalized;
}

function isApiErrorOpenApiSchema(value: Record<string, unknown>): boolean {
  if (value["type"] !== "object" || value["additionalProperties"] !== false) return false;
  const required = value["required"];
  const properties = value["properties"];
  if (!isStringArray(required) || !isUnknownRecord(properties)) return false;
  const expected = ["code", "message", "requestId", "retryable"];
  if (required.toSorted().join(",") !== expected.join(",")) return false;
  if (Object.keys(properties).sort().join(",") !== expected.join(",")) return false;
  return expected.every((name) => {
    const property = properties[name];
    return isUnknownRecord(property) && property["type"] === (name === "retryable" ? "boolean" : "string");
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

function collectSchemaReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectSchemaReferences(entry, references);
    return;
  }
  if (!isUnknownRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string" && entry.startsWith("#/components/schemas/")) {
      references.add(entry.slice("#/components/schemas/".length));
    } else {
      collectSchemaReferences(entry, references);
    }
  }
}

function normalizeControlOpenApi(specification: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeOpenApiNode(specification);
  if (!isUnknownRecord(normalized)) return specification;
  const components = normalized["components"];
  if (!isUnknownRecord(components)) return normalized;
  const schemas = components["schemas"];
  if (!isUnknownRecord(schemas)) return normalized;

  const schemaRecords: Record<string, unknown> = { ...schemas, ApiError: API_ERROR_OPENAPI_SCHEMA };
  const references = new Set<string>();
  collectSchemaReferences({ ...normalized, components: { ...components, schemas: {} } }, references);
  const queue = [...references];
  const processed = new Set<string>();
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || processed.has(name)) continue;
    processed.add(name);
    const dependencies = new Set<string>();
    collectSchemaReferences(schemaRecords[name], dependencies);
    for (const dependency of dependencies) {
      references.add(dependency);
      if (!processed.has(dependency)) queue.push(dependency);
    }
  }
  const retained = Object.fromEntries(Object.entries(schemaRecords).filter(([name]) => references.has(name)));
  return { ...normalized, components: { ...components, schemas: retained } };
}
