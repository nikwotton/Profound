import { Schema } from "effect";

const exactOptional = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });

export const GeographyPayload = Schema.Struct({
  countryCode: exactOptional(Schema.String),
  regionCode: exactOptional(Schema.String),
  city: exactOptional(Schema.String),
}).annotations({ identifier: "Geography", parseOptions: { onExcessProperty: "error" } });

export const RouteProfilePayload = Schema.Struct({
  customerId: Schema.String,
  geography: exactOptional(GeographyPayload),
  carrier: exactOptional(Schema.String),
  providerOverride: exactOptional(Schema.NullOr(Schema.Literal("bright_data", "proxidize"))),
  isTargetAuthenticated: Schema.Boolean,
  allowConnectionRetry: Schema.Boolean,
}).annotations({ identifier: "RouteProfileInput", parseOptions: { onExcessProperty: "error" } });

export type DecodedRouteProfilePayload = typeof RouteProfilePayload.Type;
