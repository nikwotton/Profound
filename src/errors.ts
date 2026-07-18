import type { AssignmentEvidence, ProviderId } from "./types.js";

export type AppErrorKind =
  | "application"
  | "validation"
  | "authentication"
  | "not_found"
  | "provider_unavailable"
  | "provider_protocol"
  | "provider_capacity_limit"
  | "provider_override_unsatisfied"
  | "upstream"
  | "internal";

export class AppError extends Error {
  readonly kind: AppErrorKind = "application";

  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly retryable = statusCode >= 500,
  ) {
    super(message);
    this.name = new.target.name;
  }
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

  constructor(message = "Upstream provider is unavailable") {
    super(message, "provider_unavailable", 503);
  }
}

export class ProviderProtocolError extends AppError {
  override readonly kind = "provider_protocol" as const;

  constructor(message = "Upstream provider returned an invalid response") {
    super(message, "provider_protocol_error", 502, true);
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

  constructor() {
    super("Unexpected internal error", "internal_error", 500, true);
  }
}

export type RouteServiceError =
  | ValidationError
  | AuthenticationError
  | NotFoundError
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
    error instanceof ProviderUnavailableError ||
    error instanceof ProviderProtocolError ||
    error instanceof ProviderCapacityLimitError ||
    error instanceof ProviderOverrideUnsatisfiedError ||
    error instanceof UpstreamError ||
    error instanceof InternalServiceError
  ) {
    return error;
  }
  return new InternalServiceError();
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
  if (error instanceof ProviderUnavailableError || error instanceof ProviderProtocolError || error instanceof ProviderCapacityLimitError) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return (
    code !== undefined &&
    new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH"]).has(code)
  );
}
