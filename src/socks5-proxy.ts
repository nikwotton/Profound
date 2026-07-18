import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { expectBufferChunk } from "./decoding.js";
import { beginAttemptBudget, operationDeadline } from "./establishment-budget.js";
import { AppError, AuthenticationError, ProviderUnavailableError } from "./errors.js";
import type { Logger } from "./logger.js";
import { closeServer, listen } from "./net-utils.js";
import { RouteService } from "./route-service.js";
import type { TargetValidator } from "./target-security.js";
import { Telemetry } from "./telemetry.js";
import { establishTunnel } from "./tunnel-operation.js";
import type { AuthenticatedRoute, ListenAddress } from "./types.js";

export interface Socks5ProxyOptions {
  host: string;
  port: number;
  attemptEstablishmentTimeoutMs: number;
  operationEstablishmentTimeoutMs: number;
  streamIdleTimeoutMs: number;
  streamBufferBytes: number;
  maxHandshakeBytes: number;
  targetValidator: TargetValidator;
  logger: Logger;
  telemetry: Telemetry;
}

class HandshakeReader {
  #consumed = 0;

  constructor(
    private readonly socket: Socket,
    private readonly maximumBytes: number,
  ) {}

  async read(length: number): Promise<Buffer> {
    this.#consumed += length;
    if (this.#consumed > this.maximumBytes) throw new AppError("SOCKS5 handshake is too large", "invalid_socks5", 400);
    const chunks: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const rawChunk: unknown = this.socket.read(remaining);
      if (rawChunk !== null) {
        const chunk = expectBufferChunk(rawChunk, "SOCKS5 handshake chunk");
        chunks.push(chunk);
        remaining -= chunk.length;
        continue;
      }
      if (this.socket.readableEnded || this.socket.destroyed) {
        throw new AppError("SOCKS5 handshake ended early", "invalid_socks5", 400);
      }
      await once(this.socket, "readable");
    }
    return Buffer.concat(chunks, length);
  }
}

function ipv6Text(bytes: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16));
  return groups.join(":");
}

async function readTarget(reader: HandshakeReader, addressType: number): Promise<string> {
  if (addressType === 0x01) return [...(await reader.read(4))].join(".");
  if (addressType === 0x04) return ipv6Text(await reader.read(16));
  if (addressType === 0x03) {
    const length = (await reader.read(1)).readUInt8(0);
    if (length === 0) throw new AppError("SOCKS5 target hostname is empty", "invalid_socks5", 400);
    return (await reader.read(length)).toString("utf8");
  }
  throw new AppError("SOCKS5 address type is not supported", "unsupported_socks5_address", 400);
}

function sendReply(socket: Socket, code: number): void {
  if (!socket.destroyed) socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
}

export class Socks5ProxyServer {
  readonly #server;
  #address?: ListenAddress;

  constructor(
    private readonly routes: RouteService,
    private readonly options: Socks5ProxyOptions,
  ) {
    this.#server = createServer((socket) => void this.#handle(socket));
  }

  async start(): Promise<ListenAddress> {
    this.#address = await listen(this.#server, this.options.host, this.options.port);
    return this.#address;
  }

  address(): ListenAddress {
    if (this.#address === undefined) throw new Error("SOCKS5 proxy has not started");
    return this.#address;
  }

  async stop(): Promise<void> {
    await closeServer(this.#server);
  }

  async #handle(clientSocket: Socket): Promise<void> {
    // Handshake failures are normalized below; prevent unhandled socket errors.
    clientSocket.on("error", () => undefined);
    const operationId = randomUUID();
    const startedAt = Date.now();
    const operationSpan = this.options.telemetry.startSpan("proxy.socks5", { "proxy.operation.id": operationId });
    const reader = new HandshakeReader(clientSocket, this.options.maxHandshakeBytes);
    let route: AuthenticatedRoute | undefined;
    let requestAccepted = false;
    let finished = false;
    const establishmentDeadline = operationDeadline(startedAt, this.options.operationEstablishmentTimeoutMs);
    let initialBudget: ReturnType<typeof beginAttemptBudget> | undefined;
    const callerController = new AbortController();
    clientSocket.once("close", () => {
      callerController.abort();
    });
    const finishOperation = (outcome: "success" | "failure", error?: unknown): void => {
      if (finished) return;
      finished = true;
      this.options.telemetry.finishSpan(
        operationSpan,
        startedAt,
        {
          plane: "data",
          protocol: "socks5",
          outcome,
          ...(route === undefined
            ? {}
            : {
                "proxy.route.id": route.id,
                "proxy.access_grant.id": route.accessGrantId,
                "enduser.id": route.userId,
                "customer.id": route.customerId,
              }),
        },
        error,
      );
    };

    clientSocket.setTimeout(this.options.attemptEstablishmentTimeoutMs, () => {
      clientSocket.destroy(new ProviderUnavailableError("SOCKS5 handshake timed out", "timeout"));
    });
    try {
      const greeting = await reader.read(2);
      if (greeting.readUInt8(0) !== 0x05) throw new AppError("SOCKS5 version 5 is required", "invalid_socks5", 400);
      const methods = await reader.read(greeting.readUInt8(1));
      if (!methods.includes(0x02)) {
        clientSocket.end(Buffer.from([0x05, 0xff]));
        throw new AuthenticationError("SOCKS5 username/password authentication is required");
      }
      clientSocket.write(Buffer.from([0x05, 0x02]));

      const authHeader = await reader.read(2);
      if (authHeader.readUInt8(0) !== 0x01 || authHeader.readUInt8(1) === 0) throw new AuthenticationError();
      const username = (await reader.read(authHeader.readUInt8(1))).toString("utf8");
      const passwordLength = (await reader.read(1)).readUInt8(0);
      const password = (await reader.read(passwordLength)).toString("utf8");
      try {
        route = await this.routes.authenticate(username, password);
      } catch {
        clientSocket.end(Buffer.from([0x01, 0x01]));
        throw new AuthenticationError();
      }
      clientSocket.write(Buffer.from([0x01, 0x00]));

      const request = await reader.read(4);
      requestAccepted = true;
      if (request.readUInt8(0) !== 0x05 || request.readUInt8(2) !== 0x00) {
        throw new AppError("Invalid SOCKS5 request", "invalid_socks5", 400);
      }
      const targetHost = await readTarget(reader, request.readUInt8(3));
      const targetPort = (await reader.read(2)).readUInt16BE(0);
      if (request.readUInt8(1) !== 0x01) {
        sendReply(clientSocket, 0x07);
        clientSocket.end();
        finishOperation("failure", new AppError("SOCKS5 supports TCP CONNECT only", "unsupported_socks5_command", 400));
        return;
      }
      this.routes.assertProtocolAllowed(route, "socks5");
      initialBudget = beginAttemptBudget(establishmentDeadline, this.options.attemptEstablishmentTimeoutMs, callerController.signal);
      const targetValidation = await this.options.targetValidator(targetHost, targetPort, initialBudget.signal);
      operationSpan.setAttributes({
        "proxy.route.id": route.id,
        "proxy.access_grant.id": route.accessGrantId,
        "proxy.provider.primary": route.provider,
        "enduser.id": route.userId,
        "customer.id": route.customerId,
        "server.address": targetHost,
        "server.port": targetPort,
      });

      await establishTunnel({
        routes: this.routes,
        route,
        protocol: "socks5",
        target: { host: targetHost, port: targetPort },
        targetValidation,
        clientSocket,
        callerSignal: callerController.signal,
        operationId,
        operationSpan,
        operationFinished: finishOperation,
        establishmentDeadline,
        initialBudget,
        attemptEstablishmentTimeoutMs: this.options.attemptEstablishmentTimeoutMs,
        streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
        streamBufferBytes: this.options.streamBufferBytes,
        maxHandshakeBytes: this.options.maxHandshakeBytes,
        logger: this.options.logger,
        telemetry: this.options.telemetry,
        prepareClient: (opened) => {
          clientSocket.setTimeout(this.options.streamIdleTimeoutMs, () => {
            clientSocket.destroy(new ProviderUnavailableError("SOCKS5 tunnel exceeded the stream idle timeout", "timeout"));
          });
          sendReply(clientSocket, 0x00);
          if (opened.remainder.length > 0) clientSocket.write(opened.remainder);
          return { bytesSent: 0, bytesReceived: opened.remainder.length };
        },
      });
    } catch (error) {
      initialBudget?.finish();
      finishOperation("failure", error);
      if (requestAccepted && !clientSocket.destroyed) {
        const replyCode =
          error instanceof AppError && error.code === "unsupported_socks5_address"
            ? 0x08
            : error instanceof AppError && error.statusCode === 403
              ? 0x02
              : 0x01;
        sendReply(clientSocket, replyCode);
        clientSocket.end();
      } else if (!clientSocket.destroyed && !clientSocket.writableEnded) {
        clientSocket.destroy();
      }
    }
  }
}
