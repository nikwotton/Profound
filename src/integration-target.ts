import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expectBufferChunk } from "./decoding.js";
import { destinationResponsePlan, waitForDestinationDelay } from "./destination-simulator.js";
import type { Logger } from "./logger.js";
import type { ListenAddress } from "./domain/network.js";

export interface IntegrationTargetOptions {
  host: string;
  port: number;
  maximumBodyBytes?: number;
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

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length,
    "cache-control": "no-store",
    connection: "close",
    ...headers,
  });
  response.end(encoded);
}

async function readBody(request: IncomingMessage, maximumBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = expectBufferChunk(chunk, "integration-target request chunk");
    size += buffer.length;
    if (size > maximumBodyBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Plain-HTTP socket origin for ephemeral CI transport checks. It is excluded
 * from developer and production deployments and runs in the public-canary VPC,
 * which has no route to product services. Never use it for application traffic.
 */
export class IntegrationTargetServer {
  #server: Server | undefined;
  readonly #requestCounts = new Map<string, number>();

  constructor(
    private readonly options: IntegrationTargetOptions,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<ListenAddress> {
    if (this.#server !== undefined) throw new Error("Integration target is already running");
    this.#server = createServer((request, response) => void this.#handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.options.port, this.options.host, () => resolve());
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("Integration target did not bind a TCP address");
    return { host: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://integration-target.invalid");
    if (request.method === "GET" && url.pathname === "/health/live") {
      json(response, 200, { status: "live" });
      return;
    }
    try {
      const body = await readBody(request, this.options.maximumBodyBytes ?? 1024 * 1024);
      const testId = typeof request.headers["x-profound-test-id"] === "string" ? request.headers["x-profound-test-id"] : "unattributed";
      const requestCount = (this.#requestCounts.get(testId) ?? 0) + 1;
      this.#requestCounts.set(testId, requestCount);
      const observation: TargetObservation = {
        method: request.method ?? "UNKNOWN",
        path: `${url.pathname}${url.search}`,
        requestBody: body.toString("utf8"),
        ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
        ...(typeof request.headers.cookie === "string" ? { cookie: request.headers.cookie } : {}),
        ...(typeof request.headers["x-profound-test-header"] === "string" ? { testHeader: request.headers["x-profound-test-header"] } : {}),
        requestCount,
      };
      const plan = destinationResponsePlan(url);
      await waitForDestinationDelay(plan.delayMs);
      if (plan.connection === "reset") {
        request.socket.destroy(new Error("simulated_destination_reset"));
        return;
      }
      if (plan.connection === "close") {
        request.socket.end();
        return;
      }
      if (plan.connection === "timeout") {
        setTimeout(() => request.socket.destroy(new Error("simulated_destination_timeout")), 5_000).unref();
        return;
      }
      if (url.pathname === "/redirect") {
        json(response, 302, plan.body ?? observation, { location: url.searchParams.get("to") ?? "/redirected", ...plan.headers });
        return;
      }
      json(response, plan.status, plan.body ?? observation, plan.headers);
    } catch (error) {
      this.logger.warn("Integration target request rejected", {
        error: error instanceof Error ? error.message : "unknown",
      });
      json(response, 413, { error: "request_too_large" });
    }
  }
}
