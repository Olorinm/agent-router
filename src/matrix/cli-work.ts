import { randomUUID } from "node:crypto";
import { Artifact, Message, Task, TaskState, type SendMessageRequest } from "@a2a-js/sdk";
import type { ExecutionBackend, ExecutionSource } from "./backend.js";
import { ConnectorStore } from "./store.js";
import { digest, encodeResult, newTask, sized, statusMessage, terminal } from "./protocol.js";

interface Claim { id: string; worker: string; revision: number; }
interface Work { task: Task; input: Message; source: ExecutionSource; revision: number; claim?: Claim; cancelRequested?: boolean; }
interface Receipt { workId: string; revision: number; actions: Record<string, unknown>; }
type Policy = "allow" | "ask" | "deny";
export type WorkAction = "progress" | "reply" | "need-input" | "fail" | "cancelled";
export class WorkError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/** The default execution adapter is a durable CLI inbox, with no additional HTTP agent service. */
export class CliWork implements ExecutionBackend {
  constructor(readonly store: ConnectorStore, private readonly policy: (sender: string) => Policy) {}
  private load(id: string): Work {
    const work = this.store.get<Work>("cli_work", id);
    if (!work) throw new WorkError("work_not_found", 404);
    return work;
  }
  private allowed(work: Work): boolean {
    const policy = this.policy(work.source.sender);
    return policy !== "deny" && (work.source.approved || policy === "allow");
  }
  async send(request: SendMessageRequest, source?: ExecutionSource): Promise<Task> {
    if (!source || !request.message) throw new WorkError("work_source_required");
    const message = structuredClone(request.message);
    return this.store.transaction(() => {
      const prior = this.store.get<{ hash: string; id: string }>("cli_message_ids", message.messageId);
      const hash = digest({ request, source });
      if (prior) {
        if (prior.hash !== hash) throw new WorkError("work_message_id_reused");
        return this.load(prior.id).task;
      }
      let work: Work;
      if (message.taskId) {
        work = this.load(message.taskId);
        if (work.source.sender !== source.sender || work.source.room !== source.room ||
          (message.contextId && message.contextId !== work.task.contextId)) throw new WorkError("work_scope_mismatch");
        if (terminal(work.task) || work.cancelRequested) throw new WorkError("work_closed");
        work.task.history.push(message); work.input = message; work.revision++;
        if (!work.claim) work.task.status = { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined };
      } else {
        work = { task: newTask(randomUUID(), message.contextId || randomUUID(), message), input: message, source, revision: 1 };
      }
      this.fit(work.task);
      this.store.set("cli_work", work.task.id, work);
      this.store.set("cli_message_ids", message.messageId, { id: work.task.id, hash });
      return work.task;
    });
  }
  async get(id: string): Promise<Task> { return this.load(id).task; }
  list(all = false) {
    return this.store.entries<Work>("cli_work").map((r) => r.value)
      .filter((w) => all || !terminal(w.task)).map((w) => this.view(w));
  }
  inspect(id: string) {
    const receipt = this.store.get<Receipt>("cli_claims", id);
    return this.view(this.load(receipt?.workId ?? id));
  }
  has(id: string): boolean { return Boolean(this.store.get("cli_work", id)); }
  approve(id: string): void {
    this.store.transaction(() => {
      const work = this.load(id);
      if (terminal(work.task) || this.policy(work.source.sender) === "deny") throw new WorkError("work_not_approvable");
      work.source.approved = true; this.store.set("cli_work", id, work);
    });
  }
  reject(id: string): void {
    this.store.transaction(() => {
      const work = this.load(id);
      if (terminal(work.task) || work.claim) throw new WorkError("work_not_rejectable");
      this.change(work, TaskState.TASK_STATE_REJECTED, "Request rejected.");
    });
  }
  claim(worker: string, id?: string) {
    return this.store.transaction(() => {
      const rows = this.store.entries<Work>("cli_work").map((r) => r.value);
      // Retrying a lost claim response with the same worker returns the existing assignment.
      const owned = rows.find((w) => w.claim?.worker === worker && !terminal(w.task));
      if (owned && id && id !== owned.task.id) throw new WorkError("worker_already_has_work");
      const work = owned ?? rows.find((w) => (!id || w.task.id === id) && !w.claim &&
        w.task.status?.state === TaskState.TASK_STATE_SUBMITTED && this.allowed(w) &&
        !rows.some((other) => other.claim && !terminal(other.task) && other.task.contextId === w.task.contextId));
      if (!work) return null;
      if (work.claim?.revision !== work.revision) {
        work.claim = { id: randomUUID(), worker, revision: work.revision };
        this.store.set("cli_claims", work.claim.id, { workId: work.task.id, revision: work.revision, actions: {} } satisfies Receipt);
        this.change(work, TaskState.TASK_STATE_WORKING);
      }
      return this.view(work);
    });
  }
  update(claimId: string, action: WorkAction, text: string, data?: Record<string, unknown>) {
    return this.store.transaction(() => {
      const receipt = this.store.get<Receipt>("cli_claims", claimId);
      if (!receipt) throw new WorkError("claim_not_found", 404);
      const actionId = digest({ action, text, data });
      if (Object.hasOwn(receipt.actions, actionId)) return receipt.actions[actionId];
      const work = this.load(receipt.workId);
      if (work.claim?.id !== claimId || terminal(work.task)) throw new WorkError("claim_closed");
      if (work.revision !== receipt.revision && action !== "cancelled") throw new WorkError("new_input_available_claim_again");
      if ((work.cancelRequested || this.policy(work.source.sender) === "deny") && action !== "cancelled") {
        throw new WorkError("cancellation_requested_stop_and_acknowledge");
      }
      if (action === "cancelled" && !work.cancelRequested) throw new WorkError("cancellation_not_requested");
      const state = { progress: TaskState.TASK_STATE_WORKING, reply: TaskState.TASK_STATE_COMPLETED,
        "need-input": TaskState.TASK_STATE_INPUT_REQUIRED, fail: TaskState.TASK_STATE_FAILED, cancelled: TaskState.TASK_STATE_CANCELED }[action];
      if (action === "reply") {
        work.task.artifacts = [Artifact.fromJSON({ artifactId: digest(claimId), name: "result",
          parts: [...(text ? [{ text }] : []), ...(data ? [{ data }] : [])] })];
      }
      if (action !== "progress") delete work.claim;
      this.change(work, state, action === "reply" ? "Completed." : text);
      const result = this.view(work);
      receipt.actions[actionId] = result; this.store.set("cli_claims", claimId, receipt);
      return result;
    });
  }
  async cancel(id: string): Promise<Task> {
    return this.store.transaction(() => {
      const work = this.load(id);
      if (terminal(work.task) || work.cancelRequested) return work.task;
      work.cancelRequested = true;
      this.change(work, work.claim ? TaskState.TASK_STATE_WORKING : TaskState.TASK_STATE_CANCELED,
        work.claim ? "Cancellation requested; waiting for the worker to stop and acknowledge." : "Canceled before execution.");
      return work.task;
    });
  }
  reconcile(): void {
    this.store.transaction(() => {
      for (const { value: work } of this.store.entries<Work>("cli_work")) {
        if (terminal(work.task) || work.cancelRequested || this.policy(work.source.sender) !== "deny") continue;
        if (work.claim) work.cancelRequested = true;
        this.change(work, work.claim ? TaskState.TASK_STATE_WORKING : TaskState.TASK_STATE_REJECTED,
          work.claim ? "Sender blocked; stop and acknowledge cancellation." : "Sender blocked.");
      }
    });
  }
  events(): Array<{ id: string; value: Task }> { return this.store.entries<Task>("cli_work_events"); }
  ack(id: string): void { this.store.delete("cli_work_events", id); }
  private change(work: Work, state: TaskState, text?: string): void {
    const message = text ? statusMessage(work.task, text) : undefined;
    work.task.status = { state, timestamp: new Date().toISOString(), message };
    if (message) work.task.history.push(message);
    this.fit(work.task);
    this.store.set("cli_work", work.task.id, work);
    this.store.set("cli_work_events", randomUUID(), work.task);
  }
  private fit(task: Task): void {
    task.history = task.history.slice(-20);
    // Keep result contents intact; recent history is a bounded projection, not the Matrix archive.
    while (task.history.length && Buffer.byteLength(JSON.stringify(encodeResult(task))) > 42000) task.history.shift();
    if (Buffer.byteLength(JSON.stringify(encodeResult(task))) > 44000) throw new WorkError("result_too_large_use_file_reference", 413);
    sized(encodeResult(task));
  }
  private view(work: Work) {
    return { id: work.task.id, from: work.source.sender, conversation: work.source.room, contextId: work.task.contextId,
      status: (TaskState[work.task.status?.state ?? 0] ?? "TASK_STATE_UNSPECIFIED").replace("TASK_STATE_", "").toLowerCase(),
      needsApproval: !this.allowed(work), cancelRequested: Boolean(work.cancelRequested),
      claimId: work.claim?.id ?? null, worker: work.claim?.worker ?? null,
      newInput: Boolean(work.claim && work.claim.revision !== work.revision),
      input: Message.toJSON(work.input),
      history: work.task.history.map((m) => Message.toJSON(m)),
      artifacts: work.task.artifacts.map((a) => Artifact.toJSON(a)) };
  }
}
