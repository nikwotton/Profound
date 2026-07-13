import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "@effect/platform";
import { Schema } from "effect";

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

export class AdminAuthorization extends HttpApiMiddleware.Tag<AdminAuthorization>()(
  "Profound/AdminAuthorization",
  {
    failure: Unauthorized,
    security: {
      bearer: HttpApiSecurity.bearer.pipe(
        HttpApiSecurity.annotate(OpenApi.Description, "Administrator token supplied through CONTROL_API_TOKEN"),
      ),
    },
  },
) {}

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
  kind: Schema.Literal("residential", "mobile"),
  targeting: Targeting,
  rotation: Schema.optional(Rotation),
}).annotations({ identifier: "RouteProfileInput" });

const PublicRoute = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literal("residential", "mobile"),
  targeting: Targeting,
  rotation: Rotation,
  provider: Schema.Literal("bright_data", "proxidize"),
  endpointId: Schema.optional(Schema.String),
  status: Schema.Literal("ready", "rotating", "failed", "revoked"),
  lastError: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotations({ identifier: "Route" });

const CreatedRoute = Schema.Struct({
  route: PublicRoute,
  proxyUrl: Schema.String,
}).annotations({ identifier: "CreatedRoute" });

const RouteResponse = Schema.Struct({ route: PublicRoute });
const RoutesResponse = Schema.Struct({ data: Schema.Array(PublicRoute) });
const LiveResponse = Schema.Struct({ status: Schema.Literal("live") });
const ReadyResponse = Schema.Struct({ status: Schema.Literal("ready") });
const ProviderHealth = Schema.Struct({
  provider: Schema.Literal("bright_data", "proxidize"),
  state: Schema.Literal("healthy", "degraded", "unhealthy"),
  checkedAt: Schema.String,
  message: Schema.optional(Schema.String),
});
const ProvidersHealthResponse = Schema.Struct({ data: Schema.Array(ProviderHealth) });
const routeId = HttpApiSchema.param("id", Schema.String);

const health = HttpApiGroup.make("health", { topLevel: true })
  .add(
    HttpApiEndpoint.get("live", "/health/live")
      .addSuccess(LiveResponse)
      .annotate(OpenApi.Description, "Process liveness"),
  )
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
  .add(
    HttpApiEndpoint.get("listRoutes", "/v1/routes")
      .addSuccess(RoutesResponse),
  )
  .add(
    HttpApiEndpoint.get("getRoute")`/v1/routes/${routeId}`
      .addSuccess(RouteResponse)
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.del("deleteRoute")`/v1/routes/${routeId}`
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .add(
    HttpApiEndpoint.post("rotateRoute")`/v1/routes/${routeId}/rotate`
      .addSuccess(RouteResponse, { status: 202 })
      .addError(RouteNotFound)
      .addError(InternalError),
  )
  .middleware(AdminAuthorization);

const providers = HttpApiGroup.make("providers", { topLevel: true })
  .add(
    HttpApiEndpoint.get("providerHealth", "/v1/providers/health")
      .addSuccess(ProvidersHealthResponse)
      .addError(InternalError),
  )
  .middleware(AdminAuthorization);

export const ControlApi = HttpApi.make("ProfoundControlApi")
  .add(health)
  .add(routes)
  .add(providers)
  .annotate(OpenApi.Title, "Profound Proxy Router Control API")
  .annotate(OpenApi.Version, "0.1.0")
  .annotate(OpenApi.Description, "Create and manage residential and device-backed mobile proxy routes.");
