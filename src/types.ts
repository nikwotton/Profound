export type ProxyKind = "residential" | "mobile";

export interface Targeting {
  country: string;
  region?: string;
  city?: string;
  postalCode?: string;
  asn?: number;
  carrier?: string;
}

export type RotationPolicy =
  | { mode: "per_request" }
  | { mode: "interval"; intervalSeconds: number }
  | { mode: "manual" };

export interface RouteProfileInput {
  name: string;
  kind: ProxyKind;
  targeting: Targeting;
  rotation?: RotationPolicy;
}

export interface RouteProfile {
  name: string;
  kind: ProxyKind;
  targeting: Targeting;
  rotation: RotationPolicy;
}

export type RouteStatus = "ready" | "rotating" | "failed" | "revoked";

export interface StoredRoute extends RouteProfile {
  id: string;
  provider: "bright_data" | "proxidize";
  endpointId?: string;
  tokenSalt: string;
  tokenHash: string;
  status: RouteStatus;
  lastError?: string;
  rotationEpoch: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicRoute extends RouteProfile {
  id: string;
  provider: StoredRoute["provider"];
  endpointId?: string;
  status: RouteStatus;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MobileEndpoint {
  id: string;
  username: string;
  password: string;
  host: string;
  port: number;
  country: string;
  region: string;
  city?: string;
  carrier: string;
  publicKey: string;
  healthy: boolean;
}

export interface UpstreamEndpoint {
  provider: StoredRoute["provider"];
  endpointId: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

export type HealthState = "healthy" | "degraded" | "unhealthy";

export interface ProviderHealth {
  provider: StoredRoute["provider"];
  state: HealthState;
  checkedAt: string;
  message?: string;
}

export interface ListenAddress {
  host: string;
  port: number;
}
