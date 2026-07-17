import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "./errors.js";

export interface LocalResolutionObservation {
  status: "available" | "unavailable" | "not_applicable";
  addresses: string[];
}

export interface TargetValidation {
  /** Best-effort telemetry only. Callers must not await this before routing. */
  localResolution: Promise<LocalResolutionObservation>;
}

export type TargetValidator = (
  host: string,
  port: number,
  signal?: AbortSignal,
) => TargetValidation | undefined | Promise<TargetValidation | undefined>;
export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const IPV4_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function ipv4Number(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function ipv4Public(address: string): boolean {
  const value = ipv4Number(address);
  if (value === undefined) return false;
  return !IPV4_BLOCKS.some(([network, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  const normalized = address.split("%")[0] ?? "";
  if (isIP(normalized) !== 6) return undefined;
  const [leftRaw, rightRaw, extra] = normalized.split("::");
  if (extra !== undefined) return undefined;
  const parse = (side: string | undefined): number[] => {
    if (side === undefined || side === "") return [];
    const groups: number[] = [];
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const value = ipv4Number(part);
        if (value === undefined) return [];
        groups.push((value >>> 16) & 0xffff, value & 0xffff);
      } else {
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const left = parse(leftRaw);
  const right = parse(rightRaw);
  const compressed = normalized.includes("::");
  if ((!compressed && left.length !== 8) || left.length + right.length > 8) return undefined;
  const groups = compressed ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return undefined;
  }
  return Uint8Array.from(groups.flatMap((group) => [group >>> 8, group & 0xff]));
}

function hasPrefix(bytes: Uint8Array, expected: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== expected[index]) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((bytes[fullBytes] ?? 0) & mask) === ((expected[fullBytes] ?? 0) & mask);
}

function ipv6Public(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return false;
  // Public IPv6 targets must be in the global-unicast address space. This
  // excludes unallocated and protocol-reserved space before the narrower
  // special-purpose exclusions below are applied.
  if (!hasPrefix(bytes, [0x20], 3)) return false;
  const blocked: ReadonlyArray<readonly [readonly number[], number]> = [
    [[0x20, 0x01, 0x00, 0x00], 32],
    [[0x20, 0x01, 0x00, 0x02], 48],
    [[0x20, 0x01, 0x00, 0x10], 28],
    [[0x20, 0x01, 0x0d, 0xb8], 32],
    [[0x20, 0x02], 16],
    [[0x3f, 0xff], 20],
  ];
  return !blocked.some(([expected, bits]) => hasPrefix(bytes, expected, bits));
}

export function isPublicAddress(address: string): boolean {
  return isIP(address) === 4 ? ipv4Public(address) : isIP(address) === 6 ? ipv6Public(address) : false;
}

export function createTargetValidator(
  allowedPorts: ReadonlySet<number>,
  lookup: Lookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): TargetValidator {
  return (rawHost, port) => {
    if (!allowedPorts.has(port)) throw new AppError("Target port is not allowed", "target_port_forbidden", 403);
    const host = rawHost
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/\.$/, "")
      .toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) {
      throw new AppError("Target must be a public Internet hostname", "target_forbidden", 403);
    }
    if (isIP(host) !== 0) {
      if (!isPublicAddress(host)) {
        throw new AppError("Target must be a public Internet address", "target_forbidden", 403);
      }
      return {
        localResolution: Promise.resolve({ status: "not_applicable", addresses: [host] }),
      };
    }
    const localResolution = Promise.resolve()
      .then(() => lookup(host))
      .then((addresses): LocalResolutionObservation => ({
        status: addresses.length === 0 ? "unavailable" : "available",
        addresses: [...new Set(addresses.map(({ address }) => address))].sort(),
      }))
      .catch((): LocalResolutionObservation => ({ status: "unavailable", addresses: [] }));
    return { localResolution };
  };
}
