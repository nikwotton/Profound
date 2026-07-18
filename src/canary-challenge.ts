import { createHmac, timingSafeEqual } from "node:crypto";
import { isUnknownRecord } from "./decoding.js";

export interface CanaryChallenge {
  testId: string;
  nonce: string;
  expiresAt: string;
  signature: string;
}

function payload(challenge: Omit<CanaryChallenge, "signature">): string {
  return `${challenge.testId}\n${challenge.nonce}\n${challenge.expiresAt}`;
}

export function signCanaryChallenge(secret: string, challenge: Omit<CanaryChallenge, "signature">): CanaryChallenge {
  return {
    ...challenge,
    signature: createHmac("sha256", secret).update(payload(challenge)).digest("base64url"),
  };
}

export function verifyCanaryChallenge(
  secret: string,
  challenge: CanaryChallenge,
  now = Date.now(),
  maximumLifetimeMs = 5 * 60_000,
): boolean {
  const expiresAt = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < now || expiresAt > now + maximumLifetimeMs) return false;
  const expected = signCanaryChallenge(secret, {
    testId: challenge.testId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
  }).signature;
  const actualBuffer = Buffer.from(challenge.signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isCanaryChallenge(value: unknown): value is CanaryChallenge {
  if (!isUnknownRecord(value)) return false;
  const fields = ["testId", "nonce", "expiresAt", "signature"];
  if (Object.keys(value).some((key) => !fields.includes(key))) return false;
  return fields.every((key) => {
    const field = value[key];
    return typeof field === "string" && field.length > 0;
  });
}
