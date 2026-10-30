import { z } from "zod";
import { ChannelHttpError, ServiceHttp } from "../channels/http.js";
import type { HostTool } from "./tools.js";
import type { MediaContent } from "../communication/types.js";

const run = z.object({ id: z.string().min(1), sessionId: z.string().min(1), runtimeId: z.string().min(1),
  status: z.enum(["running", "completed", "cancelled", "failed"]), answer: z.string(),
  outcome: z.object({ status: z.string(), error: z.string().optional(), outcomeUnknown: z.boolean().optional() }).optional() }).passthrough();
export type HostRun = z.infer<typeof run>;
export interface HostCall { id: string; runId: string; kind: string; name: string; namespace?: string; input: unknown; status: string; deadlineAt: string; result?: unknown; createdAt?: string; nativeCallId?: string; }
/** Authored by the embedding product/Router, never inferred from model text or tool names.
 * Product Host decorators must consume this field before sending the public Host request. */
export interface HostAdmission {
  kind: "owner" | "delegation" | "schedule"; owner: string; agentId: string; reference: string;
  toolGrants?: { business?: boolean | undefined; feishu?: boolean | undefined; connectedApps?: { connections: string[]; operations?: string[] | undefined } | undefined } | undefined;
  expiresAt?: string | undefined; maxToolCalls?: number | undefined;
}
export interface HostStartInput {
  sessionId: string; runtimeId: string; instructions: string; input: string;
  requestKey?: string; context?: unknown; tools?: HostTool[]; attachments?: MediaContent[];
  inputItems?: Record<string, unknown>[]; settings?: Record<string, unknown>; mode?: "turn" | "compact";
  toolOutput?: Record<string, unknown>;
  admission?: HostAdmission;
}
export interface NativeSessionInput {
  runtimeId: string; action: "list" | "bindings" | "read" | "history" | "items" | "fork" | "delete" | "rename" | "archive" | "unarchive" | "adopt";
  sessionId?: string | undefined; targetSessionId?: string | undefined; nativeSessionId?: string | undefined; entryId?: string | undefined;
  limit?: number | undefined; cursor?: string | undefined; name?: string | undefined; turnId?: string | undefined; sortDirection?: "asc" | "desc" | undefined;
  itemsView?: "notLoaded" | "summary" | "full" | undefined; beforeEntryId?: string | undefined; archived?: boolean | undefined;
  searchTerm?: string | undefined; sourceKinds?: string[] | undefined; instructions?: string | undefined; tools?: HostTool[] | undefined;
}
export interface HostPort {
  identity?: string;
  supportsRunLookup?: boolean;
  connect(): Promise<void>;
  start(input: HostStartInput): Promise<HostRun>;
  findRun?(runtimeId: string, requestKey: string): Promise<HostRun | null>;
  inspectRuntime?(runtimeId: string): Promise<unknown>;
  discoverRuntime?(runtimeId: string): Promise<unknown>;
  nativeSessions?(input: NativeSessionInput): Promise<unknown>;
  /** Trusted embedding only. Do not expose arbitrary methods to model tools or owner HTTP routes. */
  nativeRequest?(runtimeId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  nativeNotification?(runtimeId: string, method: string, params?: Record<string, unknown>): Promise<void>;
  nativeEvents?(runtimeId: string, after?: number, limit?: number, epoch?: string): Promise<unknown>;
  nativeRequests?(runtimeId: string): Promise<unknown>;
  resolveNativeRequest?(runtimeId: string, requestId: string, response: { result?: unknown; error?: unknown }): Promise<void>;
  get(id: string): Promise<HostRun>;
  cancel(id: string): Promise<void>;
  calls(id: string): Promise<HostCall[]>;
  resolve(id: string, callId: string, result: unknown): Promise<void>;
  events?(id: string, after: number, limit?: number): Promise<{ events: Array<{ sequence: number; event: Record<string, unknown> }>; cursor: number; hasMore: boolean; historyTruncated: boolean }>;
  steer?(id: string, input: string): Promise<void>;
  readFile?(sessionId: string, path: string): Promise<{ content: string; encoding: string }>;
  writeFile?(sessionId: string, path: string, content: string): Promise<void>;
}

/** Uses Agent Host's public HTTP v1 contract; no native runtime packages in the Router process. */
export class HttpAgentHost implements HostPort {
  readonly identity: string;
  supportsRunLookup = false;
  constructor(readonly http: ServiceHttp) { this.identity = http.baseUrl.replace(/\/$/, ""); }
  async connect(): Promise<void> {
    const health = await this.http.request("/v1/health");
    if (health.protocolVersion !== 1) throw new Error("unsupported_host_protocol");
    this.supportsRunLookup = health.capabilities?.runIdempotency === true;
  }
  async start(input: HostStartInput): Promise<HostRun> {
    const { admission: _admission, ...request } = input;
    if (request.requestKey !== undefined && !this.supportsRunLookup)
      throw new ChannelHttpError(409, "host_run_idempotency_unsupported");
    return run.parse(await this.http.request("/v1/runs", { body: request }));
  }
  async findRun(runtimeId: string, requestKey: string): Promise<HostRun | null> {
    if (!this.supportsRunLookup) throw new ChannelHttpError(409, "host_run_lookup_unsupported");
    const value = await this.http.request(`/v1/runs/by-request?${new URLSearchParams({ runtimeId, requestKey })}`);
    return value.run === null ? null : run.parse(value.run);
  }
  async discoverRuntime(runtimeId: string) { return this.http.request("/v1/runtimes/discover", { body: { runtimeId } }); }
  async inspectRuntime(runtimeId: string) { return this.http.request("/v1/runtimes/inspect", { body: { runtimeId } }); }
  async nativeSessions(input: NativeSessionInput) { return this.http.request("/v1/native-sessions", { body: input }); }
  async nativeRequest(runtimeId: string, method: string, params?: Record<string, unknown>) {
    const response = await this.http.request("/v1/runtimes/native", { body: { runtimeId, method, ...(params === undefined ? {} : { params }) } });
    return response.result;
  }
  async nativeNotification(runtimeId: string, method: string, params?: Record<string, unknown>) {
    await this.http.request("/v1/runtimes/native", { body: { runtimeId, method, notification: true, ...(params === undefined ? {} : { params }) } });
  }
  async nativeEvents(runtimeId: string, after = 0, limit = 200, epoch?: string) {
    return this.http.request(`/v1/runtimes/${encodeURIComponent(runtimeId)}/native-events?${new URLSearchParams({ after: String(after), limit: String(limit), ...(epoch ? { epoch } : {}) })}`);
  }
  async nativeRequests(runtimeId: string) { return this.http.request(`/v1/runtimes/${encodeURIComponent(runtimeId)}/native-requests`); }
  async resolveNativeRequest(runtimeId: string, requestId: string, response: { result?: unknown; error?: unknown }) {
    await this.http.request(`/v1/runtimes/${encodeURIComponent(runtimeId)}/native-requests/${encodeURIComponent(requestId)}/result`, { body: response });
  }
  async get(id: string): Promise<HostRun> { return run.parse(await this.http.request(`/v1/runs/${encodeURIComponent(id)}`)); }
  async cancel(id: string): Promise<void> { await this.http.request(`/v1/runs/${encodeURIComponent(id)}/cancel`, { body: {} }); }
  async calls(id: string): Promise<HostCall[]> {
    const value = await this.http.request(`/v1/runs/${encodeURIComponent(id)}/calls`);
    return z.array(z.object({ id: z.string(), runId: z.string(), kind: z.string(), name: z.string(), input: z.unknown(),
      status: z.string(), deadlineAt: z.string(), result: z.unknown().optional(), createdAt: z.string().optional(), nativeCallId: z.string().optional() }).passthrough()).parse(value.calls) as HostCall[];
  }
  async resolve(id: string, callId: string, result: unknown): Promise<void> {
    await this.http.request(`/v1/runs/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}/result`, { body: { result } });
  }
  async events(id: string, after: number, limit = 200) {
    const page = z.object({ events: z.array(z.object({ sequence: z.number().int().nonnegative(),
      event: z.record(z.string(), z.unknown()) }).passthrough()), cursor: z.number().int().nonnegative(),
      hasMore: z.boolean(), historyTruncated: z.boolean() }).passthrough().parse(
        await this.http.request(`/v1/runs/${encodeURIComponent(id)}/events?after=${after}&limit=${limit}`));
    let previous = after;
    for (const item of page.events) {
      if (item.sequence <= previous || item.sequence > page.cursor) throw new Error("invalid_host_event_cursor");
      previous = item.sequence;
    }
    if (page.cursor < after) throw new Error("invalid_host_event_cursor");
    return page;
  }
  async steer(id: string, input: string) { await this.http.request(`/v1/runs/${encodeURIComponent(id)}/steer`, { body: { input } }); }
  async readFile(sessionId: string, path: string) { return this.http.request(`/v1/sessions/${encodeURIComponent(sessionId)}/files?encoding=base64&path=${encodeURIComponent(path)}`); }
  async writeFile(sessionId: string, path: string, content: string) { await this.http.request(`/v1/sessions/${encodeURIComponent(sessionId)}/files`, { body: { path, content, encoding: "base64" } }); }
}

/** Runtime-owned workspace scope, never selected by model arguments or skill paths. */
export async function runtimeWorkingDirectory(host: HostPort, runtimeId: string): Promise<string> {
  const inspect = host.inspectRuntime ?? host.discoverRuntime;
  if (!inspect) throw new ChannelHttpError(409, "host_runtime_inspection_unsupported");
  const value = z.object({ id: z.string(), cwd: z.string().min(1) }).passthrough().safeParse(await inspect.call(host, runtimeId));
  if (!value.success || value.data.id !== runtimeId) throw new ChannelHttpError(409, "host_runtime_scope_mismatch");
  return value.data.cwd;
}
