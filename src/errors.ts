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

export class UpstreamError extends AppError {
  constructor(message = "Upstream proxy request failed", statusCode = 502) {
    super(message, "upstream_error", statusCode);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
