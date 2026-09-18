import { randomUUID } from "node:crypto";
import { SendMessageRequest, TaskState, type Task } from "@a2a-js/sdk";
import { ConnectorStore } from "../matrix/store.js";
import { digest } from "../matrix/protocol.js";
import { WorkError } from "../matrix/cli-work.js";
import type { ExecutionBackend, ExecutionSource } from "../matrix/backend.js";
import { ChannelError, channelEntrySchema, channelMessageSchema, type ChannelAdapter, type ChannelEntry, type ChannelMessage } from "./types.js";
import { evaluateInvocation } from "./policy.js";

type Backend = Omit<ExecutionBackend, "send"> & {
  send(request: SendMessageRequest, source: ExecutionSource): Promise<Task>;
  acknowledge?: (taskId: string) => void;
};
type Decision = "allow" | "ask" | "deny";
interface Visitor { id: string; entryId: string; subject: string; firstSeen: string; lastSeen: string; decision: Decision | "inherit"; }
interface Conversation { contextId: string; taskId?: string; }
export interface ChannelEvent {
  id: string; entryId: string; agentId: string; visitorId: string; message: ChannelMessage;
  hash: string; contextKey: string; contextId: string; decision: Decision;
  state: "pending" | "queued" | "submitted" | "delivering" | "replied" | "rejected" | "delivery-failed";
  prepared?: boolean; resumeTaskId?: string; taskId?: string;
  response?: string; deliveryStartedAt?: string; deliveryId?: string; error?: string;
  ruleId?: string;
}
interface EntryState { entry: ChannelEntry; startedAt: string; cursor?: string; lastPollAt?: string; error?: string; halted?: boolean; }
const key = (...parts: string[]) => digest(JSON.stringify(parts));
const isTerminal = (task: Task) => [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].includes(task.status?.state ?? 0);
const responseText = (task: Task) => {
  if (task.status?.state === TaskState.TASK_STATE_COMPLETED) {
    return task.artifacts.flatMap(a => a.parts).map(p => p.content?.$case === "text" ? p.content.value : "").filter(Boolean).join("\n") || "任务已完成，没有文本结果。";
  }
  if ([TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state ?? 0)) {
    return task.status?.message?.parts.map(p => p.content?.$case === "text" ? p.content.value : "").join("\n") || "处理这项请求需要补充信息，请回复这封邮件。";
  }
  return "这次任务未能完成，可能已执行部分操作。请在本邮件对话中确认进度后再继续。";
};

/** Channel-neutral identity, authorization, conversation and delivery ledger. */
export class ChannelRouter {
  private bindings = new Map<string, { entry: ChannelEntry; adapter: ChannelAdapter }>();
  private running = new Map<string, Promise<void>>();
  private nextPoll = new Map<string, number>();
  private retryAt = new Map<string, number>();
  constructor(readonly store: ConnectorStore, private readonly backend: (agentId: string) => Promise<Backend>) {}

  register(input: ChannelEntry, adapter: ChannelAdapter): void {
    const entry = channelEntrySchema.parse(input);
    if (this.bindings.has(entry.id)) throw new Error("channel_entry_duplicate");
    const old = this.store.get<EntryState>("channel_entries", entry.id);
    if (old && key(old.entry.kind, old.entry.account, old.entry.agentId, old.entry.accessMode) !== key(entry.kind, entry.account, entry.agentId, entry.accessMode)) {
      throw new Error("channel_binding_changed_use_new_entry");
    }
    this.store.set("channel_entries", entry.id, { ...old, entry, startedAt: old?.startedAt ?? new Date().toISOString() });
    this.bindings.set(entry.id, { entry, adapter });
  }
  entries(agentId: string) {
    return [...this.bindings.values()].filter(b => b.entry.agentId === agentId)
      .map(b => this.store.get<EntryState>("channel_entries", b.entry.id)!);
  }
  visitors(entryId: string): Visitor[] {
    return this.store.entries<Visitor>("channel_visitors").map(r => r.value).filter(v => v.entryId === entryId);
  }
  events(entryId: string): ChannelEvent[] {
    return this.store.entries<ChannelEvent>("channel_events").map(r => r.value).filter(e => e.entryId === entryId);
  }
  hasMessage(entryId: string, messageId: string): boolean {
    return Boolean(this.store.get("channel_events", key(entryId, messageId)));
  }
  ownedEntry(entryId: string, agentId: string): ChannelEntry {
    const entry = this.bindings.get(entryId)?.entry;
    if (!entry || entry.agentId !== agentId) throw new WorkError("channel_not_found", 404);
    return entry;
  }
  decide(entryId: string, eventId: string, decision: "allow" | "deny"): void {
    const event = this.store.get<ChannelEvent>("channel_events", eventId);
    if (!event || event.entryId !== entryId) throw new WorkError("channel_event_not_found", 404);
    if (["replied", "rejected", "delivery-failed"].includes(event.state)) throw new WorkError("channel_event_closed", 409);
    if (decision === "allow" && event.message.authentication !== "provider-screened") throw new WorkError("channel_sender_unverified", 403);
    event.decision = decision; this.store.set("channel_events", event.id, event);
  }
  decideVisitor(entryId: string, visitorId: string, decision: Decision | "inherit"): void {
    const visitor = this.store.get<Visitor>("channel_visitors", visitorId);
    if (!visitor || visitor.entryId !== entryId) throw new WorkError("channel_visitor_not_found", 404);
    visitor.decision = decision; this.store.set("channel_visitors", visitor.id, visitor);
  }
  resume(entryId: string): void {
    const state = this.store.get<EntryState>("channel_entries", entryId)!;
    delete state.halted; delete state.error;
    this.store.set("channel_entries", entryId, state); this.nextPoll.delete(entryId); this.retryAt.delete(entryId);
  }
  ingest(entry: ChannelEntry, input: ChannelMessage): ChannelEvent {
    const message = channelMessageSchema.parse(input);
    const id = key(entry.id, message.id), hash = digest(JSON.stringify(message));
    const prior = this.store.get<ChannelEvent>("channel_events", id);
    if (prior) {
      if (prior.hash !== hash) throw new ChannelError("channel_message_id_reused", true);
      return prior;
    }
    if (this.events(entry.id).filter(e => !["replied", "rejected", "delivery-failed"].includes(e.state)).length >= 1000) {
      throw new ChannelError("channel_pending_limit", true);
    }
    return this.store.transaction(() => {
      const visitorId = key(entry.id, message.subject);
      const visitor = this.store.get<Visitor>("channel_visitors", visitorId) ?? {
        id: visitorId, entryId: entry.id, subject: message.subject, firstSeen: message.receivedAt, decision: "inherit" as const,
      };
      this.store.set("channel_visitors", visitorId, { ...visitor, lastSeen: message.receivedAt });
      // A shared mailbox, a copied thread ID, or the same person's second channel
      // never grants access to somebody else's native Agent session.
      const contextKey = key(entry.id, visitorId, message.conversation);
      const context = this.store.get<Conversation>("channel_contexts", contextKey) ?? { contextId: randomUUID() };
      this.store.set("channel_contexts", contextKey, context);
      const event: ChannelEvent = { id, entryId: entry.id, agentId: entry.agentId, visitorId, message, hash,
        contextKey, contextId: context.contextId, decision: "ask", state: "pending" };
      this.save(event); return event;
    });
  }
  private permission(entry: ChannelEntry, event: ChannelEvent): Decision {
    event.decision = this.store.get<ChannelEvent>("channel_events", event.id)?.decision ?? event.decision;
    const visitor = this.store.get<Visitor>("channel_visitors", event.visitorId)!;
    if (!entry.enabled || event.decision === "deny" || visitor.decision === "deny") return "deny";
    const policy = evaluateInvocation(entry.rules, { channelKind: entry.kind, entryId: entry.id,
      visitorId: visitor.id, subject: event.message.subject, agentId: entry.agentId, operation: "invoke",
      ...(event.message.subjectDomain ? { domain: event.message.subjectDomain } : {}) });
    event.ruleId = policy.ruleId;
    if (policy.decision === "deny") return "deny";
    if (event.message.authentication !== "provider-screened") return "ask";
    if (event.decision === "allow") return "allow";
    if (visitor.decision === "ask") return "ask";
    if (visitor.decision === "allow" && policy.ruleId === "default") return "allow";
    return policy.decision;
  }
  private save(event: ChannelEvent): void {
    // Owner decisions may arrive while a provider/backend request is in flight.
    const latest = this.store.get<ChannelEvent>("channel_events", event.id);
    if (latest) event.decision = latest.decision;
    this.store.set("channel_events", event.id, event);
  }

  tick(entryId: string): Promise<void> {
    const active = this.running.get(entryId);
    if (active) return active;
    const run = this.process(entryId).finally(() => { this.running.delete(entryId); });
    this.running.set(entryId, run); return run;
  }
  async drain(): Promise<void> { await Promise.allSettled(this.running.values()); }
  async close(): Promise<void> {
    for (const { adapter } of this.bindings.values()) adapter.close?.();
    await this.drain();
  }
  private async process(entryId: string): Promise<void> {
    const { entry, adapter } = this.bindings.get(entryId)!;
    let state = this.store.get<EntryState>("channel_entries", entryId)!;
    const paused = state.halted || Date.now() < (this.retryAt.get(entryId) ?? 0);
    try {
      if (!paused && entry.enabled && Date.now() >= (this.nextPoll.get(entryId) ?? 0)) {
        const page = await adapter.poll(state.cursor, state.startedAt);
        for (const message of page.messages) this.ingest(entry, message);
        state = { ...state, cursor: page.cursor, lastPollAt: new Date().toISOString() };
        delete state.error; this.store.set("channel_entries", entryId, state);
        this.nextPoll.set(entryId, Date.now() + (page.more ? 1000 : 30_000));
      }
      const backend = await this.backend(entry.agentId);
      const occupied = new Set<string>();
      for (const event of this.events(entryId)) {
        if (["replied", "rejected", "delivery-failed"].includes(event.state)) continue;
        const permission = this.permission(entry, event);
        this.save(event);
        if (permission !== "allow") {
          if (event.taskId) await backend.cancel(event.taskId);
          if (permission === "deny" || event.taskId) { event.state = "rejected"; this.save(event); }
          continue;
        }
        if (paused) continue;
        // Process follow-ups in arrival order; no two tasks in a mail conversation
        // race to replace each other's native session or final reply.
        if (occupied.has(event.contextKey)) continue;
        occupied.add(event.contextKey);
        if (!event.taskId) {
          if (!event.prepared) {
            const previous = this.store.get<Conversation>("channel_contexts", event.contextKey)!;
            if (previous.taskId) {
              const task = await backend.get(previous.taskId);
              if ([TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state ?? 0)) event.resumeTaskId = previous.taskId;
              else if (!isTerminal(task)) continue;
            }
            event.prepared = true; event.state = "queued"; this.save(event);
          }
          const beforeSubmit = this.permission(entry, event);
          if (beforeSubmit !== "allow") {
            event.state = beforeSubmit === "deny" ? "rejected" : "pending"; this.save(event); continue;
          }
          const task = await backend.send(SendMessageRequest.fromJSON({ message: {
            messageId: event.id, contextId: event.contextId, ...(event.resumeTaskId ? { taskId: event.resumeTaskId } : {}),
            role: "ROLE_USER", parts: [{ text: event.message.text }],
          } }), { sender: `visitor:${event.visitorId}`, room: `channel:${event.contextKey}`, approved: true,
            execution: { accessMode: entry.accessMode } });
          event.taskId = task.id; event.state = "submitted";
          this.store.transaction(() => {
            this.save(event); this.store.set("channel_contexts", event.contextKey, { contextId: event.contextId, taskId: task.id });
          });
        }
        const task = await backend.get(event.taskId);
        backend.acknowledge?.(event.taskId);
        this.save(event);
        if (this.permission(entry, event) !== "allow") {
          await backend.cancel(event.taskId);
          event.state = "rejected"; this.save(event); continue;
        }
        if (!isTerminal(task) && ![TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state ?? 0)) continue;
        if (!event.response) {
          event.response = responseText(task); event.state = "delivering";
          event.deliveryStartedAt = new Date().toISOString(); this.save(event);
        }
        // The provider's idempotency retention is not an unlimited exactly-once
        // guarantee. Stop uncertain delivery after one day for operator review.
        if (Date.now() - Date.parse(event.deliveryStartedAt!) > 86_400_000) {
          event.state = "delivery-failed"; event.error = "delivery_uncertain_review_required"; this.save(event); continue;
        }
        try {
          event.deliveryId = await adapter.reply(event.message, event.response, `router-${event.id}`);
          event.state = "replied"; this.save(event);
        } catch (error) {
          if (error instanceof ChannelError && error.permanent) { event.error = error.code; this.save(event); }
          throw error;
        }
      }
    } catch (error) {
      state = this.store.get<EntryState>("channel_entries", entryId)!;
      state.error = error instanceof ChannelError ? error.code : "channel_operation_failed";
      if (error instanceof ChannelError && error.permanent) state.halted = true;
      this.store.set("channel_entries", entryId, state);
      this.retryAt.set(entryId, Date.now() + (error instanceof ChannelError ? error.retryAfterMs : 60_000));
    }
  }
}
