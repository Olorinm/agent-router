export class ChannelHttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly nativeError?: unknown) { super(code); }
}

/** Configured service endpoints only; credentials are never followed across redirects. */
export class ServiceHttp {
  constructor(readonly baseUrl: string, readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_service_url");
  }
  async request(path: string, options: { body?: unknown; headers?: HeadersInit; signal?: AbortSignal } = {}): Promise<any> {
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${this.token}`); headers.set("content-type", "application/json");
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: options.body === undefined ? "GET" : "POST", headers, redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const value = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const nested = value?.error && typeof value.error === "object" ? value.error as Record<string, unknown> : undefined;
      const code = typeof value?.error === "string" ? value.error : typeof value?.code === "string" ? value.code :
        typeof nested?.code === "string" ? nested.code : `http_${response.status}`;
      throw new ChannelHttpError(response.status, code, value?.nativeError);
    }
    if (!value) throw new Error("invalid_service_response");
    return value;
  }
}
