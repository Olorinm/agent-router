import { z } from "zod";
import { ServiceHttp } from "../channels/http.js";
import type { HostTool } from "./tools.js";
import type { MediaContent } from "../communication/types.js";

const run = z.object({ id: z.string().min(1), sessionId: z.string().min(1), runtimeId: z.string().min(1),
  status: z.enum(["running", "completed", "cancelled", "failed"]), answer: z.string(),
  outcome: z.object({ status: z.string(), error: z.string().optional(), outcomeUnknown: z.boolean().optional() }).optional() }).passthrough();
export type HostRun = z.infer<typeof run>;
export interface HostCall { id: string; runId: string; kind: string; name: string; input: unknown; status: string; deadlineAt: string; result?: unknown; createdAt?: string; nativeCallId?: string; }
export interface HostPort {
  identity?: string;
  connect(): Promise<void>;
  start(input: { sessionId: string; runtimeId: string; instructions: string; input: string; context?: unknown; tools?: HostTool[]; attachments?: MediaContent[] }): Promise<HostRun>;
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
  constructor(readonly http: ServiceHttp) { this.identity = http.baseUrl.replace(/\/$/, ""); }
  async connect(): Promise<void> {
    if ((await this.http.request("/v1/health")).protocolVersion !== 1) throw new Error("unsupported_host_protocol");
  }
  async start(input: Parameters<HostPort["start"]>[0]): Promise<HostRun> { return run.parse(await this.http.request("/v1/runs", { body: input })); }
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
