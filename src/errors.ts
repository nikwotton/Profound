import type { AssignmentEvidence, ProviderId } from "./domain/routing.js";

export type AppErrorKind =
  | "application"
  | "validation"
  | "authentication"
  | "not_found"
  | "provider_authentication"
  | "provider_rate_limit"
  | "provider_unavailable"
  | "provider_protocol"
  | "provider_capacity_limit"
  | "provider_override_unsatisfied"
  | "upstream"
  | "internal";

export type AppErrorCode =
  | "caller_cancelled"
  | "internal_error"
  | "invalid_socks5"
  | "invalid_target"
  | "not_found"
  | "payload_too_large"
  | "protocol_not_allowed"
  | "provider_authentication_failed"
  | "provider_capacity_limit"
  | "provider_override_unsatisfied"
  | "provider_protocol_error"
  | "provider_rate_limited"
  | "provider_target_forbidden"
  | "provider_unavailable"
  | "proxy_authentication_required"
  | "proxy_error"
  | "request_too_large"
  | "response_too_large"
  | "rotation_not_supported"
  | "route_emergency_revoked"
  | "target_forbidden"
  | "target_port_forbidden"
  | "unsupported_socks5_address"
  | "unsupported_socks5_command"
  | "upstream_authentication_failed"
  | "upstream_error"
  | "validation_error";

export interface AppErrorOptions extends ErrorOptions {
  retryAfterMs?: number;
}

export class AppError extends Error {
  readonly kind: AppErrorKind = "application";

  constructor(
    message: string,
    readonly code: AppErrorCode,
    readonly statusCode: number,
    readonly retryable = statusCode >= 500,
    options: AppErrorOptions = {},
  ) {
    super(message, options);
    this.name = new.target.name;
    this.retryAfterMs = options.retryAfterMs;
  }

  readonly retryAfterMs: number | undefined;
}

export class ValidationError extends AppError {
  override readonly kind = "validation" as const;

  constructor(message: string) {
    super(message, "validation_error", 400);
  }
}

export class AuthenticationError extends AppError {
  override readonly kind = "authentication" as const;

  constructor(message = "Proxy authentication required") {
    super(message, "proxy_authentication_required", 407);
  }
}

export class NotFoundError extends AppError {
  override readonly kind = "not_found" as const;

  constructor(message = "Route not found") {
    super(message, "not_found", 404);
  }
}

export class ProviderUnavailableError extends AppError {
  override readonly kind = "provider_unavailable" as const;

  constructor(
    message = "Upstream provider is unavailable",
    readonly reason: "timeout" | "unavailable" = "unavailable",
  ) {
    super(message, "provider_unavailable", 503);
  }
}

export class RequestTooLargeError extends AppError {
  override readonly kind = "validation" as const;

  constructor(message = "Request body is too large") {
    super(message, "request_too_large", 413, false);
  }
}

export class ProviderAuthenticationError extends AppError {
  override readonly kind = "provider_authentication" as const;

  constructor(message = "Upstream provider rejected its configured credentials") {
    super(message, "provider_authentication_failed", 502, false);
  }
}

export class ProviderRateLimitError extends AppError {
  override readonly kind = "provider_rate_limit" as const;

  constructor(message = "Upstream provider rate limit exceeded", retryAfterMs?: number) {
    super(message, "provider_rate_limited", 503, true, retryAfterMs === undefined ? {} : { retryAfterMs });
  }
}

export class ProviderProtocolError extends AppError {
  override readonly kind = "provider_protocol" as const;

  constructor(message = "Upstream provider returned an invalid response") {
    super(message, "provider_protocol_error", 502, false);
  }
}

export class ProviderCapacityLimitError extends AppError {
  override readonly kind = "provider_capacity_limit" as const;

  constructor(message = "Upstream provider reported a hard capacity limit") {
    super(message, "provider_capacity_limit", 503);
  }
}

export class ProviderOverrideUnsatisfiedError extends AppError {
  override readonly kind = "provider_override_unsatisfied" as const;

  constructor(message = "The requested provider override cannot satisfy this profile") {
    super(message, "provider_override_unsatisfied", 503);
  }
}

export class UpstreamError extends AppError {
  override readonly kind = "upstream" as const;

  constructor(message = "Upstream proxy request failed", statusCode = 502) {
    super(message, "upstream_error", statusCode);
  }
}

export class InternalServiceError extends AppError {
  override readonly kind = "internal" as const;

  constructor(cause?: unknown) {
    super("Unexpected internal error", "internal_error", 500, true, cause === undefined ? {} : { cause });
  }
}

export type RouteServiceError =
  | ValidationError
  | AuthenticationError
  | NotFoundError
  | ProviderAuthenticationError
  | ProviderRateLimitError
  | ProviderUnavailableError
  | ProviderProtocolError
  | ProviderCapacityLimitError
  | ProviderOverrideUnsatisfiedError
  | UpstreamError
  | InternalServiceError;

export function toRouteServiceError(error: unknown): RouteServiceError {
  if (
    error instanceof ValidationError ||
    error instanceof AuthenticationError ||
    error instanceof NotFoundError ||
    error instanceof ProviderAuthenticationError ||
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderUnavailableError ||
    error instanceof ProviderProtocolError ||
    error instanceof ProviderCapacityLimitError ||
    error instanceof ProviderOverrideUnsatisfiedError ||
    error instanceof UpstreamError ||
    error instanceof InternalServiceError
  ) {
    return error;
  }
  return new InternalServiceError(error);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof AppError ? error.message : "Unexpected internal error";
}

const errorProviders = new WeakMap<object, ProviderId>();
const errorAssignments = new WeakMap<object, AssignmentEvidence>();

function objectError(error: unknown): object | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function") ? error : undefined;
}

export function attributeProvider(error: unknown, provider: ProviderId): unknown {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    errorProviders.set(error, provider);
    return error;
  }
  const attributed = new ProviderUnavailableError();
  errorProviders.set(attributed, provider);
  return attributed;
}

export function providerIdFromError(error: unknown): ProviderId | undefined {
  const object = objectError(error);
  return object === undefined ? undefined : errorProviders.get(object);
}

export function attributeAssignment(error: unknown, assignment: AssignmentEvidence): unknown {
  const object = objectError(error);
  if (object !== undefined) {
    errorAssignments.set(object, assignment);
    return error;
  }
  const attributed = new ProviderUnavailableError();
  errorAssignments.set(attributed, assignment);
  return attributed;
}

export function assignmentFromError(error: unknown): AssignmentEvidence | undefined {
  const object = objectError(error);
  return object === undefined ? undefined : errorAssignments.get(object);
}

export function isRetryableUpstreamFailure(error: unknown): boolean {
  if (
    error instanceof ProviderAuthenticationError ||
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderUnavailableError ||
    error instanceof ProviderProtocolError ||
    error instanceof ProviderCapacityLimitError
  ) {
    return error.retryable;
  }
  if (!(error instanceof Error)) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return (
    code !== undefined &&
    new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH"]).has(code)
  );
}
