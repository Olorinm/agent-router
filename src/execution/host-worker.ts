import { interaction } from "../communication/interaction.js";
import type { CommunicationCore, InboxRecord } from "../communication/core.js";
import { Message } from "@a2a-js/sdk";
import { ChannelHttpError } from "../channels/http.js";
import { DurableStore } from "../communication/store.js";
import { digest, key } from "./protocol.js";
import { CliWork, WorkError } from "./work.js";
import type { HostCall, HostPort } from "./host.js";
import type { HostTools, HostToolResult } from "./tools.js";

interface ToolReceipt { hash: string; phase: "executing" | "completed" | "uncertain"; result?: HostToolResult; }

export interface ExecutionSession { sessionId: string; runtimeId: string; tools?: false; }

export interface RunBinding {
  claimId: string; taskId: string; contextId: string; sessionId: string; input: string;
  phase: "submitting" | "running" | "finished" | "unknown"; runId?: string; error?: string;
}
export class HostWorker {
  private busy = false;
  private pending: HostCall[] = [];
  private connected = false;
  lastError = "";
  constructor(readonly agentId: string, readonly instanceId: string, readonly store: DurableStore, readonly work: CliWork,
    readonly host: HostPort, readonly runtimeId: string, readonly instructions = "", private readonly validate: () => void = () => {},
    private readonly saveResult: (taskId: string, answer: string) => boolean = () => false, readonly tools?: HostTools, readonly communication?: CommunicationCore,
    private readonly wake?: () => void) {
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
      // Preserve uncertain claims for owner reconciliation without blocking unrelated conversations.
      const uncertain = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value)
        .filter((binding) => binding.phase === "unknown");
      const blockedContexts = new Set(uncertain.map((binding) => binding.contextId));
      try { this.validate(); }
      catch (error) {
        // Only deliverable work may wake an unavailable Host; idle ticks never do.
        if (this.wake && this.work.claimable(this.instanceId, true, true, blockedContexts)) this.wake();
        throw error;
      }
      if (!this.connected) { await this.host.connect(); this.connected = true; }
      const claim = this.work.claim(this.instanceId, undefined, true, true, blockedContexts);
      if (!claim?.claimId) {
        if (uncertain.length) this.lastError = uncertain[0]!.error ?? "host_submission_unknown";
        return;
      }
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
        const input = Message.fromJSON(claim.input).parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n");
        if (!input.trim()) { this.work.update(claim.claimId, "fail", "此执行入口目前需要文字输入。", undefined, this.instanceId); return; }
        const blocked = this.store.entries<RunBinding>("communication_runs").some(({ value }) => value.contextId === claim.contextId && value.phase === "unknown");
        if (blocked) { this.work.update(claim.claimId, "fail", "上一轮执行结果尚未确认，请先检查运行状态。", undefined, this.instanceId); return; }
        const { sessionId, runtimeId } = this.session(claim.contextId);
        binding = { claimId: claim.claimId, taskId: claim.id, contextId: claim.contextId, sessionId, input, phase: "submitting" };
        this.store.set("communication_runs", claim.claimId, binding);
        try {
          const withTools = this.session(claim.contextId).tools !== false && this.tools?.allowed(claim.contextId, claim.id) === true;
          const started = await this.host.start({ sessionId, runtimeId,
            instructions: this.instructions + (withTools ? this.tools!.instructions : ""), input,
            ...(attachments?.length ? { attachments } : {}),
            ...(withTools ? { tools: this.tools!.definitions } : {}),
            context: { agentId: this.agentId, conversationId: claim.contextId, source: claim.from } });
          if (started.sessionId !== sessionId || started.runtimeId !== runtimeId) throw new Error("host_run_scope_mismatch");
          binding = { ...binding, phase: "running", runId: started.id };
          this.store.set("communication_runs", claim.claimId, binding);
        } catch (error) {
          const rejected = error instanceof ChannelHttpError && [400, 401, 403, 404, 409, 413, 422].includes(error.status);
          binding = { ...binding, phase: rejected ? "finished" : "unknown", error: rejected ? "host_submission_rejected" : "host_submission_unknown" };
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
      try { await this.observe(binding, result.answer); } catch { this.lastError = "channel_progress_failed"; }
      if (result.status === "running") {
        this.pending = (await this.host.calls(binding.runId)).filter((call) => call.status === "pending");
        if (!claim.cancelRequested && this.tools?.allowed(binding.contextId, binding.taskId)) {
          for (const call of this.pending) if (call.kind === "tool" && this.tools.definitions.some((definition) => definition.name === call.name))
            await this.executeTool(call);
        }
        if (this.communication) for (const call of this.pending) if (call.kind === "interaction") this.present(binding, call);
        return;
      }
      for (const { id, value } of this.store.entries<any>("communication_questions")) if (value.call.runId === binding.runId) this.store.set("communication_questions", id, { ...value, closed: true });
      this.pending = [];
      this.validate();
      const current = this.work.inspect(claim.claimId);
      if (current.newInput) return; // Reclaim the new revision on the next tick.
      if (result.outcome?.outcomeUnknown) {
        this.store.set("communication_runs", claim.claimId, { ...binding, phase: "unknown", error: "host_outcome_unknown" });
        this.work.update(claim.claimId, "progress", "执行中断，结果尚未确认，系统不会自动重复执行。", undefined, this.instanceId); return;
      }
      if (current.cancelRequested) this.work.update(claim.claimId, "cancelled", "已取消。", undefined, this.instanceId);
      else if (result.status === "completed") {
        const saved = this.saveResult(claim.id, result.answer);
        if (Buffer.byteLength(result.answer) > 28_000 && !saved) this.work.update(claim.claimId, "fail", "回复超过 A2A 的消息长度限制；完整结果仍保存在执行服务。", undefined, this.instanceId);
        else this.work.update(claim.claimId, "reply", Buffer.byteLength(result.answer) > 28_000 ? "完整回复已保存。" : result.answer || "已完成。", undefined, this.instanceId);
      } else this.work.update(claim.claimId, "fail", result.outcome?.outcomeUnknown ? "执行中断，结果尚未确认。" : "本轮执行未完成，请查看运行状态。", undefined, this.instanceId);
      this.store.set("communication_runs", claim.claimId, { ...binding, phase: result.outcome?.outcomeUnknown ? "unknown" : "finished" });
      this.lastError = "";
    } catch (error) {
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
    finally { this.busy = false; }
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
  private async executeTool(call: HostCall): Promise<void> {
    this.validate();
    if (!(Date.parse(call.deadlineAt) > Date.now())) return;
    const id = key(call.runId, call.id), hash = digest({ name: call.name, input: call.input });
    let receipt = this.store.get<ToolReceipt>("communication_tools", id);
    if (receipt && receipt.hash !== hash) throw new Error("host_tool_call_payload_changed");
    if (!receipt) {
      this.store.set("communication_tools", id, { hash, phase: "executing" } satisfies ToolReceipt);
      try {
        const result = await this.tools!.execute(call);
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
