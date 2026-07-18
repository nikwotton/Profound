import { once } from "node:events";
import { connect, isIP, type Socket } from "node:net";
import { AppError, ProviderCapacityLimitError, ProviderUnavailableError, UpstreamError } from "./errors.js";
import { expectBufferChunk } from "./decoding.js";
import { abortReason } from "./establishment-budget.js";
import { basicAuth } from "./net-utils.js";
import { resolvedAddressesFromHeader, type ProviderResolutionMetadata } from "./destination-resolution.js";
import type { UpstreamEndpoint } from "./domain/routing.js";

export interface TunnelTarget {
  host: string;
  port: number;
}

export interface OpenTunnelOptions {
  connectTimeoutMs: number;
  maxHandshakeBytes: number;
  signal: AbortSignal;
}

export interface OpenedUpstreamTunnel {
  socket: Socket;
  remainder: Buffer;
  providerMetadata: ProviderResolutionMetadata & {
    opaqueIpId?: string;
  };
}

function authority(target: TunnelTarget): string {
  return `${isIP(target.host) === 6 ? `[${target.host}]` : target.host}:${target.port}`;
}

async function readExactly(socket: Socket, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = length;
  while (remaining > 0) {
    const rawChunk: unknown = socket.read(remaining);
    if (rawChunk !== null) {
      const chunk = expectBufferChunk(rawChunk, "upstream SOCKS5 response chunk");
      chunks.push(chunk);
      remaining -= chunk.length;
      continue;
    }
    if (socket.readableEnded || socket.destroyed) {
      throw new ProviderUnavailableError("Upstream proxy closed during SOCKS5 negotiation");
    }
    await once(socket, "readable");
  }
  return Buffer.concat(chunks, length);
}

function ipv6Bytes(address: string): Buffer {
  const [leftText, rightText] = address.toLowerCase().split("::");
  const parseSide = (text: string | undefined): number[] => {
    if (text === undefined || text === "") return [];
    const parts = text.split(":");
    const result: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const octets = part.split(".").map(Number);
        const [first, second, third, fourth] = octets;
        if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
          throw new ProviderUnavailableError("Upstream SOCKS5 proxy address is invalid");
        }
        result.push((first << 8) | second, (third << 8) | fourth);
      } else {
        result.push(Number.parseInt(part, 16));
      }
    }
    return result;
  };
  const left = parseSide(leftText);
  const right = parseSide(rightText);
  const groups = address.includes("::") ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right] : left;
  const output = Buffer.alloc(16);
  groups.forEach((group, index) => output.writeUInt16BE(group, index * 2));
  return output;
}

function socksAddress(target: TunnelTarget): Buffer {
  const family = isIP(target.host);
  if (family === 4) {
    return Buffer.from([0x01, ...target.host.split(".").map(Number)]);
  }
  if (family === 6) return Buffer.concat([Buffer.from([0x04]), ipv6Bytes(target.host)]);
  const domain = Buffer.from(target.host, "utf8");
  if (domain.length === 0 || domain.length > 255) {
    throw new ProviderUnavailableError("Target hostname cannot be encoded for SOCKS5");
  }
  return Buffer.concat([Buffer.from([0x03, domain.length]), domain]);
}

async function openHttpTunnel(
  socket: Socket,
  target: TunnelTarget,
  upstream: UpstreamEndpoint,
  maxHandshakeBytes: number,
): Promise<{ remainder: Buffer; providerMetadata: OpenedUpstreamTunnel["providerMetadata"] }> {
  socket.write(
    `CONNECT ${authority(target)} HTTP/1.1\r\n` +
      `Host: ${authority(target)}\r\n` +
      `Proxy-Authorization: ${basicAuth(upstream.username, upstream.password)}\r\n` +
      "Connection: keep-alive\r\n\r\n",
  );
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (message: string): void => {
      cleanup();
      reject(new ProviderUnavailableError(message));
    };
    const onError = (): void => fail("Upstream proxy connection failed during tunnel negotiation");
    const onClose = (): void => fail("Upstream proxy closed during tunnel negotiation");
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxHandshakeBytes) {
        fail("Upstream proxy response headers were too large");
        return;
      }
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      cleanup();
      const statusLine = buffer.subarray(0, boundary).toString("latin1").split("\r\n")[0] ?? "";
      const headerLines = buffer.subarray(0, boundary).toString("latin1").split("\r\n").slice(1);
      const headers = new Map(
        headerLines.map((line) => {
          const separator = line.indexOf(":");
          return separator < 0
            ? [line.toLowerCase(), ""]
            : [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
        }),
      );
      const status = Number(statusLine.split(" ")[1]);
      if (status === 407) {
        reject(new UpstreamError("Upstream provider authentication failed"));
        return;
      }
      if (status === 509) {
        reject(new ProviderCapacityLimitError());
        return;
      }
      if (status !== 200) {
        reject(new ProviderUnavailableError("Upstream provider rejected the tunnel"));
        return;
      }
      socket.pause();
      const opaqueIpId = headers.get("x-brd-ip") ?? headers.get("x-mock-exit-ip");
      const resolvedDestinationAddresses = resolvedAddressesFromHeader(headers.get("x-mock-resolved-destination"));
      const resolverCountry = headers.get("x-mock-resolver-country");
      resolve({
        remainder: buffer.subarray(boundary + 4),
        providerMetadata: {
          ...(opaqueIpId === undefined ? {} : { opaqueIpId }),
          ...(resolvedDestinationAddresses === undefined ? {} : { resolvedDestinationAddresses }),
          ...(resolverCountry === undefined ? {} : { resolverCountry }),
        },
      });
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function openSocks5Tunnel(
  socket: Socket,
  target: TunnelTarget,
  upstream: UpstreamEndpoint,
): Promise<{ remainder: Buffer; providerMetadata: OpenedUpstreamTunnel["providerMetadata"] }> {
  const username = Buffer.from(upstream.username, "utf8");
  const password = Buffer.from(upstream.password, "utf8");
  if (username.length === 0 || username.length > 255 || password.length === 0 || password.length > 255) {
    throw new ProviderUnavailableError("Upstream credentials cannot be encoded for SOCKS5");
  }
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  const method = await readExactly(socket, 2);
  if (method[0] !== 0x05 || method[1] !== 0x02) {
    throw new UpstreamError("Upstream SOCKS5 proxy rejected authentication negotiation");
  }
  socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
  const authentication = await readExactly(socket, 2);
  if (authentication[0] !== 0x01 || authentication[1] !== 0x00) {
    throw new UpstreamError("Upstream SOCKS5 proxy rejected credentials");
  }
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socksAddress(target), port]));
  const reply = await readExactly(socket, 4);
  if (reply[0] !== 0x05 || reply[1] !== 0x00) {
    throw new ProviderUnavailableError("Upstream SOCKS5 proxy rejected the tunnel");
  }
  const addressType = reply.readUInt8(3);
  const addressLength =
    addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : addressType === 0x03 ? (await readExactly(socket, 1)).readUInt8(0) : undefined;
  if (addressLength === undefined) throw new ProviderUnavailableError("Upstream SOCKS5 proxy sent an invalid reply");
  await readExactly(socket, addressLength + 2);
  return { remainder: Buffer.alloc(0), providerMetadata: {} };
}

export async function openUpstreamTunnel(
  target: TunnelTarget,
  upstream: UpstreamEndpoint,
  options: OpenTunnelOptions,
): Promise<OpenedUpstreamTunnel> {
  const socket = connect(upstream.port, upstream.host);
  const abort = (): void => {
    // The awaited operation reports the signal's authoritative reason below.
    // Destroying with that error can emit it after `once()` has detached its
    // temporary error listener, turning a handled timeout into an uncaught one.
    socket.destroy();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    socket.destroy(new ProviderUnavailableError("Upstream proxy timed out", "timeout"));
  }, options.connectTimeoutMs);
  try {
    await once(socket, "connect", { signal: options.signal });
    const opened =
      upstream.protocol === "http"
        ? await openHttpTunnel(socket, target, upstream, options.maxHandshakeBytes)
        : await openSocks5Tunnel(socket, target, upstream);
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
    return { socket, ...opened };
  } catch (error) {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
    socket.destroy();
    if (options.signal.aborted) throw abortReason(options.signal);
    if (error instanceof AppError) throw error;
    throw new ProviderUnavailableError("Upstream provider connection failed");
  }
}
