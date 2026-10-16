import { ChannelHttpError } from "../channels/http.js";
import type { InboxRecord, OutboxRecord } from "../communication/core.js";
import type { DurableStore } from "../communication/store.js";
import type { HostPort, HostRun } from "./host.js";
import type { ExecutionSession, RunBinding } from "./host-worker.js";
import { CliWork, WorkError } from "./work.js";

export interface TaskFilter {
  connectionId?: string | undefined;
  target?: string | undefined;
  conversationId?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
}
export interface RunReference {
  claimId: string;
  taskId: string;
  conversationId: string;
  sessionId: string;
  runId: string | null;
  phase: RunBinding["phase"];
  error: string | null;
}
export interface CommunicationTask {
  id: string;
  conversationId: string;
  receivedAt: string;
  source: { connectionId: string; messageId: string; target: string; sender: string; scope: "direct" | "group" };
  status: string;
  cancelRequested: boolean;
  runs: RunReference[];
  replyMessageIds: string[];
  interactionMessageIds: string[];
}

/** Owner-scoped observation of Router bindings through the Host's public protocol.
 * Host owns event history, sequence numbers and interaction decisions; no second event log.
 */
export class RunObservation {
  constructor(readonly store: DurableStore, readonly work: CliWork, readonly host: HostPort) {}
  tasks(filter: TaskFilter = {}): { data: CommunicationTask[]; next: string | null } {
    const seen = new Set<string>();
    // Preserve the first receipt as the task's immutable origin, including resumed revisions.
    let inputs = this.store.entries<InboxRecord>("communication_inbox").map(({ value }) => value)
      .filter((input) => { if (!input.taskId || seen.has(input.taskId)) return false; seen.add(input.taskId); return true; })
      .reverse().filter((input) => (!filter.connectionId || input.connectionId === filter.connectionId)
        && (!filter.target || input.replyRoute.target === filter.target)
        && (!filter.conversationId || input.conversationId === filter.conversationId));
    if (filter.before) {
      const index = inputs.findIndex((input) => input.taskId === filter.before);
      if (index < 0) throw new WorkError("task_cursor_not_found", 404);
      inputs = inputs.slice(index + 1);
    }
    const limit = filter.limit ?? 50;
    const bindings = this.store.entries<RunBinding>("communication_runs").map(({ value }) => value);
    const questions = this.store.entries<{ taskId: string; noticeId: string }>("communication_questions").map(({ value }) => value);
    const outbox = this.store.entries<OutboxRecord>("communication_outbox").map(({ value }) => value);
    const data = inputs.slice(0, limit).map((input): CommunicationTask => {
      const task = this.work.inspect(input.taskId!);
      return { id: input.taskId!, conversationId: input.conversationId, receivedAt: input.receivedAt,
        source: { connectionId: input.connectionId, messageId: input.source.externalId, target: input.replyRoute.target,
          sender: input.source.sender, scope: input.source.scope }, status: task.status, cancelRequested: task.cancelRequested,
        runs: bindings.filter((binding) => binding.taskId === input.taskId).map((binding) => this.reference(binding)),
        replyMessageIds: [...new Set([
          ...(this.store.get<string[]>("communication_progress_messages", input.taskId!) ?? []),
          ...outbox.filter((item) => item.taskId === input.taskId && item.final && item.externalId).flatMap((item) => item.externalId!.split(",")),
        ])],
        interactionMessageIds: outbox.filter((item) => item.externalId && questions.some((q) => q.taskId === input.taskId && q.noticeId === item.id))
          .flatMap((item) => item.externalId!.split(",")) };
    });
    return { data, next: inputs.length > limit ? data.at(-1)!.id : null };
  }
  private binding(claimId: string): RunBinding {
    const binding = this.store.get<RunBinding>("communication_runs", claimId);
    if (!binding) throw new WorkError("run_not_found", 404);
    return binding;
  }
  private reference(binding: RunBinding): RunReference {
    return { claimId: binding.claimId, taskId: binding.taskId, conversationId: binding.contextId,
      sessionId: binding.sessionId, runId: binding.runId ?? null, phase: binding.phase, error: binding.error ?? null };
  }
  private async request<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ChannelHttpError && [400, 404, 409, 422].includes(error.status))
        throw new WorkError(error.code, error.status);
      throw error;
    }
  }
  private async scopedRun(binding: RunBinding): Promise<HostRun> {
    if (!binding.runId) throw new WorkError("host_run_unavailable", 409);
    const run = await this.request(() => this.host.get(binding.runId!));
    const session = this.store.get<ExecutionSession>("execution_sessions", binding.contextId);
    if (run.id !== binding.runId || run.sessionId !== binding.sessionId || run.runtimeId !== session?.runtimeId)
      throw new WorkError("host_run_scope_mismatch", 409);
    return run;
  }
  async run(claimId: string) {
    const binding = this.binding(claimId), run = await this.scopedRun(binding);
    const calls = await this.request(() => this.host.calls(run.id));
    if (calls.some((call) => call.runId !== run.id)) throw new WorkError("host_call_scope_mismatch", 409);
    return { ...this.reference(binding), run, calls };
  }
  async events(claimId: string, after = 0, limit = 200) {
    const binding = this.binding(claimId);
    await this.scopedRun(binding);
    if (!this.host.events) throw new WorkError("host_events_unsupported", 409);
    const page = await this.request(() => this.host.events!(binding.runId!, after, limit));
    if (page.events.some(({ event }) => event.runId !== binding.runId)) throw new WorkError("host_event_scope_mismatch", 409);
    return page;
  }
  async resolve(claimId: string, callId: string, result: unknown) {
    const { run, calls } = await this.run(claimId);
    const call = calls.find((item) => item.id === callId && item.kind === "interaction");
    if (!call) throw new WorkError("interaction_not_found", 404);
    // The Host arbitrates expiry, repeated identical answers and conflicting answers.
    await this.request(() => this.host.resolve(run.id, callId, result));
  }
  async cancel(taskId: string) {
    if (!this.store.entries<InboxRecord>("communication_inbox").some(({ value }) => value.taskId === taskId))
      throw new WorkError("task_not_found", 404);
    await this.work.cancel(taskId);
  }
}
