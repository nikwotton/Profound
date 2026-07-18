import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { expectBufferChunk } from "../src/decoding.js";

export type ProxySocket = Socket | TLSSocket;

export interface ProxyResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function proxyWithCredentials(proxyUrl: string, username: string, password: string): string {
  const url = new URL(proxyUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

export async function openProxySocket(proxy: URL): Promise<ProxySocket> {
  const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  const socket =
    proxy.protocol === "https:"
      ? tlsConnect({
          host: proxy.hostname,
          port,
          servername: isIP(proxy.hostname) === 0 ? proxy.hostname : undefined,
        })
      : netConnect({ host: proxy.hostname, port });
  await once(socket, proxy.protocol === "https:" ? "secureConnect" : "connect");
  return socket;
}

export async function readExactly(socket: ProxySocket, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = length;
  while (remaining > 0) {
    const chunk = socket.read(remaining) as Buffer | null;
    if (chunk !== null) {
      chunks.push(chunk);
      remaining -= chunk.length;
      continue;
    }
    if (socket.readableEnded || socket.destroyed) throw new Error("Socket closed before the expected bytes arrived");
    await once(socket, "readable");
  }
  return Buffer.concat(chunks, length);
}

export async function readHeaders(socket: ProxySocket, maximumBytes = 64 * 1024): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void => fail(new Error("Socket closed while reading headers"));
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maximumBytes) {
        fail(new Error("Response headers exceed the integration-test limit"));
        return;
      }
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      cleanup();
      socket.pause();
      const remainder = buffer.subarray(boundary + 4);
      if (remainder.length > 0) socket.unshift(remainder);
      resolve(buffer.subarray(0, boundary).toString("latin1"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export function parsedHeaders(headerBlock: string): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const line of headerBlock.split("\r\n").slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

export async function collectHttpResponse(socket: ProxySocket): Promise<ProxyResponse> {
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(expectBufferChunk(chunk));
  const response = Buffer.concat(chunks);
  const boundary = response.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("Target returned an invalid HTTP response");
  const header = response.subarray(0, boundary).toString("latin1");
  return {
    status: Number(header.split(" ")[1] ?? 0),
    headers: parsedHeaders(header),
    body: response.subarray(boundary + 4).toString("utf8"),
  };
}
