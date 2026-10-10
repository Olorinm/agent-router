import { Message, SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { z } from "zod";
import { digest, key, terminal } from "../execution/protocol.js";
import { CliWork } from "../execution/work.js";
import { ChannelSendError, type ChannelAdapter, type ChannelContext, type ChannelMessage, type ReplyRoute } from "./types.js";
import { DurableStore } from "./store.js";

const messageSchema = z.object({
  externalId: z.string().min(1).max(512), sender: z.string().min(1).max(512), threadId: z.string().min(1).max(1024),
  scope: z.enum(["direct", "group"]), text: z.string().max(1_000_000),
  groupId: z.string().max(1024).optional(),
  reply: z.object({ target: z.string().min(1).max(1024), messageId: z.string().max(512), data: z.record(z.string(), z.string().max(8192)) }).strict(),
  attachments: z.array(z.object({ id: z.string().max(1024), name: z.string().max(512), mediaType: z.string().max(100) }).strict()).max(30).optional(),
}).strict();
export interface ConnectionDefinition {
  id: string;
  /** Explicitly linked owner identities share a main conversation only in private chats. */
  ownerAddresses: string[];
  /** Additional peers and groups have isolated conversations. */
  peerAddresses?: string[];
  groupIds?: string[];
}
export interface InboxRecord {
  id: string; connectionId: string; source: ChannelMessage; conversationId: string; replyRoute: ReplyRoute;
  receivedAt: string; hash: string; state: "received" | "ignored" | "submitted" | "done";
  taskId?: string;
  reason?: string;
}
export interface OutboxRecord {
  id: string; taskId: string | null; route: ReplyRoute; text: string;
  state: "queued" | "submitting" | "accepted" | "failed" | "uncertain";
  attempts: number; nextAt: number; externalId?: string; error?: string;
}
interface Connection { definition: ConnectionDefinition; adapter: ChannelAdapter; lastError: string; connected: boolean; }

/** Channel-neutral receipt, conversation mapping and delivery over the existing work ledger. */
export class CommunicationCore {
  private readonly connections = new Map<string, Connection>();
  private dispatching = false;
  private flushing = false;
  private lastError = "";
  constructor(readonly agentId: string, readonly store: DurableStore, readonly work: CliWork, private readonly validate: () => void = () => {}) {}

  register(definition: ConnectionDefinition, adapter: ChannelAdapter): void {
    if (this.connections.has(definition.id)) throw new Error("duplicate_connection_id");
    const fingerprint = digest({ agentId: this.agentId, kind: adapter.kind, ...definition });
    const existing = this.store.get<{ kind: string; agentId: string }>("communication_connections", definition.id);
    if (existing && (existing.kind !== adapter.kind || existing.agentId !== this.agentId)) throw new Error("connection_identity_changed");
    this.store.set("communication_connections", definition.id, { kind: adapter.kind, agentId: this.agentId, fingerprint });
    this.connections.set(definition.id, { definition, adapter, lastError: "", connected: false });
    for (const { id, value } of this.store.entries<OutboxRecord>("communication_outbox")) {
      if (value.route.connectionId === definition.id && value.state === "submitting") {
        this.store.set("communication_outbox", id, { ...value, state: adapter.retrySafe ? "queued" : "uncertain", error: "send_interrupted" });
      }
    }
  }
  context(connectionId: string): ChannelContext {
    this.connection(connectionId);
    return {
      receive: (message) => { this.receive(connectionId, message); },
      checkpoint: ((name: string, value?: unknown) => {
        if (value === undefined) return this.store.get("communication_checkpoints", key(connectionId, name));
        this.store.set("communication_checkpoints", key(connectionId, name), value);
      }) as ChannelContext["checkpoint"],
      error: (code) => { this.connection(connectionId).lastError = code; },
    };
  }
  async start(): Promise<void> {
    // Connect independently: a broken optional channel does not prevent other channels from operating.
    await Promise.all([...this.connections].map(async ([id, connection]) => {
      try { await connection.adapter.start(this.context(id)); connection.connected = true; connection.lastError = ""; }
      catch (error) { connection.lastError = code(error); await connection.adapter.stop().catch(() => {}); }
    }));
  }
  async stop(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map(async (connection) => {
      await connection.adapter.stop(); connection.connected = false;
    }));
  }
  receive(connectionId: string, input: ChannelMessage): InboxRecord {
    this.validate();
    const source = messageSchema.parse(input);
    const { definition } = this.connection(connectionId);
    const id = digest(key(this.agentId, connectionId, source.externalId));
    const hash = digest(source);
    const existing = this.store.get<InboxRecord>("communication_inbox", id);
    if (existing) {
      if (existing.hash !== hash) throw new Error("channel_event_id_reused_with_different_payload");
      return existing;
    }
    const owner = definition.ownerAddresses.includes(source.sender);
    const allowed = source.scope === "direct" ? owner || Boolean(definition.peerAddresses?.includes(source.sender)) :
      Boolean(definition.groupIds?.includes(source.groupId ?? source.threadId)) && (owner || Boolean(definition.peerAddresses?.includes(source.sender)));
    const oversized = Buffer.byteLength(source.text) > 24_000;
    const conversationId = `c-${digest(key(this.agentId, source.scope === "direct" && owner ? "owner-main" :
      key(connectionId, source.scope, source.threadId, source.scope === "direct" ? source.sender : "group"))).slice(0, 40)}`;
    const record: InboxRecord = { id, connectionId, source, conversationId, hash, receivedAt: new Date().toISOString(),
      replyRoute: { connectionId, ...source.reply }, state: allowed && source.text.trim() && !oversized ? "received" : "ignored",
      ...(oversized ? { reason: "input_too_large" } : {}) };
    const commit = () => {
      this.store.set("communication_inbox", id, record);
      this.store.set("communication_threads", key(connectionId, source.scope, source.threadId, source.sender), conversationId);
      if (allowed && oversized) {
        const noticeId = digest(key(id, "input-too-large"));
        this.store.insert("communication_outbox", noticeId, { id: noticeId, taskId: null, route: record.replyRoute,
          text: "这条消息超过当前 24 KB 的文字输入上限，请缩短内容后再发送。", state: "queued", attempts: 0, nextAt: 0 } satisfies OutboxRecord);
      }
    };
    // Matrix invokes receipt inside its existing transaction; other channels create their own.
    if (this.store.db.isTransaction) commit(); else this.store.transaction(commit);
    return record;
  }
  async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (const { id, value } of this.store.entries<InboxRecord>("communication_inbox")) {
        if (value.state !== "received") continue;
        this.validate();
        const request = SendMessageRequest.fromJSON({ message: { messageId: `channel-${id}`, contextId: value.conversationId,
          role: "ROLE_USER", parts: [{ text: value.source.text }] }, configuration: { returnImmediately: true } });
        // Both steps are independently durable. The stable message ID closes the restart window.
        const task = await this.work.send(request, { sender: key("channel", value.connectionId, value.source.sender),
          room: value.conversationId, approved: true });
        this.store.set("communication_inbox", id, { ...value, state: "submitted", taskId: task.id });
      }
      this.publishResults();
      this.lastError = "";
    } catch (error) { this.lastError = code(error); throw error; }
    finally { this.dispatching = false; }
  }
  private publishResults(): void {
    for (const { id: eventId, value: task } of this.work.events()) {
      const input = this.store.entries<InboxRecord>("communication_inbox").find(({ value }) => value.taskId === task.id)?.value;
      if (!input) continue; // Matrix/A2A events belong to the existing connector.
      this.store.transaction(() => {
        if (terminal(task) && input.state !== "done") {
          const parts = task.artifacts.flatMap((artifact) => artifact.parts);
          const answer = this.store.get<string>("communication_results", task.id) ??
            parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n");
          const fallback = task.status?.state === TaskState.TASK_STATE_CANCELED ? "已取消。" :
            task.status?.state === TaskState.TASK_STATE_COMPLETED ? "已完成。" :
              task.status?.message?.parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n") || "本轮执行失败，请查看运行状态。";
          const outbox: OutboxRecord = { id: digest(key(task.id, "final")), taskId: task.id, route: input.replyRoute,
            text: answer || fallback, state: "queued", attempts: 0, nextAt: 0 };
          this.store.insert("communication_outbox", outbox.id, outbox);
          this.store.set("communication_inbox", input.id, { ...input, state: "done" });
        }
        if (!terminal(task) && task.status?.message) {
          const text = task.status.message.parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n");
          if (text) {
            const id = digest(key(task.id, "notice", text));
            this.store.insert("communication_outbox", id, { id, taskId: task.id, route: input.replyRoute, text,
              state: "queued", attempts: 0, nextAt: 0 } satisfies OutboxRecord);
          }
        }
        this.work.ack(eventId);
      });
    }
  }
  saveResult(taskId: string, answer: string): boolean {
    if (!this.store.entries<InboxRecord>("communication_inbox").some(({ value }) => value.taskId === taskId)) return false;
    const previous = this.store.get<string>("communication_results", taskId);
    if (previous !== undefined && previous !== answer) throw new Error("execution_result_changed");
    this.store.set("communication_results", taskId, answer);
    return true;
  }
  isOwnerTask(conversationId: string, taskId: string): boolean {
    const input = this.store.entries<InboxRecord>("communication_inbox").find(({ value }) => value.taskId === taskId)?.value;
    return Boolean(input && input.conversationId === conversationId && input.source.scope === "direct" &&
      this.connection(input.connectionId).definition.ownerAddresses.includes(input.source.sender));
  }
  async flush(now = Date.now()): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const { id, value } of this.store.entries<OutboxRecord>("communication_outbox")) {
        if (value.state !== "queued" || value.nextAt > now) continue;
        this.validate();
        const connection = this.connections.get(value.route.connectionId);
        if (!connection) { this.store.set("communication_outbox", id, { ...value, state: "failed", error: "connection_removed" }); continue; }
        if (!connection.connected) continue;
        const attempt = { ...value, state: "submitting" as const, attempts: value.attempts + 1 };
        this.store.set("communication_outbox", id, attempt);
        try {
          const receipt = await connection.adapter.send(value.route, value.text, id);
          const { error: _error, ...accepted } = attempt;
          this.store.set("communication_outbox", id, { ...accepted, state: "accepted", externalId: receipt.externalId });
        } catch (error) {
          const disposition = error instanceof ChannelSendError ? error.disposition : connection.adapter.retrySafe ? "retry" : "uncertain";
          const nextAt = now + Math.max(error instanceof ChannelSendError ? error.retryAfterMs : 0, Math.min(60_000, 1000 * 2 ** Math.min(attempt.attempts, 6)));
          this.store.set("communication_outbox", id, { ...attempt, state: disposition === "retry" ? "queued" : disposition,
            error: code(error), nextAt });
        }
      }
    } catch (error) { this.lastError = code(error); throw error; }
    finally { this.flushing = false; }
  }
  status() {
    return { agentId: this.agentId, error: this.lastError || null, connections: [...this.connections].map(([id, connection]) => ({ id, kind: connection.adapter.kind,
      started: connection.connected, error: connection.lastError || null })),
      inbox: this.store.entries<InboxRecord>("communication_inbox").slice(-100).map(({ value }) => ({ id: value.id, connectionId: value.connectionId,
        sender: value.source.sender, threadId: value.source.threadId, conversationId: value.conversationId,
        state: value.state, taskId: value.taskId ?? null, reason: value.reason ?? null })),
      outbox: this.store.entries<OutboxRecord>("communication_outbox").slice(-100).map(({ value }) => ({ id: value.id, taskId: value.taskId,
        connectionId: value.route.connectionId, state: value.state, attempts: value.attempts, error: value.error ?? null })) };
  }
  private connection(id: string): Connection {
    const connection = this.connections.get(id);
    if (!connection) throw new Error("connection_not_found");
    return connection;
  }
}
function code(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_:-]+$/.test(error.message) ? error.message : "channel_operation_failed";
}
