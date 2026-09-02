import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export interface EndpointPolicy {
  allowHttp: boolean;
  allowPrivate: boolean;
}

export interface ResolvedEndpoint {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}

export async function assertSafeEndpoint(rawUrl: string, policy: EndpointPolicy): Promise<URL> {
  return (await resolveSafeEndpoint(rawUrl, policy)).url;
}

export async function resolveSafeEndpoint(rawUrl: string, policy: EndpointPolicy): Promise<ResolvedEndpoint> {
  const url = new URL(rawUrl);
  if (url.username || url.password) throw new Error("agent_endpoint_userinfo_forbidden");
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    throw new Error("agent_endpoint_https_required");
  }
  if (!url.hostname) throw new Error("agent_endpoint_hostname_required");

  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("agent_endpoint_dns_empty");
  if (!policy.allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("agent_endpoint_private_address_forbidden");
  }
  return { url, addresses };
}

export function isPrivateAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() !== "unicast";
  } catch {
    return true;
  }
}
