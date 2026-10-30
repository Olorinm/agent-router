import { SendMessageRequest } from "@a2a-js/sdk";
import { z } from "zod";
import { setTimeout as sleep } from "node:timers/promises";
import type { CommunicationCore, InboxRecord } from "../communication/core.js";
import type { DurableStore } from "../communication/store.js";
import { ChannelHttpError } from "../channels/http.js";
import type { HostAdmission, HostPort, HostRun, HostStartInput, NativeSessionInput } from "./host.js";
import { runtimeWorkingDirectory } from "./host.js";
import type { ExecutionSession, RunBinding } from "./host-worker.js";
import { digest, key } from "./protocol.js";
import { CliWork, WorkError } from "./work.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/);
const admissionSchema = z.object({ kind: z.enum(["owner", "delegation", "schedule"]), owner: z.string().min(1), agentId: z.string().min(1), reference: z.string().min(1),
  expiresAt: z.iso.datetime().optional(), maxToolCalls: z.number().int().min(0).max(1_000_000).optional(),
  toolGrants: z.object({ business: z.boolean().optional(), feishu: z.boolean().optional(),
    connectedApps: z.object({ connections: z.array(z.string().min(1)).max(100), operations: z.array(z.string().min(1)).max(1000).optional() }).strict().optional(),
  }).strict().optional(),
}).strict();
export interface WorkSessionSubmission {
  eventId: string; sessionId?: string | undefined; input: string; admission: HostAdmission;
  context?: unknown | undefined; inputItems?: Record<string, unknown>[] | undefined; settings?: Record<string, unknown> | undefined; mode?: "turn" | "compact" | undefined;
}
interface SessionMetadata { createdAt: string; title?: string; parentSessionId?: string; archived?: boolean; }
interface WorkEvent { eventId: string; sessionId: string; hash: string; taskId: string; }
export interface WorkEventResult {
  eventId: string; taskId: string; sessionId: string; status: string; answer: string;
  runId?: string; error?: string; outcomeUnknown: boolean;
}
export interface WorkSessionWaitOptions {
  after?: string | undefined; timeoutMs?: number | undefined; signal?: AbortSignal | undefined;
  /** Trusted tool-execution context. Never accept these fields from model input. */
  waitingRunId?: string | undefined; waitingReference?: string | undefined; waitingCallId?: string | undefined;
}
export interface WorkDependencyWait {
  runId: string; reference: string; callId: string; taskIds: string[]; deadlineAt: number; reserve: boolean;
}

/** One agent's authenticated embedding boundary. Callers must authenticate the owner before
 * obtaining this object. Model text and channel ingress never have access to this port. */
export class WorkSessions {
  constructor(readonly agentId: string, readonly owner: string, readonly runtimeId: string,
    readonly instanceId: string, readonly store: DurableStore, readonly work: CliWork,
    readonly host: HostPort, readonly communication: CommunicationCore,
    private readonly validate: () => void = () => {},
    private readonly dependencyWait?: (input: WorkDependencyWait) => () => void) {}

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ChannelHttpError) {
        const native = error.nativeError as { code?: unknown } | undefined;
        if (native?.code === -32601) throw new WorkError("native_method_unsupported", 409, error.nativeError);
        if (native?.code === -32600 || native?.code === -32602) throw new WorkError("native_request_invalid", 400, error.nativeError);
        if ([400, 401, 403, 404, 409, 413, 422].includes(error.status)) throw new WorkError(error.code, error.status, error.nativeError);
        if (error.nativeError !== undefined) throw new WorkError("native_request_failed", 502, error.nativeError);
      }
      if (error instanceof WorkError) throw error;
      throw new WorkError("host_request_failed", 502);
    }
  }

  list() {
    this.validate();
    return this.store.entries<ExecutionSession>("execution_sessions").map(({ id }) => this.getSession(id));
  }
  getSession(sessionId: string) {
    this.validate(); identifier.parse(sessionId);
    const binding = this.store.get<ExecutionSession>("execution_sessions", sessionId);
    if (!binding) throw new WorkError("session_not_found", 404);
    const metadata = this.store.get<SessionMetadata>("work_sessions", sessionId);
    return { sessionId, runtimeId: binding.runtimeId, ...metadata,
      ownerConversation: Boolean(this.ownerInput(sessionId)),
      runs: this.store.entries<RunBinding>("communication_runs").map(({ value }) => value)
        .filter(run => run.contextId === sessionId).map(run => ({ taskId: run.taskId, runId: run.runId ?? null, phase: run.phase, error: run.error ?? null })) };
  }
  private ownerInput(sessionId: string): InboxRecord | undefined {
    return this.store.entries<InboxRecord>("communication_inbox").map(({ value }) => value).reverse()
      .find(input => input.taskId && input.conversationId === sessionId && this.communication.isOwnerInput(input));
  }
  validateTarget(sessionId: string) {
    this.getSession(sessionId);
    if (!this.ownerInput(sessionId)) throw new WorkError("notification_requires_owner_conversation", 403);
    return { sessionId, ownerConversation: true as const };
  }
  private binding(sessionId: string) {
    this.getSession(sessionId);
    return this.store.get<ExecutionSession>("execution_sessions", sessionId)!;
  }
  private reserve(sessionId: string) {
    identifier.parse(sessionId);
    if (!this.store.get<ExecutionSession>("execution_sessions", sessionId)) {
      this.store.set("execution_sessions", sessionId, { sessionId: `h-${digest(key(this.agentId, this.instanceId, sessionId)).slice(0, 40)}`, runtimeId: this.runtimeId } satisfies ExecutionSession);
      this.store.set("work_sessions", sessionId, { createdAt: new Date().toISOString() } satisfies SessionMetadata);
    }
    return this.binding(sessionId);
  }
  async submit(input: WorkSessionSubmission): Promise<WorkEventResult> {
    this.validate(); identifier.parse(input.eventId);
    admissionSchema.parse(input.admission);
    if (input.admission.agentId !== this.agentId || input.admission.owner !== this.owner || !input.admission.reference)
      throw new WorkError("work_admission_scope_mismatch", 403);
    const hash = digest(input), existing = this.store.get<WorkEvent>("work_session_events", input.eventId);
    if (existing) {
      if (existing.hash !== hash) throw new WorkError("work_event_id_reused", 409);
      return this.get(input.eventId);
    }
    if (input.admission.expiresAt && Date.parse(input.admission.expiresAt) <= Date.now()) throw new WorkError("work_admission_expired", 403);
    if (input.admission.kind === "schedule" && !input.admission.toolGrants) throw new WorkError("scheduled_work_grants_required", 403);
    if (Buffer.byteLength(input.input) > 24_000) throw new WorkError("work_input_too_large", 413);
    const sessionId = input.sessionId ?? `w-${digest(key(this.agentId, input.eventId)).slice(0, 40)}`;
    // Existing owner chats retain their native catalog, but this work has no channel reply route.
    // The execution handler denies channel tools without a separately admitted channel message.
    const priorBinding = this.store.get<ExecutionSession>("execution_sessions", sessionId);
    if (priorBinding && priorBinding.channelTools === undefined && this.ownerInput(sessionId))
      this.store.set("execution_sessions", sessionId, { ...priorBinding, channelTools: priorBinding.tools !== false });
    const binding = this.reserve(sessionId);
    if (this.store.get<SessionMetadata>("work_sessions", sessionId)?.archived) throw new WorkError("session_archived", 409);
    this.work.submit(SendMessageRequest.fromJSON({ message: {
      messageId: `work-event-${digest(key(this.agentId, input.eventId))}`, contextId: sessionId,
      role: input.admission.kind === "owner" ? "ROLE_USER" : "ROLE_AGENT", parts: [{ text: input.input }],
    }, configuration: { returnImmediately: true } }), {
      sender: `product:${this.agentId}`, room: `work:${sessionId}`, approved: true,
    }, task => {
      this.store.set("work_session_inputs", task.id, { sessionId: binding.sessionId, runtimeId: binding.runtimeId,
        instructions: "", input: input.input, admission: input.admission,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.inputItems ? { inputItems: input.inputItems } : {}),
        ...(input.settings ? { settings: input.settings } : {}), ...(input.mode ? { mode: input.mode } : {}),
      } satisfies HostStartInput);
      this.store.set("work_session_events", input.eventId, { eventId: input.eventId, sessionId, taskId: task.id, hash } satisfies WorkEvent);
    });
    return this.get(input.eventId);
  }
  lookup(eventId: string): WorkEventResult | null {
    this.validate();
    return this.store.get("work_session_events", eventId) ? this.get(eventId) : null;
  }
  get(eventId: string): WorkEventResult {
    this.validate();
    const event = this.store.get<WorkEvent>("work_session_events", eventId);
    if (!event) throw new WorkError("work_event_not_found", 404);
    const task = this.work.inspect(event.taskId), native = this.store.get<HostRun>("execution_results", event.taskId);
    const run = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value).reverse().find(value => value.taskId === event.taskId);
    return { eventId, taskId: event.taskId, sessionId: event.sessionId,
      status: run?.phase === "unknown" ? "unknown" : task.status === "canceled" ? "cancelled" : task.status,
      answer: native?.answer ?? "", ...(run?.runId ? { runId: run.runId } : {}),
      ...(run?.error ? { error: run.error } : native?.outcome?.error ? { error: native.outcome.error } : {}),
      outcomeUnknown: run?.phase === "unknown" || native?.outcome?.outcomeUnknown === true };
  }
  async cancel(eventId: string) { const event = this.get(eventId); await this.work.cancel(event.taskId); return this.get(eventId); }
  read(sessionId: string) { return this.native(sessionId, { action: "read" }); }
  history(sessionId: string, options: { cursor?: string; limit?: number; itemsView?: "notLoaded" | "summary" | "full"; sortDirection?: "asc" | "desc" } = {}) {
    return this.native(sessionId, { action: "history", ...options });
  }
  async steer(sessionId: string, input: string) {
    const binding = this.binding(sessionId);
    if (!this.host.steer) throw new WorkError("host_steer_unsupported", 409);
    const run = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value)
      .find(run => run.sessionId === binding.sessionId && run.phase === "running" && run.runId);
    if (!run?.runId) throw new WorkError("active_run_not_found", 404);
    await this.request(() => this.host.steer!(run.runId!, input));
  }
  /** Wait on durable Router observations; it does not wake a Host or hold the worker's dispatch loop. */
  async wait(eventIds: string[], options: WorkSessionWaitOptions = {}) {
    if (!eventIds.length || eventIds.length > 8 || new Set(eventIds).size !== eventIds.length) throw new WorkError("invalid_wait_targets", 400);
    const deadline = Date.now() + Math.max(0, Math.min(options.timeoutMs ?? 30_000, 60_000));
    const first = eventIds.map(id => this.get(id));
    const contextual = options.waitingRunId !== undefined || options.waitingReference !== undefined || options.waitingCallId !== undefined;
    const after = options.after ?? (contextual ? digest(first) : undefined);
    const finished = (data: WorkEventResult[]) => contextual && data.every(value => value.outcomeUnknown || ["completed", "failed", "cancelled", "rejected", "unknown"].includes(value.status));
    let release: (() => void) | undefined;
    if (contextual) {
      if (!options.waitingRunId || !options.waitingReference || !options.waitingCallId) throw new WorkError("invalid_dependency_wait_context", 400);
      if (!this.dependencyWait) throw new WorkError("work_dependency_wait_unsupported", 409);
      release = this.dependencyWait({ runId: options.waitingRunId, reference: options.waitingReference, callId: options.waitingCallId,
        taskIds: first.map(value => value.taskId), deadlineAt: deadline, reserve: digest(first) === after && Date.now() < deadline && !finished(first) });
    }
    try {
      for (;;) {
        const data = eventIds.map(id => this.get(id)), cursor = digest(data);
        if (cursor !== after || Date.now() >= deadline || finished(data)) return { data, cursor };
        await sleep(Math.min(250, deadline - Date.now()), undefined, options.signal ? { signal: options.signal } : {});
      }
    } finally { release?.(); }
  }
  async native(sessionId: string, options: Omit<NativeSessionInput, "runtimeId" | "sessionId" | "targetSessionId" | "nativeSessionId">) {
    const binding = this.binding(sessionId);
    if (["list", "bindings", "adopt", "fork"].includes(options.action)) throw new WorkError("use_scoped_session_operation", 400);
    if (!this.host.nativeSessions) throw new WorkError("host_native_sessions_unsupported", 409);
    const result = await this.request(() => this.host.nativeSessions!({ ...options, runtimeId: binding.runtimeId, sessionId: binding.sessionId }));
    if (["rename", "archive", "unarchive"].includes(options.action)) {
      const metadata = this.store.get<SessionMetadata>("work_sessions", sessionId) ?? { createdAt: new Date().toISOString() };
      this.store.set("work_sessions", sessionId, { ...metadata,
        ...(options.action === "rename" ? { title: options.name } : { archived: options.action === "archive" }) });
    }
    return result;
  }
  async fork(sessionId: string, targetSessionId: string, options: { entryId?: string | undefined; beforeEntryId?: string | undefined } = {}) {
    const binding = this.binding(sessionId); identifier.parse(targetSessionId);
    if (this.store.get("execution_sessions", targetSessionId)) throw new WorkError("target_session_exists", 409);
    if (!this.host.nativeSessions) throw new WorkError("host_native_sessions_unsupported", 409);
    const target = `h-${digest(key(this.agentId, this.instanceId, targetSessionId)).slice(0, 40)}`;
    const result = await this.request(() => this.host.nativeSessions!({ action: "fork", runtimeId: binding.runtimeId, sessionId: binding.sessionId, targetSessionId: target, ...options }));
    this.store.transaction(() => {
      this.store.set("execution_sessions", targetSessionId, { ...binding, sessionId: target });
      this.store.set("work_sessions", targetSessionId, { createdAt: new Date().toISOString(), parentSessionId: sessionId });
    });
    return { ...this.getSession(targetSessionId), native: result };
  }
  async discover() {
    this.validate();
    if (!this.host.discoverRuntime) throw new WorkError("host_discovery_unsupported", 409);
    return this.request(() => this.host.discoverRuntime!(this.runtimeId));
  }
  private nativeRequest(method: string, params: Record<string, unknown> = {}, runtimeId = this.runtimeId) {
    this.validate();
    if (!this.host.nativeRequest) throw new WorkError("host_native_extension_unsupported", 409);
    return this.request(() => this.host.nativeRequest!(runtimeId, method, params));
  }
  async skills(forceReload = false) {
    this.validate();
    const cwd = await this.request(() => runtimeWorkingDirectory(this.host, this.runtimeId));
    return this.nativeRequest("skills/list", { forceReload, cwds: [cwd] });
  }
  async configureSkill(path: string, enabled: boolean) {
    const inventory = await this.skills(true) as { data?: Array<{ skills?: Array<{ path?: string }> }> };
    if (!inventory?.data?.some(entry => entry.skills?.some(skill => skill.path === path))) throw new WorkError("skill_not_in_runtime_catalog", 403);
    return this.nativeRequest("skills/config/write", { path, enabled });
  }
  memoryStatus() { return this.nativeRequest("memory/status"); }
  private async nativeBinding(sessionId: string) {
    const binding = this.binding(sessionId);
    if (!this.host.nativeSessions) throw new WorkError("host_native_sessions_unsupported", 409);
    const response = await this.request(() => this.host.nativeSessions!({ runtimeId: binding.runtimeId, action: "bindings" })) as { bindings?: Array<{ sessionId: string; nativeSessionId: string }> };
    const native = response.bindings?.find(row => row.sessionId === binding.sessionId);
    if (!native) throw new WorkError("native_session_binding_not_found", 404);
    return { runtimeId: binding.runtimeId, nativeSessionId: native.nativeSessionId };
  }
  async memoryMode(sessionId: string, mode: "enabled" | "disabled") {
    const binding = await this.nativeBinding(sessionId);
    return this.nativeRequest("thread/memoryMode/set", { threadId: binding.nativeSessionId, mode: z.enum(["enabled", "disabled"]).parse(mode) }, binding.runtimeId);
  }
  async readMemory(sessionId: string) {
    const binding = await this.nativeBinding(sessionId);
    return this.nativeRequest("thread/memory/read", { threadId: binding.nativeSessionId }, binding.runtimeId);
  }
  deliver(input: { eventId: string; targetSessionId: string; text: string }) {
    this.validate(); identifier.parse(input.eventId); this.validateTarget(input.targetSessionId);
    const hash = digest(input), prior = this.store.get<{ hash: string; taskId: string; deliveryId: string }>("work_session_deliveries", input.eventId);
    if (prior && prior.hash !== hash) throw new WorkError("delivery_event_id_reused", 409);
    if (!prior) this.store.transaction(() => {
      const taskId = this.ownerInput(input.targetSessionId)!.taskId!;
      const deliveryId = this.communication.queueContent(taskId, { text: input.text }, `work-event:${input.eventId}`);
      this.store.set("work_session_deliveries", input.eventId, { hash, taskId, deliveryId });
    });
    return this.lookupDelivery(input.eventId)!;
  }
  lookupDelivery(eventId: string) {
    this.validate();
    const prior = this.store.get<{ taskId: string; deliveryId: string }>("work_session_deliveries", eventId);
    return prior ? this.communication.delivery(prior.taskId, prior.deliveryId) : null;
  }
}
