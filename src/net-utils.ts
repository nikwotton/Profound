import type { Server } from "node:net";
import { AppError } from "./errors.js";
import type { ListenAddress } from "./domain/network.js";

export async function listen(server: Server, host: string, port: number): Promise<ListenAddress> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server did not bind to a TCP address");
  }
  return { host: address.address, port: address.port };
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export function parseBasicAuth(header: string | undefined): { username: string; password: string } | undefined {
  if (header === undefined || !header.startsWith("Basic ")) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return undefined;
  }
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function parseHostPort(authority: string, defaultPort: number): { host: string; port: number } {
  try {
    const url = new URL(`http://${authority}`);
    if (
      authority.trim() === "" ||
      url.hostname === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("Invalid authority");
    }
    return {
      host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: url.port === "" ? defaultPort : Number(url.port),
    };
  } catch {
    throw new AppError("CONNECT requires a host:port authority without credentials, path, or query", "invalid_target", 400);
  }
}
