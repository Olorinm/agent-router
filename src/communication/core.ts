import { Message, SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { z } from "zod";
import { digest, key, terminal } from "../execution/protocol.js";
import { CliWork } from "../execution/work.js";
import { ChannelSendError, type ChannelAdapter, type ChannelContext, type ChannelMessage, type ReplyRoute, type ChannelContent, type MediaContent } from "./types.js";
import { DurableStore } from "./store.js";

const messageSchema = z.object({
  externalId: z.string().min(1).max(512), sender: z.string().min(1).max(512), threadId: z.string().min(1).max(1024),
  scope: z.enum(["direct", "group"]), text: z.string().max(1_000_000),
  groupId: z.string().max(1024).optional(),
  reply: z.object({ target: z.string().min(1).max(1024), messageId: z.string().max(512), data: z.record(z.string(), z.string().max(8192)) }).strict(),
  attachments: z.array(z.object({ id: z.string().max(1024), name: z.string().max(512), mediaType: z.string().max(100), kind: z.enum(["image", "audio", "video", "file", "sticker"]).optional(), data: z.record(z.string(), z.unknown()).optional() }).strict()).max(30).optional(),
  quoted: z.object({ messageId: z.string().optional(), text: z.string().optional() }).strict().optional(),
  action: z.object({ token: z.string().max(128) }).strict().optional(),
  event: z.object({ type: z.string().max(100), data: z.record(z.string(), z.unknown()) }).strict().optional(),
  native: z.record(z.string(), z.unknown()).optional(),
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
  content?: ChannelContent;
  originTaskId?: string;
  final?: boolean;
  activity?: { key: string; active: boolean };
  attempts: number; nextAt: number; externalId?: string; error?: string;
}
interface Connection { definition: ConnectionDefinition; adapter: ChannelAdapter; reload?: () => ChannelAdapter; lastError: string; connected: boolean; failures: number; nextStart: number; }

/** Channel-neutral receipt, conversation mapping and delivery over the existing work ledger. */
export class CommunicationCore {
  private readonly connections = new Map<string, Connection>();
  private dispatching = false;
  private flushing = false;
  private lastError = "";
  control?: (input: InboxRecord) => Promise<boolean>;
  constructor(readonly agentId: string, readonly store: DurableStore, readonly work: CliWork, private readonly validate: () => void = () => {}) {}

  register(definition: ConnectionDefinition, adapter: ChannelAdapter, reload?: () => ChannelAdapter): void {
    if (this.connections.has(definition.id)) throw new Error("duplicate_connection_id");
    const fingerprint = digest({ agentId: this.agentId, kind: adapter.kind, ...definition });
    const existing = this.store.get<{ kind: string; agentId: string }>("communication_connections", definition.id);
    if (existing && (existing.kind !== adapter.kind || existing.agentId !== this.agentId)) throw new Error("connection_identity_changed");
    this.store.set("communication_connections", definition.id, { kind: adapter.kind, agentId: this.agentId, fingerprint });
    this.connections.set(definition.id, { definition, adapter, ...(reload ? { reload } : {}), lastError: "", connected: false, failures: 0, nextStart: 0 });
    for (const { id, value } of this.store.entries<OutboxRecord>("communication_outbox")) {
      if (value.route.connectionId === definition.id && value.state === "submitting") {
        this.store.set("communication_outbox", id, { ...value, state: value.activity || adapter.retrySafe ? "queued" : "uncertain", error: "send_interrupted" });
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
      disconnected: (error) => {
        const connection = this.connection(connectionId); connection.connected = false; connection.lastError = error;
        connection.nextStart = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(++connection.failures, 6));
      },
    };
  }
  async start(): Promise<void> { await this.reconnect(); }
  async reconnect(now = Date.now()): Promise<void> {
    await Promise.all([...this.connections].map(async ([id, connection]) => {
      if (connection.connected || connection.nextStart > now) return;
      connection.nextStart = Number.MAX_SAFE_INTEGER;
      try {
        if (connection.failures) { await connection.adapter.stop(); if (connection.reload) connection.adapter = connection.reload(); }
        await connection.adapter.start(this.context(id)); connection.connected = true;
        connection.lastError = ""; connection.failures = 0;
      } catch (error) {
        connection.lastError = code(error); await connection.adapter.stop().catch(() => {});
        connection.nextStart = now + Math.min(60_000, 1000 * 2 ** Math.min(++connection.failures, 6));
      }
    }));
  }
  async stop(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map(async (connection) => {
      await connection.adapter.stop(); connection.connected = false;
      connection.nextStart = Number.MAX_SAFE_INTEGER;
    }));
  }
  receive(connectionId: string, input: ChannelMessage): InboxRecord {
    this.validate();
    const source = messageSchema.parse(input);
    const { definition, adapter } = this.connection(connectionId);
    const id = digest(key(this.agentId, connectionId, source.externalId));
    const hash = digest(source);
    const existing = this.store.get<InboxRecord>("communication_inbox", id);
    if (existing) {
      if (existing.hash !== hash) throw new Error("channel_event_id_reused_with_different_payload");
      return existing;
    }
    const owner = definition.ownerAddresses.includes(source.sender);
    const allowed = source.scope === "direct" ? owner || Boolean(definition.peerAddresses?.includes(source.sender)) :
      adapter.groupPolicy?.(source) === "open" ||
        Boolean(definition.groupIds?.includes(source.groupId ?? source.threadId)) && (owner || Boolean(definition.peerAddresses?.includes(source.sender)));
    const oversized = Buffer.byteLength(source.text) > 24_000;
    const conversationId = `c-${digest(key(this.agentId, source.scope === "direct" && owner ? "owner-main" :
      key(connectionId, source.scope, source.threadId, source.scope === "direct" ? source.sender : "group"))).slice(0, 40)}`;
    const record: InboxRecord = { id, connectionId, source, conversationId, hash, receivedAt: new Date().toISOString(),
      replyRoute: { connectionId, ...source.reply }, state: allowed && (source.text.trim() || source.attachments?.length || source.action || source.event) && !oversized ? "received" : "ignored",
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
        const eventType = value.source.event?.type;
        // Message state changes are durable context, not new requests or answers to pending interactions.
        if (eventType && ["reaction", "message-edit", "message-redaction"].includes(eventType)) {
          this.store.set("communication_inbox", id, { ...value, state: "done",
            reason: eventType === "message-edit" ? "edit_recorded_without_reexecution" : `${eventType}_recorded_without_execution` });
          continue;
        }
        if (this.control && await this.control(value)) {
          this.store.set("communication_inbox", id, { ...value, state: "done" }); continue;
        }
        if (value.source.action) { this.notice(value, "这个按钮已失效，请根据当前提问重新操作。", "stale-action"); this.store.set("communication_inbox", id, { ...value, state: "done" }); continue; }
        const prior = this.store.entries<InboxRecord>("communication_inbox").map(({ value: item }) => item).reverse().find((item) =>
          item.taskId && item.conversationId === value.conversationId &&
          (item.connectionId === value.connectionId && item.source.sender === value.source.sender || this.isOwnerInput(item) && this.isOwnerInput(value)));
        const previous = prior?.taskId ? await this.work.get(prior.taskId) : undefined;
        const resume = previous && [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED].includes(previous.status?.state ?? 0);
        let quote = value.source.quoted?.text;
        if (!quote && value.source.quoted?.messageId) {
          const original = this.store.entries<InboxRecord>("communication_inbox").map(({ value: item }) => item).find((item) => item.connectionId === value.connectionId && item.replyRoute.target === value.replyRoute.target && item.replyRoute.messageId === value.source.quoted!.messageId);
          try { quote = original?.source.text ?? await this.connection(value.connectionId).adapter.readQuote?.(value.source); }
          catch { this.connection(value.connectionId).lastError = "quoted_message_unavailable"; }
        }
        let text = [quote ? `引用消息：${quote}` : value.source.quoted?.messageId ? `引用消息 ID：${value.source.quoted.messageId}` : "", value.source.text,
          value.source.event ? JSON.stringify(value.source.event) : "",
          ...(value.source.attachments ?? []).map((item) => `附件：${item.name} (${item.mediaType})`)].filter(Boolean).join("\n");
        if (Buffer.byteLength(text) > 24_000) text = Buffer.from(text).subarray(0, 23_500).toString("utf8") + "\n[消息上下文已截短；原始消息可通过 channel message 工具读取。]";
        // Execution tools need provider IDs; the internal session ID cannot fetch channel history.
        // Select routing facts explicitly: raw events and reply data may contain provider secrets.
        const channelContext = { channel: this.connection(value.connectionId).adapter.kind, connectionId: value.connectionId,
          scope: value.source.scope, conversationId: value.replyRoute.target, messageId: value.replyRoute.messageId,
          senderId: value.source.sender, ...(value.source.quoted?.messageId ? { quotedMessageId: value.source.quoted.messageId } : {}) };
        const request = SendMessageRequest.fromJSON({ message: { messageId: `channel-${id}`, contextId: value.conversationId,
          ...(resume ? { taskId: previous!.id } : {}), role: "ROLE_USER",
          parts: [{ text }, { text: `Channel context (provider routing IDs): ${JSON.stringify(channelContext)}` }] }, configuration: { returnImmediately: true } });
        // Both steps are independently durable. The stable message ID closes the restart window.
        const task = await this.work.send(request, { sender: resume ? this.work.inspect(previous!.id).from : key("channel", value.connectionId, value.source.sender),
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
      const input = this.input(task.id);
      if (!input) continue; // Matrix/A2A events belong to the existing connector.
      this.store.transaction(() => {
        const adapter = this.connection(input.connectionId).adapter;
        const capabilities = adapter.capabilitiesFor?.(input.replyRoute) ?? adapter.capabilities;
        if (adapter.activity && capabilities?.native.includes("reaction")) {
          const active = task.status?.state === TaskState.TASK_STATE_WORKING;
          const id = digest(key(input.id, "activity", String(active)));
          this.store.insert("communication_outbox", id, { id, taskId: task.id, route: input.replyRoute, text: "",
            activity: { key: input.id, active }, state: "queued", attempts: 0, nextAt: 0 } satisfies OutboxRecord);
        }
        if (terminal(task) && input.state !== "done") {
          const parts = task.artifacts.flatMap((artifact) => artifact.parts);
          const answer = this.store.get<string>("communication_results", task.id) ??
            parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n");
          const fallback = task.status?.state === TaskState.TASK_STATE_CANCELED ? "已取消。" :
            task.status?.state === TaskState.TASK_STATE_COMPLETED ? "已完成。" :
              task.status?.message?.parts.filter((part) => part.content?.$case === "text").map((part) => part.content!.value).join("\n") || "本轮执行失败，请查看运行状态。";
          const outbox: OutboxRecord = { id: digest(key(task.id, "final")), taskId: task.id, route: input.replyRoute,
            text: answer || fallback, final: true, state: "queued", attempts: 0, nextAt: 0 };
          this.store.insert("communication_outbox", outbox.id, outbox);
          for (const { id, value } of this.store.entries<InboxRecord>("communication_inbox")) if (value.taskId === task.id)
            this.store.set("communication_inbox", id, { ...value, state: "done" });
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
        if (value.activity?.active && ((await this.work.get(value.taskId!)).status?.state !== TaskState.TASK_STATE_WORKING || this.input(value.taskId!)?.id !== value.activity.key)) {
          this.store.set("communication_outbox", id, { ...value, state: "accepted" }); continue;
        }
        const attempt = { ...value, state: "submitting" as const, attempts: value.attempts + 1 };
        this.store.set("communication_outbox", id, attempt);
        try {
          const streamed = value.taskId && (value.final || id === digest(key(value.taskId, "final"))) && this.store.get("communication_streams", value.taskId);
          const receipt = value.activity && connection.adapter.activity
            ? await connection.adapter.activity(value.route, value.activity.active, value.activity.key)
            : streamed && !value.content && connection.adapter.progress
            ? await connection.adapter.progress(value.route, value.text, value.taskId!, true)
            : value.content && connection.adapter.sendContent ? await connection.adapter.sendContent(value.route, value.content, id)
            : await connection.adapter.send(value.route, value.text, id);
          const { error: _error, ...accepted } = attempt;
          this.store.set("communication_outbox", id, { ...accepted, state: "accepted", externalId: receipt.externalId });
        } catch (error) {
          const disposition = value.activity ? (attempt.attempts < 5 ? "retry" : "failed") :
            error instanceof ChannelSendError ? error.disposition : connection.adapter.retrySafe ? "retry" : "uncertain";
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
      started: connection.connected, capabilities: connection.adapter.capabilities ?? null, error: connection.lastError || null })),
      inbox: this.store.entries<InboxRecord>("communication_inbox").slice(-100).map(({ value }) => ({ id: value.id, connectionId: value.connectionId,
        sender: value.source.sender, threadId: value.source.threadId, conversationId: value.conversationId,
        state: value.state, taskId: value.taskId ?? null, reason: value.reason ?? null })),
      outbox: this.store.entries<OutboxRecord>("communication_outbox").slice(-100).map(({ value }) => ({ id: value.id, taskId: value.taskId,
        connectionId: value.route.connectionId, state: value.state, attempts: value.attempts, error: value.error ?? null })) };
  }
  input(taskId: string): InboxRecord | undefined {
    return this.store.entries<InboxRecord>("communication_inbox").map(({ value }) => value).reverse().find((item) => item.taskId === taskId);
  }
  notice(input: InboxRecord, text: string, suffix: string, content?: ChannelContent): string {
    const id = digest(key(input.id, suffix));
    this.store.insert("communication_outbox", id, { id, taskId: null, route: input.replyRoute, text,
      ...(content ? { content } : {}), state: "queued", attempts: 0, nextAt: 0 } satisfies OutboxRecord);
    return id;
  }
  async attachments(taskId: string): Promise<MediaContent[]> {
    const input = this.input(taskId); if (!input) return [];
    const cached = this.store.get<MediaContent[]>("communication_media", input.id); if (cached) return cached;
    const adapter = this.connection(input.connectionId).adapter;
    const items: MediaContent[] = []; let size = 0;
    for (const attachment of input.source.attachments ?? []) {
      if (attachment.kind === "sticker" && adapter.capabilities?.receive.includes("sticker-reference")) continue;
      if (!adapter.readAttachment) throw new Error("channel_attachment_read_unsupported");
      const item = await adapter.readAttachment(input.source, attachment);
      size += Buffer.byteLength(item.data, "base64"); if (size > 30 * 1024 * 1024) throw new Error("attachments_too_large");
      items.push(item);
    }
    if (items.length) this.store.set("communication_media", input.id, items);
    return items;
  }
  async progress(taskId: string, text: string): Promise<void> {
    const input = this.input(taskId); if (!input || !text) return;
    const connection = this.connection(input.connectionId);
    if (!connection.connected || !connection.adapter.progress || !this.capabilities(taskId)?.stream) return;
    const receipt = await connection.adapter.progress(input.replyRoute, text, taskId, false);
    this.store.set("communication_progress_messages", taskId, receipt.externalId.split(","));
    this.store.set("communication_streams", taskId, true);
  }
  capabilities(taskId: string) { const input = this.input(taskId); if (!input) return undefined;
    const adapter = this.connection(input.connectionId).adapter; return adapter.capabilitiesFor?.(input.replyRoute) ?? adapter.capabilities; }
  isOwnerInput(input: InboxRecord) { return input.source.scope === "direct" && this.connection(input.connectionId).definition.ownerAddresses.includes(input.source.sender); }
  queueContent(taskId: string, content: ChannelContent, sendKey: string): string {
    const input = this.input(taskId); if (!input) throw new Error("channel_task_not_found");
    const adapter = this.connection(input.connectionId).adapter;
    if ((content.html || content.media?.length || content.card || content.buttons?.length) && !adapter.sendContent) throw new Error("channel_content_unsupported");
    const capabilities = this.capabilities(taskId);
    if (content.html && !capabilities?.send.includes("html")) throw new Error("channel_html_unsupported");
    if (content.media?.length && !capabilities?.send.some((kind) => ["file", "image", "audio", "video"].includes(kind))) throw new Error("channel_media_unsupported");
    if (!content.text && !content.html && !content.media?.length && !content.card && !content.buttons?.length) throw new Error("channel_content_empty");
    if (content.card && !capabilities?.send.includes("card")) throw new Error("channel_card_unsupported");
    const id = digest(key(taskId, "content", sendKey));
    this.store.insert("communication_outbox", id, { id, taskId: null, originTaskId: taskId, route: input.replyRoute, text: content.text,
      content, state: "queued", attempts: 0, nextAt: 0 } satisfies OutboxRecord);
    return id;
  }
  delivery(taskId: string, id: string) {
    const row = this.store.get<OutboxRecord>("communication_outbox", id);
    if (!row || row.originTaskId !== taskId) throw new Error("channel_delivery_not_found");
    return { id, state: row.state, externalId: row.externalId ?? null, error: row.error ?? null };
  }
  async native(taskId: string, operation: string, args: Record<string, unknown>) {
    const input = this.input(taskId); if (!input) throw new Error("channel_task_not_found");
    const adapter = this.connection(input.connectionId).adapter;
    if (!adapter.native || !this.capabilities(taskId)?.native.includes(operation)) throw new Error("channel_native_operation_unsupported");
    return adapter.native(input.replyRoute, operation, args);
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
