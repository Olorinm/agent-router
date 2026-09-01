import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface EndpointPolicy {
  allowHttp: boolean;
  allowPrivate: boolean;
}

export async function assertSafeEndpoint(rawUrl: string, policy: EndpointPolicy): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.username || url.password) throw new Error("agent_endpoint_userinfo_forbidden");
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    throw new Error("agent_endpoint_https_required");
  }
  if (!url.hostname) throw new Error("agent_endpoint_hostname_required");

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("agent_endpoint_dns_empty");
  if (!policy.allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("agent_endpoint_private_address_forbidden");
  }
  return url;
}

export function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const ipv4 = mapped ?? (isIP(address) === 4 ? address : undefined);
  if (!ipv4) return false;
  const parts = ipv4.split(".").map(Number);
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
