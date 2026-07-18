import { createRequire } from "node:module";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { isUnknownRecord } from "./decoding.js";

type DomainParser = (hostname: string, options?: { allowPrivateDomains?: boolean }) => string | null;

const require = createRequire(import.meta.url);
const parseRegistrableDomain = (() => {
  try {
    const module: unknown = require("tldts");
    if (!isUnknownRecord(module) || typeof module["getDomain"] !== "function") throw new Error("tldts.getDomain is unavailable");
    const getDomain = module["getDomain"];
    return ((hostname: string, options?: { allowPrivateDomains?: boolean }) => {
      const value: unknown = Reflect.apply(getDomain, undefined, [hostname, options]);
      return typeof value === "string" ? value : null;
    }) satisfies DomainParser;
  } catch {
    // The fallback is used only by source-only developer checkouts whose shared
    // node_modules predates the lockfile. Production and CI install tldts.
    return ((hostname: string) => hostname.split(".").slice(-2).join(".")) satisfies DomainParser;
  }
})();

function canonicalHostname(hostname: string): string {
  const withoutTrailingDot = hostname.trim().replace(/\.$/, "").toLowerCase();
  return domainToASCII(withoutTrailingDot) || withoutTrailingDot;
}

function pathTemplate(pathname: string): string | undefined {
  if (pathname === "" || pathname === "/") return "/";
  const segments = pathname.split("/").slice(1);
  const templated: string[] = [];
  for (const raw of segments) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === "") {
      templated.push("");
      continue;
    }
    if (/^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) {
      templated.push(":id");
      continue;
    }
    if (segment.length >= 16 && /[a-z]/i.test(segment) && /\d/.test(segment)) {
      templated.push(":id");
      continue;
    }
    if (!/^[a-z][a-z0-9._~-]{0,63}$/i.test(segment)) return undefined;
    templated.push(segment);
  }
  return `/${templated.join("/")}`;
}

export function usageDestination(
  hostname: string,
  port: number,
  plaintextPathname?: string,
): {
  destinationDomain: string;
  destinationHost: string;
  destinationPort: number;
  destinationPathTemplate?: string;
} {
  const destinationHost = canonicalHostname(hostname);
  const destinationDomain = isIP(destinationHost) === 0 ? (parseRegistrableDomain(destinationHost) ?? destinationHost) : destinationHost;
  const template = plaintextPathname === undefined ? undefined : pathTemplate(plaintextPathname);
  return {
    destinationDomain,
    destinationHost,
    destinationPort: port,
    ...(template === undefined ? {} : { destinationPathTemplate: template }),
  };
}
