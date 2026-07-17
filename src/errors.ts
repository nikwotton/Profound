export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, "validation_error", 400);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Proxy authentication required") {
    super(message, "proxy_authentication_required", 407);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Route not found") {
    super(message, "not_found", 404);
  }
}

export class ProviderUnavailableError extends AppError {
  constructor(message = "Upstream provider is unavailable") {
    super(message, "provider_unavailable", 503);
  }
}

export class ProviderCapacityLimitError extends AppError {
  constructor(message = "Upstream provider reported a hard capacity limit") {
    super(message, "provider_capacity_limit", 503);
  }
}

export class ProviderOverrideUnsatisfiedError extends AppError {
  constructor(message = "The requested provider override cannot satisfy this profile") {
    super(message, "provider_override_unsatisfied", 503);
  }
}

export class UpstreamError extends AppError {
  constructor(message = "Upstream proxy request failed", statusCode = 502) {
    super(message, "upstream_error", statusCode);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof AppError ? error.message : "Unexpected internal error";
}

export function attributeProvider(error: unknown, provider: string): unknown {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    Object.defineProperty(error, "providerId", { value: provider, configurable: true });
    return error;
  }
  const attributed = new ProviderUnavailableError();
  Object.defineProperty(attributed, "providerId", { value: provider, configurable: true });
  return attributed;
}

export function providerIdFromError(error: unknown): ProviderId | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  const provider = (error as { providerId?: unknown }).providerId;
  return provider === "bright_data" || provider === "proxidize" ? provider : undefined;
}

export function attributeAssignment(error: unknown, assignment: AssignmentEvidence): unknown {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    Object.defineProperty(error, "assignmentEvidence", { value: assignment, configurable: true });
    return error;
  }
  const attributed = new ProviderUnavailableError();
  Object.defineProperty(attributed, "assignmentEvidence", { value: assignment, configurable: true });
  return attributed;
}

export function assignmentFromError(error: unknown): AssignmentEvidence | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  const assignment = (error as { assignmentEvidence?: unknown }).assignmentEvidence;
  return assignment !== null && typeof assignment === "object" ? (assignment as AssignmentEvidence) : undefined;
}

export function isRetryableUpstreamFailure(error: unknown): boolean {
  if (error instanceof ProviderUnavailableError || error instanceof ProviderCapacityLimitError) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code !== undefined &&
    new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH"]).has(code)
  );
}
import type { AssignmentEvidence, ProviderId } from "./types.js";
