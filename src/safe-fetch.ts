import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { EndpointPolicy } from "./endpoint-policy.js";
import { resolveSafeEndpoint } from "./endpoint-policy.js";

const MAX_DISPATCHERS = 100;

/**
 * Fetches untrusted Router and Agent URLs without following redirects. DNS is
 * resolved and checked immediately before the connection, then the connection
 * is pinned to one of those checked addresses to prevent DNS rebinding.
 */
export class SafeHttpClient {
  private readonly dispatchers = new Map<string, Agent>();

  constructor(private readonly policy: EndpointPolicy) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : input.toString();
    const resolved = await resolveSafeEndpoint(rawUrl, this.policy);
    const selected = resolved.addresses[0];
    if (!selected) throw new Error("safe_fetch_address_missing");
    const dispatcher = this.dispatcherFor(resolved.url.origin, selected);
    return undiciFetch(resolved.url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
      redirect: "error",
    }) as unknown as Promise<Response>;
  };

  async close(): Promise<void> {
    await Promise.allSettled([...this.dispatchers.values()].map((dispatcher) => dispatcher.close()));
    this.dispatchers.clear();
  }

  private dispatcherFor(origin: string, selected: { address: string; family: number }): Agent {
    const key = `${origin}|${selected.family}|${selected.address}`;
    const existing = this.dispatchers.get(key);
    if (existing) return existing;

    const lookup = ((_hostname, options, callback) => {
      if (typeof options === "object" && options.all) {
        callback(null, [{ address: selected.address, family: selected.family }]);
        return;
      }
      callback(null, selected.address, selected.family);
    }) as LookupFunction;
    const dispatcher = new Agent({
      connect: { lookup },
      connectTimeout: 10_000,
      headersTimeout: 15_000,
      bodyTimeout: 30_000,
      maxResponseSize: 2 * 1024 * 1024,
    });
    this.dispatchers.set(key, dispatcher);
    if (this.dispatchers.size > MAX_DISPATCHERS) {
      const oldestKey = this.dispatchers.keys().next().value as string | undefined;
      if (oldestKey && oldestKey !== key) {
        const oldest = this.dispatchers.get(oldestKey);
        this.dispatchers.delete(oldestKey);
        void oldest?.close();
      }
    }
    return dispatcher;
  }
}
