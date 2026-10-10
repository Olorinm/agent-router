import { Message } from "@a2a-js/sdk";
import { ChannelHttpError } from "../channels/http.js";
import { DurableStore } from "../communication/store.js";
import { digest, key } from "./protocol.js";
import { CliWork, WorkError } from "./work.js";
import type { HostCall, HostPort } from "./host.js";
import type { HostTools, HostToolResult } from "./tools.js";

interface ToolReceipt { hash: string; phase: "executing" | "completed" | "uncertain"; result?: HostToolResult; }

interface RunBinding {
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
    private readonly saveResult: (taskId: string, answer: string) => boolean = () => false, readonly tools?: HostTools) {
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
      this.validate();
      if (!this.connected) { await this.host.connect(); this.connected = true; }
      const claim = this.work.claim(this.instanceId, undefined, true, true);
      if (!claim?.claimId) return;
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
        const input = Message.fromJSON(claim.input).parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n");
        if (!input.trim()) { this.work.update(claim.claimId, "fail", "此执行入口目前需要文字输入。", undefined, this.instanceId); return; }
        const blocked = this.store.entries<RunBinding>("communication_runs").some(({ value }) => value.contextId === claim.contextId && value.phase === "unknown");
        if (blocked) { this.work.update(claim.claimId, "fail", "上一轮执行结果尚未确认，请先检查运行状态。", undefined, this.instanceId); return; }
        const sessionId = `h-${digest(key(this.agentId, this.instanceId, claim.contextId)).slice(0, 40)}`;
        binding = { claimId: claim.claimId, taskId: claim.id, contextId: claim.contextId, sessionId, input, phase: "submitting" };
        this.store.set("communication_runs", claim.claimId, binding);
        try {
          const withTools = this.tools?.allowed(claim.contextId, claim.id) === true;
          const started = await this.host.start({ sessionId, runtimeId: this.runtimeId,
            instructions: this.instructions + (withTools ? this.tools!.instructions : ""), input,
            ...(withTools ? { tools: this.tools!.definitions } : {}),
            context: { agentId: this.agentId, conversationId: claim.contextId, source: claim.from } });
          if (started.sessionId !== sessionId || started.runtimeId !== this.runtimeId) throw new Error("host_run_scope_mismatch");
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
      if (result.sessionId !== binding.sessionId || result.runtimeId !== this.runtimeId) throw new Error("host_run_scope_mismatch");
      if (result.status === "running") {
        this.pending = (await this.host.calls(binding.runId)).filter((call) => call.status === "pending");
        if (!claim.cancelRequested && this.tools?.allowed(binding.contextId, binding.taskId)) {
          for (const call of this.pending) if (call.kind === "tool" && this.tools.definitions.some((definition) => definition.name === call.name))
            await this.executeTool(call);
        }
        return;
      }
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
    if (result.sessionId !== binding.sessionId || result.runtimeId !== this.runtimeId || result.outcome?.outcomeUnknown) throw new WorkError("host_run_not_reconcilable");
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
