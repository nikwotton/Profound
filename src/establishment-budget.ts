import { AppError, ProviderUnavailableError } from "./errors.js";

export interface AttemptBudget {
  readonly signal: AbortSignal;
  readonly deadline: number;
  remainingMs(): number;
  finish(): void;
}

export function operationDeadline(startedAt: number, operationTimeoutMs: number): number {
  return startedAt + operationTimeoutMs;
}

export function beginAttemptBudget(overallDeadline: number, attemptTimeoutMs: number, callerSignal?: AbortSignal): AttemptBudget {
  const now = Date.now();
  const remainingOverall = overallDeadline - now;
  if (remainingOverall <= 0) throw new ProviderUnavailableError("Candidate establishment exceeded the operation deadline", "timeout");
  const timeoutMs = Math.min(attemptTimeoutMs, remainingOverall);
  const deadline = now + timeoutMs;
  const controller = new AbortController();
  const abortFromCaller = (): void => {
    controller.abort(new AppError("Caller disconnected during candidate establishment", "caller_cancelled", 499));
  };
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (callerSignal?.aborted === true) abortFromCaller();
  const timer = setTimeout(() => {
    controller.abort(new ProviderUnavailableError("Candidate establishment timed out", "timeout"));
  }, timeoutMs);
  let finished = false;
  return {
    signal: controller.signal,
    deadline,
    remainingMs: () => Math.max(1, deadline - Date.now()),
    finish: () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new ProviderUnavailableError("Candidate establishment was cancelled");
}
