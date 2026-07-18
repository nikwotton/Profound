import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { expectNumber, expectRecord } from "./decoding.js";
import { destinationResponsePlan, waitForDestinationDelay } from "./destination-simulator.js";

const maximumBodyBytes = 1024 * 1024;
const replayCounterTtlSeconds = 60 * 60;

export interface IntegrationTargetEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    http?: { method?: string };
  };
}

export interface IntegrationTargetResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface IntegrationTargetRequestCounter {
  increment(testId: string): Promise<number>;
}

interface TargetObservation {
  method: string;
  path: string;
  requestBody: string;
  authorization?: string;
  cookie?: string;
  testHeader?: string;
  requestCount: number;
}

function response(statusCode: number, body: unknown, headers: Record<string, string> = {}): IntegrationTargetResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function header(event: IntegrationTargetEvent, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [candidate, value] of Object.entries(event.headers ?? {})) {
    if (candidate.toLowerCase() === expected && value !== undefined) return value;
  }
  return undefined;
}

function requestBody(event: IntegrationTargetEvent): Buffer {
  const body = event.body ?? "";
  const decoded = Buffer.from(body, event.isBase64Encoded === true ? "base64" : "utf8");
  if (decoded.length > maximumBodyBytes) throw new Error("request_too_large");
  return decoded;
}

export async function handleIntegrationTargetRequest(
  event: IntegrationTargetEvent,
  counter: IntegrationTargetRequestCounter,
): Promise<IntegrationTargetResult> {
  const path = event.rawPath || "/";
  const method = event.requestContext?.http?.method ?? "UNKNOWN";
  if (method === "GET" && path === "/health/live") return response(200, { status: "live" });

  let body: Buffer;
  try {
    body = requestBody(event);
  } catch {
    return response(413, { error: "request_too_large" });
  }

  const testId = header(event, "x-profound-test-id") ?? event.requestContext?.requestId ?? "unattributed";
  const requestCount = await counter.increment(testId);
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  let plan;
  try {
    plan = destinationResponsePlan(new URL(`${path}${query}`, "https://integration-target.invalid"));
  } catch {
    return response(400, { error: "invalid_simulation" });
  }
  await waitForDestinationDelay(plan.delayMs);
  if (plan.connection !== "respond") {
    return response(501, { error: "connection_behavior_requires_socket_simulator", connection: plan.connection });
  }
  const authorization = header(event, "authorization");
  const cookie = header(event, "cookie") ?? (event.cookies === undefined ? undefined : event.cookies.join("; "));
  const testHeader = header(event, "x-profound-test-header");
  const observation: TargetObservation = {
    method,
    path: `${path}${query}`,
    requestBody: body.toString("utf8"),
    ...(authorization === undefined ? {} : { authorization }),
    ...(cookie === undefined ? {} : { cookie }),
    ...(testHeader === undefined ? {} : { testHeader }),
    requestCount,
  };
  if (path === "/redirect") {
    const destination = new URLSearchParams(event.rawQueryString ?? "").get("to") ?? "/redirected";
    return response(302, plan.body ?? observation, { location: destination, ...plan.headers });
  }
  return response(plan.status, plan.body ?? observation, plan.headers);
}

class DynamoRequestCounter implements IntegrationTargetRequestCounter {
  readonly #client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  constructor(private readonly tableName: string) {}

  async increment(testId: string): Promise<number> {
    const id = createHash("sha256").update(testId).digest("hex");
    const result = await this.#client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id },
        UpdateExpression: "SET #expiresAt = :expiresAt ADD #requestCount :one",
        ExpressionAttributeNames: {
          "#expiresAt": "expiresAt",
          "#requestCount": "requestCount",
        },
        ExpressionAttributeValues: {
          ":expiresAt": Math.floor(Date.now() / 1000) + replayCounterTtlSeconds,
          ":one": 1,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const attributes = expectRecord(result.Attributes, "integration target replay counter attributes");
    return expectNumber(attributes.requestCount, "integration target replay counter requestCount");
  }
}

let counter: IntegrationTargetRequestCounter | undefined;

export async function handler(event: IntegrationTargetEvent): Promise<IntegrationTargetResult> {
  const tableName = process.env.INTEGRATION_TARGET_TABLE_NAME?.trim();
  if (!tableName) throw new Error("INTEGRATION_TARGET_TABLE_NAME is required");
  counter ??= new DynamoRequestCounter(tableName);
  return await handleIntegrationTargetRequest(event, counter);
}
