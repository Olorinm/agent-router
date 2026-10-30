import { interaction } from "../communication/interaction.js";
import { archiveRun } from "./run-archive.js";
import type { CommunicationCore, InboxRecord } from "../communication/core.js";
import { Message } from "@a2a-js/sdk";
import { ChannelHttpError } from "../channels/http.js";
import { DurableStore } from "../communication/store.js";
import { digest, key } from "./protocol.js";
import { CliWork, WorkError } from "./work.js";
import type { HostAdmission, HostCall, HostPort, HostStartInput } from "./host.js";
import { runtimeWorkingDirectory } from "./host.js";
import type { HostTools, HostToolResult } from "./tools.js";
import type { WorkDependencyWait } from "./sessions.js";

interface ToolReceipt { hash: string; phase: "executing" | "completed" | "uncertain"; result?: HostToolResult; }

export interface ExecutionSession { sessionId: string; runtimeId: string; tools?: false; channelTools?: boolean; }

export interface RunBinding {
  claimId: string; taskId: string; contextId: string; sessionId: string; input: string;
  phase: "submitting" | "running" | "finished" | "unknown"; runId?: string; error?: string; requestKey?: string;
}
export class HostWorker {
  private busy = false;
  private pending: HostCall[] = [];
  private connected = false;
  private readonly observing = new Map<string, Promise<void>>();
  private readonly executingTools = new Map<string, Promise<void>>();
  private readonly pendingByRun = new Map<string, HostCall[]>();
  private readonly dependencyWaits = new Map<string, WorkDependencyWait>();
  lastError = "";
  constructor(readonly agentId: string, readonly instanceId: string, readonly store: DurableStore, readonly work: CliWork,
    readonly host: HostPort, readonly runtimeId: string, readonly instructions = "", private readonly validate: () => void = () => {},
    private readonly saveResult: (taskId: string, answer: string) => boolean = () => false, readonly tools?: HostTools, readonly communication?: CommunicationCore,
    private readonly wake?: () => void,
    private readonly options: { maxConcurrentRuns?: number; maxDependencyRuns?: number; admission?: (contextId: string, taskId: string) => HostAdmission | undefined } = {}) {
    if (!Number.isInteger(options.maxConcurrentRuns ?? 4) || (options.maxConcurrentRuns ?? 4) < 1 || (options.maxConcurrentRuns ?? 4) > 32)
      throw new Error("invalid_host_concurrency");
    if (!Number.isInteger(options.maxDependencyRuns ?? options.maxConcurrentRuns ?? 4) || (options.maxDependencyRuns ?? options.maxConcurrentRuns ?? 4) < 0 || (options.maxDependencyRuns ?? options.maxConcurrentRuns ?? 4) > 32)
      throw new Error("invalid_host_dependency_concurrency");
    const scope = digest({ agentId, instanceId, runtimeId, instructions, host: host.identity ?? "embedded",
      ...(tools ? { tools: tools.definitions, toolInstructions: tools.instructions } : {}) });
    const prior = store.get<string>("communication_host", "scope");
    if (prior && prior !== scope) throw new Error("host_binding_configuration_changed");
    store.set("communication_host", "scope", scope);
    for (const { id, value } of store.entries<RunBinding>("communication_runs")) {
      if (value.phase === "submitting") store.set("communication_runs", id, { ...value, phase: "unknown", error: "host_submission_interrupted" });
    }
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const bindings = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value);
      const uncertain = bindings.filter(binding => binding.phase === "unknown");
      const blockedContexts = new Set(uncertain.map(binding => binding.contextId));
      try { this.validate(); }
      catch (error) {
        if (this.wake && this.work.claimable(this.instanceId, true, true, blockedContexts)) this.wake();
        throw error;
      }
      if (!this.connected) { await this.host.connect(); this.connected = true; }
      for (const binding of uncertain) if (binding.requestKey && this.host.findRun && this.host.supportsRunLookup !== false && !this.observing.has(binding.claimId)) {
        this.launch(binding.claimId, async () => {
          const found = await this.host.findRun!(this.session(binding.contextId).runtimeId, binding.requestKey!);
          if (found) await this.reconcile(binding.claimId, found.id);
        });
      }
      for (const binding of bindings) {
        if (binding.phase !== "running" || this.observing.has(binding.claimId)) continue;
        const claim = this.work.inspect(binding.claimId);
        if (claim.claimId === binding.claimId) this.launch(binding.claimId, () => this.processClaim(claim));
      }
      for (let slots = this.concurrency - this.occupied().size; slots > 0; slots--) {
        const claim = this.work.claim(this.instanceId, undefined, true, true, blockedContexts);
        if (!claim?.claimId || this.observing.has(claim.claimId)) break;
        // A deferred claim retains its native session and completion authority while freeing the foreground slot.
        // CliWork still serializes every context, including these deferred claims.
        if (!claim.deferred && !claim.cancelRequested) this.work.update(claim.claimId, "defer", "", undefined, this.instanceId);
        this.launch(claim.claimId, () => this.processClaim(claim));
      }
      // A trusted dependency wait may borrow a fixed reserve. Only its explicitly
      // awaited tasks qualify; unrelated queued work never consumes this reserve.
      const waiting = this.activeDependencyWaits();
      const ceiling = Math.min(this.hardConcurrency, this.concurrency + new Set(waiting.map(wait => wait.runId)).size);
      let reserve = ceiling - this.occupied().size;
      for (const taskId of new Set(waiting.flatMap(wait => wait.taskIds))) {
        if (reserve <= 0) break;
        const claim = this.work.claim(this.instanceId, taskId, true, true, blockedContexts);
        if (!claim?.claimId || this.observing.has(claim.claimId)) continue;
        if (!claim.deferred && !claim.cancelRequested) this.work.update(claim.claimId, "defer", "", undefined, this.instanceId);
        this.launch(claim.claimId, () => this.processClaim(claim));
        reserve--;
      }
      // Complete inexpensive local work in this tick, but never wait for remote tools or a sibling's completion.
      await Promise.race([Promise.allSettled([...this.observing.values()]), new Promise<void>(resolve => setImmediate(resolve))]);
      await Promise.race([Promise.allSettled([...this.executingTools.values()]), new Promise<void>(resolve => setImmediate(resolve))]);
      // Internal work is observed through its saved task/run records, not the Matrix/channel outboxes.
      this.validate();
      for (const event of this.work.events()) if (this.store.get("work_session_inputs", event.value.id)) this.work.ack(event.id);
      if (uncertain.length && !this.lastError) this.lastError = uncertain[0]!.error ?? "host_submission_unknown";
    } catch (error) { await this.recordFailure(error); }
    finally { this.busy = false; }
  }
  private get concurrency() { return this.options.maxConcurrentRuns ?? 4; }
  private get hardConcurrency() { return this.concurrency + (this.options.maxDependencyRuns ?? this.concurrency); }
  private occupied() {
    const bindings = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value);
    // A lost response may still have started native work. Keep its reservation until
    // a trusted reconciliation or explicit owner closure confirms the outcome.
    return new Set([...this.observing.keys()]
      .concat(bindings.filter(value => value.phase === "running" || value.phase === "submitting" || value.phase === "unknown").map(value => value.claimId)));
  }
  private dependencyParent(input: WorkDependencyWait) {
    const binding = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value)
      .find(value => value.runId === input.runId && value.phase === "running");
    if (!binding) throw new WorkError("work_dependency_run_not_active", 409);
    const claim = this.work.inspect(binding.claimId);
    if (claim.claimId !== binding.claimId || claim.newInput || claim.cancelRequested) throw new WorkError("work_dependency_run_not_current", 409);
    const reference = this.store.get<HostStartInput>("work_session_inputs", binding.taskId)?.admission?.reference
      ?? this.options.admission?.(binding.contextId, binding.taskId)?.reference;
    if (reference !== input.reference || !input.callId) throw new WorkError("work_dependency_context_mismatch", 403);
    return binding;
  }
  private activeDependencyWaits() {
    for (const [id, wait] of this.dependencyWaits) {
      try { if (wait.deadlineAt <= Date.now()) throw new Error("expired"); this.dependencyParent(wait); }
      catch { this.dependencyWaits.delete(id); }
    }
    return [...this.dependencyWaits.values()];
  }
  /** Called only with server-authored tool context, never model arguments. Waiting
   * parents remain live at Host; reserve admission never exceeds the fixed ceiling. */
  dependencyWait(input: WorkDependencyWait): () => void {
    this.validate();
    const parent = this.dependencyParent(input);
    if (!input.taskIds.length || input.taskIds.length > 8 || !Number.isFinite(input.deadlineAt) || input.deadlineAt > Date.now() + 60_000)
      throw new WorkError("invalid_dependency_wait_context", 400);
    const targets = input.taskIds.map(taskId => this.work.inspect(taskId));
    const unfinished = targets.filter(task => !["completed", "failed", "canceled", "rejected"].includes(task.status));
    if (unfinished.some(task => task.contextId === parent.contextId)) throw new WorkError("work_dependency_same_session", 409);
    if (!input.reserve) return () => {};
    this.activeDependencyWaits();
    const queued = unfinished.some(task => task.status === "submitted");
    if (queued && this.occupied().size >= this.hardConcurrency) throw new WorkError("work_dependency_capacity_exhausted", 409);
    const id = key(input.runId, input.callId);
    if (this.dependencyWaits.has(id)) throw new WorkError("work_dependency_wait_in_progress", 409);
    if ([...this.dependencyWaits.values()].filter(wait => wait.runId === input.runId).length >= 8) throw new WorkError("work_dependency_capacity_exhausted", 409);
    this.dependencyWaits.set(id, input);
    return () => { if (this.dependencyWaits.get(id) === input) this.dependencyWaits.delete(id); };
  }
  private launch(id: string, operation: () => Promise<void>) {
    if (this.observing.has(id)) return;
    const pending = operation().catch(error => this.recordFailure(error)).finally(() => this.observing.delete(id));
    this.observing.set(id, pending);
  }
  private refreshPending() { this.pending = [...this.pendingByRun.values()].flat(); }
  private launchTool(call: HostCall, allowed: boolean) {
    const id = key(call.runId, call.id);
    if (this.executingTools.has(id)) return;
    const pending = this.executeTool(call, allowed).catch(error => this.recordFailure(error)).finally(() => this.executingTools.delete(id));
    this.executingTools.set(id, pending);
  }
  private async processClaim(claim: ReturnType<CliWork["inspect"]>): Promise<void> {
    if (!claim.claimId) return;
    try {
      const latest = this.work.inspect(claim.claimId);
      if (latest.claimId !== claim.claimId || latest.newInput) return;
      let binding = this.store.get<RunBinding>("communication_runs", claim.claimId);
      if (!binding) {
        if (claim.cancelRequested) { this.work.update(claim.claimId, "cancelled", "已取消。", undefined, this.instanceId); return; }
        // A revised A2A task may supersede an active turn. Stop it before using the session again.
        for (const { id, value } of this.store.entries<RunBinding>("communication_runs")) {
          if (value.contextId !== claim.contextId || value.phase !== "running" || !value.runId) continue;
          await this.host.cancel(value.runId);
          if ((await this.host.get(value.runId)).status === "running") return;
          this.store.set("communication_runs", id, { ...value, phase: "finished" });
        }
        let attachments = undefined as import("../communication/types.js").MediaContent[] | undefined;
        try { attachments = await this.communication?.attachments(claim.id); }
        catch (error) { this.work.update(claim.claimId, "fail", `附件读取失败：${error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "attachment_read_failed"}。请重新发送或检查渠道权限。`, undefined, this.instanceId); return; }
        const authored = this.store.get<HostStartInput>("work_session_inputs", claim.id);
        const input = Message.fromJSON(claim.input).parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n");
        if (!input.trim() && !authored?.inputItems?.length && authored?.mode !== "compact") { this.work.update(claim.claimId, "fail", "此执行入口目前需要文字输入。", undefined, this.instanceId); return; }
        const blocked = this.store.entries<RunBinding>("communication_runs").some(({ value }) => value.contextId === claim.contextId && value.phase === "unknown");
        if (blocked) { this.work.update(claim.claimId, "fail", "上一轮执行结果尚未确认，请先检查运行状态。", undefined, this.instanceId); return; }
        const { sessionId, runtimeId } = this.session(claim.contextId);
        binding = { claimId: claim.claimId, taskId: claim.id, contextId: claim.contextId, sessionId, input, phase: "submitting", requestKey: `router-${digest(key(this.agentId, claim.claimId))}` };
        this.store.set("communication_runs", claim.claimId, binding);
        let submissionAttempted = false;
        try {
          const savedSession = this.session(claim.contextId);
          const channelAllowed = this.tools?.allowed(claim.contextId, claim.id) === true;
          // Only trusted internally admitted work may reuse a catalog without a new channel message.
          // A forged external context ID must never inherit its owner's tool definitions.
          const withTools = savedSession.tools !== false && (authored ? savedSession.channelTools ?? channelAllowed : channelAllowed);
          if (savedSession.tools !== false && savedSession.channelTools === undefined && (channelAllowed || authored))
            this.store.set("execution_sessions", claim.contextId, { ...savedSession, channelTools: withTools });
          const admission = authored?.admission ?? this.options.admission?.(claim.contextId, claim.id);
          const delivered = admission && admission.kind !== "owner" && authored?.mode !== "compact"
            ? await this.deliveryInput(runtimeId, input, admission, authored?.inputItems) : undefined;
          submissionAttempted = true;
          const started = await this.host.start({ sessionId, runtimeId,
            instructions: this.instructions + (withTools ? this.tools!.instructions : ""), input: delivered ? "" : input,
            requestKey: binding.requestKey!,
            ...(delivered ? { toolOutput: delivered } : authored?.inputItems ? { inputItems: authored.inputItems } : {}),
            ...(authored?.settings ? { settings: authored.settings } : {}),
            ...(authored?.mode ? { mode: authored.mode } : {}),
            ...(admission ? { admission } : {}),
            ...(attachments?.length ? { attachments } : {}),
            ...(withTools ? { tools: this.tools!.definitions } : {}),
            context: { ...(authored?.context && typeof authored.context === "object" ? authored.context : { data: authored?.context }), agentId: this.agentId, conversationId: claim.contextId, source: authored?.admission ?? { kind: "channel", sender: claim.from } } });
          if (started.sessionId !== sessionId || started.runtimeId !== runtimeId) throw new Error("host_run_scope_mismatch");
          binding = { ...binding, phase: "running", runId: started.id };
          this.store.set("communication_runs", claim.claimId, binding);
        } catch (error) {
          const rejected = !submissionAttempted || (error instanceof ChannelHttpError || error instanceof WorkError) && [400, 401, 403, 404, 409, 413, 422].includes(error.status);
          const preparationError = !submissionAttempted && error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : undefined;
          binding = { ...binding, phase: rejected ? "finished" : "unknown", error: preparationError ?? (rejected ? "host_submission_rejected" : "host_submission_unknown") };
          this.store.set("communication_runs", claim.claimId, binding);
          this.work.update(claim.claimId, rejected ? "fail" : "progress", rejected ? "执行服务未接受本轮请求，请检查配置与运行状态。" : "本轮是否已经执行暂时无法确认，系统不会自动重复执行。", undefined, this.instanceId);
          return;
        }
      }
      if (binding.phase === "finished") {
        // Recover a crash between persisting a known rejection and closing the work claim.
        this.work.update(claim.claimId, claim.cancelRequested ? "cancelled" : "fail", "执行服务未接受本轮请求，请检查配置与运行状态。", undefined, this.instanceId);
        return;
      }
      if (binding.phase === "unknown") {
        this.lastError = binding.error ?? "host_submission_unknown"; return;
      }
      if (!binding.runId) return;
      if (claim.cancelRequested) await this.host.cancel(binding.runId);
      const result = await this.host.get(binding.runId);
      if (result.sessionId !== binding.sessionId || result.runtimeId !== this.session(binding.contextId).runtimeId) throw new Error("host_run_scope_mismatch");
      this.store.set("execution_results", binding.taskId, result);
      try { await this.observe(binding, result.answer); } catch { this.lastError = "channel_progress_failed"; }
      if (result.status === "running") {
        const calls = (await this.host.calls(binding.runId)).filter((call) => call.status === "pending" && call.runId === binding!.runId);
        this.pendingByRun.set(binding.runId, calls); this.refreshPending();
        const current = this.work.inspect(binding.claimId);
        if (current.claimId !== binding.claimId || current.newInput) return;
        if (!current.cancelRequested && this.tools) {
          for (const call of calls) if (call.kind === "tool" && this.tools.definitions.some((definition) => definition.name === call.name && definition.namespace === call.namespace))
            this.launchTool(call, this.tools.allowed(binding.contextId, binding.taskId));
        }
        if (this.communication) for (const call of calls) if (call.kind === "interaction") this.present(binding, call);
        return;
      }
      for (const { id, value } of this.store.entries<any>("communication_questions")) if (value.call.runId === binding.runId) this.store.set("communication_questions", id, { ...value, closed: true });
      this.pendingByRun.delete(binding.runId); this.refreshPending();
      this.validate();
      const current = this.work.inspect(claim.claimId);
      if (current.newInput) return; // Reclaim the new revision on the next tick.
      if (result.outcome?.outcomeUnknown) {
        this.store.set("communication_runs", claim.claimId, { ...binding, phase: "unknown", error: "host_outcome_unknown" });
        this.work.update(claim.claimId, "progress", "执行中断，结果尚未确认，系统不会自动重复执行。", undefined, this.instanceId); return;
      }
      if (current.cancelRequested) this.work.update(claim.claimId, "cancelled", "已取消。", undefined, this.instanceId);
      else if (result.status === "completed") {
        const saved = this.saveResult(claim.id, result.answer) || Boolean(this.store.get("work_session_inputs", claim.id));
        if (Buffer.byteLength(result.answer) > 28_000 && !saved) this.work.update(claim.claimId, "fail", "回复超过 A2A 的消息长度限制；完整结果仍保存在执行服务。", undefined, this.instanceId);
        else this.work.update(claim.claimId, "reply", Buffer.byteLength(result.answer) > 28_000 ? "完整回复已保存。" : result.answer || "已完成。", undefined, this.instanceId);
      } else this.work.update(claim.claimId, "fail", result.outcome?.outcomeUnknown ? "执行中断，结果尚未确认。" : "本轮执行未完成，请查看运行状态。", undefined, this.instanceId);
      this.store.set("communication_runs", claim.claimId, { ...binding, phase: result.outcome?.outcomeUnknown ? "unknown" : "finished" });
      // Keep a compact copy while the Host is awake; history reads must not need to wake it.
      if (!result.outcome?.outcomeUnknown) void archiveRun(this.store, this.host, claim.claimId, binding.runId).catch(() => {});
      this.lastError = "";
    } catch (error) { await this.recordFailure(error); }
  }
  private async deliveryInput(runtimeId: string, input: string, admission: HostAdmission, items?: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    let skills: Array<{ name: string; path: string }> | undefined;
    if (items?.length) {
      if (items.some(item => item.type !== "skill" || typeof item.name !== "string" || typeof item.path !== "string"))
        throw new WorkError("native_tool_delivery_typed_input_unsupported", 422);
      if (!this.host.nativeRequest) throw new WorkError("host_skill_discovery_unsupported", 409);
      const cwd = await runtimeWorkingDirectory(this.host, runtimeId);
      const result = await this.host.nativeRequest(runtimeId, "skills/list", { forceReload: true, cwds: [cwd] }) as { data?: Array<{ skills?: Array<{ name?: string; path?: string; enabled?: boolean }> }> };
      const discovered = result?.data?.flatMap(row => row.skills ?? []) ?? [];
      skills = items.map(item => {
        if (!discovered.some(skill => skill.path === item.path && skill.name === item.name && skill.enabled !== false))
          throw new WorkError("skill_not_in_runtime_catalog", 403);
        return { name: item.name as string, path: item.path as string };
      });
    }
    // Native tool output is deliberately distinct from a human user message. Native Codex
    // cannot combine it with typed skill input; verified skill references remain evidence
    // for on-demand loading, not a claim that native explicit skill injection occurred.
    return { namespace: "mau", name: admission.kind === "schedule" ? "proactive_work" : "work_sessions", retain: false,
      output: JSON.stringify({ source: { kind: admission.kind, reference: admission.reference }, message: input,
        ...(skills ? { skills, skillLoading: "verified_references" } : {}) }) };
  }
  private async recordFailure(error: unknown) {
      this.lastError = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "host_observation_failed";
      if (error instanceof WorkError && error.status === 401 && error.message === "instance_unauthorized") {
        // Revocation cancels already known runs; losing the store lease must never cancel a new owner's run.
        for (const { id, value } of this.store.entries<RunBinding>("communication_runs")) {
          if (value.phase !== "running" || !value.runId) continue;
          try {
            if ((await this.host.get(value.runId)).status === "running") await this.host.cancel(value.runId);
            if ((await this.host.get(value.runId)).status === "running") continue;
            const current = this.work.inspect(value.claimId);
            if (current.claimId === value.claimId && current.cancelRequested) this.work.update(value.claimId, "cancelled", "已取消。", undefined, this.instanceId);
            this.store.set("communication_runs", id, { ...value, phase: "finished", error: "instance_revoked" });
          } catch { /* The next tick retries observation/cancellation, never submission. */ }
        }
      }
  }
  private session(contextId: string): ExecutionSession {
    const existing = this.store.get<ExecutionSession>("execution_sessions", contextId);
    if (existing) {
      if (!existing.sessionId || !existing.runtimeId || (existing.tools !== undefined && existing.tools !== false)) throw new Error("invalid_execution_session");
      return existing;
    }
    const session = { sessionId: `h-${digest(key(this.agentId, this.instanceId, contextId)).slice(0, 40)}`, runtimeId: this.runtimeId };
    this.store.set("execution_sessions", contextId, session);
    return session;
  }
  private async observe(binding: RunBinding, fallback: string) {
    if (!this.communication || !binding.runId) return;
    const prior = this.store.get<{ cursor: number; text: string }>("communication_run_events", binding.runId) ?? { cursor: 0, text: "" };
    let { cursor, text } = prior;
    if (this.host.events) {
      let pages = 0;
      for (;;) {
        const page = await this.host.events(binding.runId, cursor);
        if (page.historyTruncated) text = fallback;
        for (const { event } of page.events) {
          if (event.type === "assistant.delta" && !page.historyTruncated) text += String(event.text ?? "");
          if (event.type === "model.response") text = String(event.text ?? "");
        }
        cursor = page.cursor;
        if (!page.hasMore || ++pages >= 10) break;
      }
    } else if (fallback) text = fallback;
    if (text && text !== prior.text) await this.communication.progress(binding.taskId, text);
    this.store.set("communication_run_events", binding.runId, { cursor, text });
  }
  private present(binding: RunBinding, call: HostCall) {
    const core = this.communication!, input = core.input(binding.taskId); if (!input) return;
    if (this.store.get("communication_questions", call.id)) return;
    const view = interaction(call);
    const buttons = view.choices.map((choice, index) => {
      const token = digest(key(call.id, String(index))).slice(0, 32);
      this.store.set("communication_actions", token, { callId: call.id, result: choice.result });
      return { label: choice.label, token };
    });
    const nativeButtons = core.capabilities(binding.taskId)?.buttons;
    const choices = buttons.length && !nativeButtons ? "\n" + buttons.map((button, index) => `${index + 1}. ${button.label}`).join("\n") : "";
    const instructions = view.sensitive ? "" : buttons.length ? nativeButtons ? "\n可点击选项，或直接回复选项名称/编号。" : "\n请回复选项名称或编号。" : "\n请直接回复答案；多个问题请用 JSON 按问题填写。";
    const text = view.text + choices + instructions;
    const noticeId = core.notice(input, text, `question:${call.id}`, { text, ...(nativeButtons ? { buttons } : {}) });
    this.store.set("communication_questions", call.id, { call, taskId: binding.taskId, conversationId: binding.contextId, source: input.source, connectionId: input.connectionId, noticeId, closed: false });
  }
  async handleInput(input: InboxRecord): Promise<boolean> {
    const core = this.communication; if (!core) return false;
    const text = input.source.text.trim();
    const receipt = this.store.get<{ runId: string; callId: string; result: unknown; complete: boolean }>("communication_control_receipts", input.id);
    if (receipt) {
      if (!receipt.complete) { await this.host.resolve(receipt.runId, receipt.callId, receipt.result); this.store.set("communication_control_receipts", input.id, { ...receipt, complete: true }); }
      const question = this.store.get<any>("communication_questions", receipt.callId);
      if (question) this.store.set("communication_questions", receipt.callId, { ...question, closed: true });
      core.notice(input, "已收到回答，继续执行。", "answer");
      return true;
    }
    const active = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value).reverse().find((item) => item.contextId === input.conversationId && item.phase === "running");
    if (/^(\/(?:cancel|stop)(?:@\w+)?|停止|停一下|取消|取消当前任务)$/i.test(text)) {
      const task = active?.taskId ?? this.work.list().find((item) => item.contextId === input.conversationId)?.id;
      const original = task ? core.input(task) : undefined;
      if (original && original.source.sender !== input.source.sender && !(core.isOwnerInput(input) && core.isOwnerInput(original))) { core.notice(input, "这轮任务属于另一位发送者。", "control-scope"); return true; }
      if (task) await this.work.cancel(task);
      core.notice(input, task ? "正在停止当前任务。" : "当前没有正在执行的任务。", "cancel"); return true;
    }
    if (/^\/steer\s+/i.test(text)) {
      const original = active ? core.input(active.taskId) : undefined;
      if (original && original.source.sender !== input.source.sender && !(core.isOwnerInput(input) && core.isOwnerInput(original))) { core.notice(input, "这轮任务属于另一位发送者。", "control-scope"); return true; }
      if (!active?.runId || !this.host.steer) core.notice(input, "当前运行无法接收即时补充。", "steer-unavailable");
      else { try { await this.host.steer(active.runId, text.replace(/^\/steer\s+/i, "")); core.notice(input, "补充内容已交给当前运行。", "steer"); } catch { core.notice(input, "所选执行内核不支持即时补充；请停止后继续对话。", "steer-unavailable"); } }
      return true;
    }
    let action: { callId: string; result: unknown } | undefined;
    if (input.source.action) action = this.store.get("communication_actions", input.source.action.token);
    const candidates = this.store.entries<any>("communication_questions").map(({ value }) => value).filter((item) =>
      !item.closed && item.conversationId === input.conversationId && (item.connectionId === input.connectionId && item.source.sender === input.source.sender || core.isOwnerInput(input) && core.isOwnerTask(item.conversationId, item.taskId)) &&
      (!input.source.quoted?.messageId || this.store.get<any>("communication_outbox", item.noticeId)?.externalId?.split(",").includes(input.source.quoted.messageId)) &&
      (!action || item.call.id === action.callId) && Date.parse(item.call.deadlineAt) > Date.now());
    if (!candidates.length) return false;
    if (candidates.length !== 1) { core.notice(input, "有多个问题等待回答，请点击对应问题的选项。", "ambiguous-question"); return true; }
    const question = candidates[0], call: HostCall = question.call;
    if (!active?.runId || active.runId !== call.runId) return false;
    const live = (await this.host.calls(call.runId)).find((item) => item.id === call.id && item.status === "pending");
    if (!live) { this.store.set("communication_questions", call.id, { ...question, closed: true }); return Boolean(input.source.action); }
    if (interaction(call).sensitive) { core.notice(input, "请在 Host 原生交互入口完成敏感输入。", "native-sensitive-input"); return true; }
    let result;
    try { result = action ? action.result : interaction(call).answer(text.replace(/^\/answer\s+/i, "")); }
    catch { core.notice(input, "答案格式不正确，请根据问题中的选项或填写说明重试。", "invalid-answer"); return true; }
    const planned = { runId: call.runId, callId: call.id, result, complete: false };
    this.store.set("communication_control_receipts", input.id, planned);
    await this.host.resolve(call.runId, call.id, result);
    this.store.set("communication_control_receipts", input.id, { ...planned, complete: true });
    this.store.set("communication_questions", call.id, { ...question, closed: true });
    core.notice(input, "已收到回答，继续执行。", "answer"); return true;
  }
  status() { return { instanceId: this.instanceId, runtimeId: this.runtimeId, error: this.lastError || null,
    runs: this.store.entries<RunBinding>("communication_runs").slice(-100).map(({ value }) => ({ claimId: value.claimId, taskId: value.taskId,
      conversationId: value.contextId, sessionId: value.sessionId, runId: value.runId ?? null, phase: value.phase, error: value.error ?? null })),
    calls: this.pending,
    tools: this.store.entries<ToolReceipt>("communication_tools").slice(-100).map(({ id, value }) => ({ id, phase: value.phase })) }; }
  private async executeTool(call: HostCall, allowed: boolean): Promise<void> {
    this.validate();
    if (!(Date.parse(call.deadlineAt) > Date.now())) return;
    const id = key(call.runId, call.id), hash = digest({ name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}), input: call.input });
    let receipt = this.store.get<ToolReceipt>("communication_tools", id);
    if (receipt && receipt.hash !== hash) throw new Error("host_tool_call_payload_changed");
    if (!receipt) {
      this.store.set("communication_tools", id, { hash, phase: "executing" } satisfies ToolReceipt);
      try {
        const result = allowed ? await this.tools!.execute(call) : { success: false, contentItems: [{ type: "inputText" as const, text: "channel_tool_not_authorized_for_this_task" }] };
        receipt = { hash, phase: "completed", result };
      } catch (error) {
        const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "tool_execution_unknown";
        receipt = { hash, phase: "uncertain", result: { success: false, contentItems: [{ type: "inputText",
          text: `${code}: Operation may have run. Inspect its outcome before attempting another write.` }] } };
      }
      this.store.set("communication_tools", id, receipt);
    } else if (receipt.phase === "executing") {
      // A process crash cannot prove that a CLI write did not reach Feishu. Never replay it.
      receipt = { hash, phase: "uncertain", result: { success: false, contentItems: [{ type: "inputText",
        text: "tool_execution_interrupted: Operation outcome is unknown. Inspect it before another write." }] } };
      this.store.set("communication_tools", id, receipt);
    }
    this.validate();
    if (receipt.result) await this.host.resolve(call.runId, call.id, receipt.result);
  }
  async resolve(callId: string, result: unknown): Promise<void> {
    this.validate();
    const call = this.pending.find((item) => item.id === callId);
    if (!call) throw new WorkError("pending_call_not_found", 404);
    const binding = this.store.entries<RunBinding>("communication_runs").find(({ value }) => value.runId === call.runId && value.phase === "running")?.value;
    if (!binding) throw new WorkError("call_run_not_active");
    await this.host.resolve(call.runId, call.id, result);
  }
  /** Owner explicitly associates a lost submission with an observed Host run; no model rerun. */
  async reconcile(claimId: string, runId: string): Promise<void> {
    this.validate();
    const binding = this.store.get<RunBinding>("communication_runs", claimId);
    if (!binding || binding.phase !== "unknown") throw new WorkError("unknown_run_not_found", 404);
    const current = this.work.inspect(claimId);
    if (current.claimId !== claimId || current.newInput) throw new WorkError("claim_not_current");
    const result = await this.host.get(runId);
    if (result.sessionId !== binding.sessionId || result.runtimeId !== this.session(binding.contextId).runtimeId || result.outcome?.outcomeUnknown) throw new WorkError("host_run_not_reconcilable");
    this.store.set("communication_runs", claimId, { ...binding, phase: "running", runId });
  }
  /** Close a stopped, uncertain turn after owner inspection. This never submits another run. */
  async closeUnknown(claimId: string): Promise<void> {
    this.validate();
    const binding = this.store.get<RunBinding>("communication_runs", claimId);
    if (!binding || binding.phase !== "unknown") throw new WorkError("unknown_run_not_found", 404);
    if (binding.runId && (await this.host.get(binding.runId)).status === "running") throw new WorkError("host_run_still_running");
    const current = this.work.inspect(claimId);
    if (current.claimId !== claimId || current.newInput) throw new WorkError("claim_not_current");
    this.store.set("communication_runs", claimId, { ...binding, phase: "finished", error: "unknown_run_closed_by_owner" });
    this.work.update(claimId, current.cancelRequested ? "cancelled" : "fail", "本轮执行已结束；未确认的结果需要人工检查。", undefined, this.instanceId);
  }
}
