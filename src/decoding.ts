export type UnknownRecord = Record<string, unknown>;

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function expectRecord(value: unknown, context: string): UnknownRecord {
  if (!isUnknownRecord(value)) throw new TypeError(`${context} must be an object`);
  return value;
}

export function expectArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${context} must be an array`);
  return value;
}

export function expectString(value: unknown, context: string): string {
  if (typeof value !== "string") throw new TypeError(`${context} must be a string`);
  return value;
}

export function expectNonEmptyString(value: unknown, context: string): string {
  const result = expectString(value, context);
  if (result.trim().length === 0) throw new TypeError(`${context} must not be empty`);
  return result;
}

export function expectNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${context} must be a finite number`);
  return value;
}

export function expectNonNegativeNumber(value: unknown, context: string): number {
  const result = expectNumber(value, context);
  if (result < 0) throw new TypeError(`${context} must be non-negative`);
  return result;
}

export function expectInteger(
  value: unknown,
  context: string,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const result = expectNumber(value, context);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${context} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return result;
}

export function expectIsoTimestamp(value: unknown, context: string): string {
  const result = expectString(value, context);
  const timestamp = Date.parse(result);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== result) {
    throw new TypeError(`${context} must be a canonical ISO-8601 timestamp`);
  }
  return result;
}

export function expectBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${context} must be a boolean`);
  return value;
}

export function expectOptionalString(value: unknown, context: string): string | undefined {
  return value === undefined ? undefined : expectString(value, context);
}

export function expectOptionalNonEmptyString(value: unknown, context: string): string | undefined {
  return value === undefined ? undefined : expectNonEmptyString(value, context);
}

export function parseJson(text: string, context: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (cause) {
    throw new TypeError(`${context} is not valid JSON`, { cause });
  }
}

export function expectBufferChunk(value: unknown, context = "stream chunk"): Buffer {
  if (typeof value === "string" || value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`${context} must be a string or byte array`);
}

export function expectEnum<const Values extends readonly string[]>(value: unknown, values: Values, context: string): Values[number] {
  if (typeof value !== "string" || !new Set<string>(values).has(value)) {
    throw new TypeError(`${context} must be one of: ${values.join(", ")}`);
  }
  return value;
}
