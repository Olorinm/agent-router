import { z } from "zod";
import { ServiceHttp } from "../channels/http.js";
import type { HostTool } from "./tools.js";

const run = z.object({ id: z.string().min(1), sessionId: z.string().min(1), runtimeId: z.string().min(1),
  status: z.enum(["running", "completed", "cancelled", "failed"]), answer: z.string(),
  outcome: z.object({ status: z.string(), error: z.string().optional(), outcomeUnknown: z.boolean().optional() }).optional() });
export type HostRun = z.infer<typeof run>;
export interface HostCall { id: string; runId: string; kind: string; name: string; input: unknown; status: string; deadlineAt: string; }
export interface HostPort {
  identity?: string;
  connect(): Promise<void>;
  start(input: { sessionId: string; runtimeId: string; instructions: string; input: string; context?: unknown; tools?: HostTool[] }): Promise<HostRun>;
  get(id: string): Promise<HostRun>;
  cancel(id: string): Promise<void>;
  calls(id: string): Promise<HostCall[]>;
  resolve(id: string, callId: string, result: unknown): Promise<void>;
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
      status: z.string(), deadlineAt: z.string() })).parse(value.calls) as HostCall[];
  }
  async resolve(id: string, callId: string, result: unknown): Promise<void> {
    await this.http.request(`/v1/runs/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}/result`, { body: { result } });
  }
}
