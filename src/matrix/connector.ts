import { randomUUID } from "node:crypto";
import { Message, SendMessageRequest, Task, TaskState, type SendMessageResult } from "@a2a-js/sdk";
import type { ExecutionBackend } from "./backend.js";
import { ConnectorStore } from "./store.js";
import type { MatrixTransport, SyncBatch } from "./transport.js";
import { decodeRequest, decodeResult, digest, encodeResult, key, mxid, newTask, REQUEST_EVENT, requestSchema,
  RESPONSE_EVENT, responseSchema, sized, statusMessage, terminal, type RequestEvent, type ResponseEvent, type RoomEvent } from "./protocol.js";

export interface Contact { address: string; note: string; receive?: "allow" | "ask" | "deny"; execution: "allow" | "ask" | "deny"; }
export interface Conversation { id: string; room: string; peer: string; }
export interface Outgoing {
  id: string; target: string; room: string; taskId: string; contextId: string; request: RequestEvent;
  status: "queued" | "received" | "done"; error?: string;
}
export interface Incoming {
  id: string; room: string; sender: string; eventId: string; request: RequestEvent;
  status: "pending" | "queued" | "sending" | "accepted" | "done" | "uncertain";
  remoteTaskId?: string; lastResult?: string; error?: string; approved?: boolean;
}
interface Outbox { room: string; type: string; content: object; status: "queued" | "sent"; attempts: number; nextAt: number; error?: string; }
interface Binding { remoteTaskId: string; remoteContextId: string; }

export class MatrixConnector {
  private running = false;
  private busy = false;
  private flushing = false;
  private loops: Promise<void>[] = [];
  private leaseOwner = randomUUID();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  lastSyncAt = 0;
  lastError = "";
  constructor(readonly userId: string, readonly store: ConnectorStore, readonly transport: MatrixTransport,
    readonly backend: ExecutionBackend | undefined, readonly pollMs = 1_000) { mxid.parse(userId); }

  contact(address: string): Contact | undefined { return this.store.get("contacts", address); }
  setContact(contact: Contact): void { mxid.parse(contact.address); this.store.set("contacts", contact.address, contact); }
  contacts(): Contact[] { return this.store.entries<Contact>("contacts").map((r) => r.value); }
  pending(): Incoming[] { return this.store.entries<Incoming>("incoming").map((r) => r.value).filter((r) => r.status === "pending" || r.status === "uncertain"); }
  task(id: string): Task | undefined { return this.store.get<Task>("tasks", id); }
  tasks(): Task[] { return this.store.entries<Task>("tasks").map((r) => r.value); }
  taskTarget(id: string): string | undefined { return this.store.get<string>("task_targets", id); }

  async start(): Promise<void> {
    if (await this.transport.identity() !== this.userId) throw new Error("matrix_token_identity_mismatch");
    this.store.acquireLease(this.leaseOwner);
    // A crash while the execution endpoint was accepting work has an ambiguous outcome.
    // Do not replay it automatically without an accepted destination task ID.
    for (const { id, value } of this.store.entries<Incoming>("incoming")) {
      if (value.status === "sending") this.store.set("incoming", id, { ...value, status: "uncertain", error: "acceptance_unknown_after_restart" });
    }
    this.running = true;
    this.heartbeat = setInterval(() => {
      try { this.store.acquireLease(this.leaseOwner); }
      catch { this.running = false; this.lastError = "connector_lease_lost"; this.transport.stop(); }
    }, 5_000);
    this.loops = [this.syncLoop(), this.workerLoop()];
  }
  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.heartbeat);
    this.transport.stop();
    await Promise.allSettled(this.loops);
    this.store.releaseLease(this.leaseOwner);
  }
  private async syncLoop(): Promise<void> {
    while (this.running) {
      try {
        const batch = await this.transport.sync(this.store.get<string>("meta", "sync"), 20_000);
        await this.acceptSync(batch);
        this.lastSyncAt = Date.now(); this.lastError = "";
      } catch (error) { if (this.running) { this.lastError = errorCode(error); await delay(1_000); } }
    }
  }
  private async workerLoop(): Promise<void> {
    while (this.running) {
      try { this.store.acquireLease(this.leaseOwner); await this.flush(); await this.work(); }
      catch (error) { this.lastError = errorCode(error); }
      if (this.running) await delay(Math.min(this.pollMs, 1_000));
    }
  }

  async acceptSync(batch: SyncBatch): Promise<void> {
    if (!batch.next_batch) throw new Error("matrix_sync_checkpoint_missing");
    const prepared: Array<{ room: string; events: RoomEvent[]; encrypted: boolean }> = [];
    for (const [room, joined] of Object.entries(batch.rooms?.join ?? {})) {
      const timeline = joined.timeline;
      const state = await this.transport.state(room);
      const encrypted = state.some((e) => e.type === "m.room.encryption");
      let events = timeline?.events ?? [];
      if (timeline?.limited && timeline.prev_batch) {
        const older: RoomEvent[] = [];
        let from: string | undefined = timeline.prev_batch;
        let finished = false;
        for (let pages = 0; pages < 500; pages++) {
          const page = await this.transport.history(room, from);
          for (const event of page.events) {
            if (this.store.get("seen", key(room, event.event_id))) { finished = true; break; }
            older.push(event);
          }
          if (finished || !page.end || !page.events.length || page.end === from) { finished = true; break; }
          from = page.end;
        }
        if (!finished) throw new Error("matrix_history_gap_exceeds_recovery_limit");
        events = [...older.reverse(), ...events];
      }
      prepared.push({ room, events, encrypted });
    }
    this.store.transaction(() => {
      for (const [room, invite] of Object.entries(batch.rooms?.invite ?? {})) {
        const event = invite.invite_state.events.find((e) => e.type === "m.room.member" && e.state_key === this.userId);
        if (event) this.store.set("invites", room, { room, sender: event.sender });
      }
      for (const item of prepared) {
        this.store.set("rooms", item.room, { encrypted: item.encrypted });
        this.store.delete("invites", item.room);
        for (const event of item.events) this.ingest(item.room, event, item.encrypted);
      }
      this.store.set("meta", "sync", batch.next_batch);
    });
    for (const { id, value } of this.store.entries<{ sender: string }>("invites")) {
      if (this.contact(value.sender)?.receive === "allow") await this.transport.join(id);
    }
  }

  ingest(room: string, event: RoomEvent, encrypted = false): void {
    if (!event.event_id || !event.sender || !this.store.insert("seen", key(room, event.event_id), true)) return;
    if (encrypted || event.sender === this.userId) return;
    try {
      sized(event.content);
      if (event.type === REQUEST_EVENT) {
        const request = requestSchema.parse(event.content);
        if (request.recipient !== this.userId) return;
        if (request.operation === "send") {
          const message = decodeRequest(request.body).message!;
          if ((message.contextId && message.contextId !== request.contextId) || (message.taskId && message.taskId !== request.taskId)) {
            throw new Error("envelope_message_scope_mismatch");
          }
        }
        const id = key(room, event.sender, request.requestId);
        const existing = this.store.get<Incoming>("incoming", id);
        if (existing) {
          if (digest(existing.request) !== digest(request)) throw new Error("request_id_reused_with_different_payload");
          return;
        }
        const permission = this.contact(event.sender)?.receive === "deny" ? "deny" : this.contact(event.sender)?.execution ?? "ask";
        const record: Incoming = { id, room, sender: event.sender, eventId: event.event_id, request,
          status: permission === "allow" || request.operation === "cancel" ? "queued" : "pending" };
        this.store.set("incoming", id, record);
        if (permission === "deny" && request.operation === "send") this.reject(record, "sender_blocked");
      } else if (event.type === RESPONSE_EVENT) {
        const response = responseSchema.parse(event.content);
        const outgoing = this.store.get<Outgoing>("outgoing", response.requestId);
        if (!outgoing || response.recipient !== this.userId || outgoing.target !== event.sender || outgoing.room !== room ||
          outgoing.taskId !== response.taskId) throw new Error("response_identity_or_correlation_mismatch");
        this.applyResponse(outgoing, response);
      }
    } catch (error) {
      this.store.set("protocol_errors", key(room, event.event_id), { code: errorCode(error) });
    }
  }

  async conversation(target: string, contextId?: string): Promise<Conversation> {
    mxid.parse(target);
    if (target === this.userId) throw new Error("self_address_not_supported");
    if (contextId) {
      const conversation = this.store.get<Conversation>("conversations", contextId);
      if (!conversation || conversation.peer !== target) throw new Error("conversation_not_found_for_target");
      return conversation;
    }
    const id = randomUUID();
    const room = await this.transport.createRoom(target);
    const conversation = { id, room, peer: target };
    this.store.set("conversations", id, conversation);
    return conversation;
  }

  enqueue(target: string, conversation: Conversation, task: Task, request: SendMessageRequest, operation: "send" | "cancel"): Outgoing {
    const requestId = randomUUID();
    const body = operation === "send" ? SendMessageRequest.toJSON(request) : {};
    const envelope = sized(requestSchema.parse({ version: 1, requestId, recipient: target,
      taskId: task.id, contextId: conversation.id, operation, body }));
    const outgoing: Outgoing = { id: requestId, target, room: conversation.room, taskId: task.id,
      contextId: conversation.id, request: envelope, status: "queued" };
    this.store.set("outgoing", requestId, outgoing);
    this.store.set("tasks", task.id, task);
    this.store.set("task_targets", task.id, target);
    this.queue(requestId, conversation.room, REQUEST_EVENT, envelope);
    return outgoing;
  }
  private queue(id: string, room: string, type: string, content: object): void {
    sized(content);
    this.store.insert("outbox", id, { room, type, content, status: "queued", attempts: 0, nextAt: 0 } satisfies Outbox);
  }
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const { id, value } of this.store.entries<Outbox>("outbox")) {
        if (value.status !== "queued" || value.nextAt > Date.now()) continue;
        try {
          const state = await this.transport.state(value.room);
          if (state.some((e) => e.type === "m.room.encryption")) {
            throw new Error("encrypted_room_requires_crypto_connector");
          }
          const recipient = (value.content as { recipient?: string }).recipient;
          if (!state.some((e) => e.type === "m.room.member" && e.state_key === recipient && e.content.membership === "join")) {
            // A concurrent remote join can leave an event on a DAG branch preceding that server's
            // membership. Wait for persisted membership before publishing the first request.
            this.store.set("outbox", id, { ...value, nextAt: Date.now() + 1_000, error: "waiting_for_recipient_join" });
            continue;
          }
          await this.transport.send(value.room, value.type, value.content, digest(id));
          this.store.set("outbox", id, { ...value, status: "sent" });
        } catch (error) {
          const attempts = value.attempts + 1;
          this.store.set("outbox", id, { ...value, attempts, error: errorCode(error), nextAt: Date.now() + Math.min(30_000, 500 * 2 ** Math.min(attempts, 6)) });
        }
      }
    } finally { this.flushing = false; }
  }

  approve(id: string): void {
    const record = this.store.get<Incoming>("incoming", id);
    if (!record || record.status !== "pending") throw new Error("pending_request_not_found");
    this.store.set("incoming", id, { ...record, status: "queued", approved: true });
  }
  deny(id: string): void {
    const record = this.store.get<Incoming>("incoming", id);
    if (!record || record.status !== "pending") throw new Error("pending_request_not_found");
    this.store.transaction(() => this.reject(record, "request_rejected"));
  }
  private reject(record: Incoming, code: string): void {
    this.reply(record, undefined, { code, message: code });
    this.store.set("incoming", record.id, { ...record, status: "done", error: code });
  }
  private bindingKey(record: Incoming): string { return key(record.room, record.sender, record.request.taskId); }
  private contextKey(record: Incoming): string { return key(record.room, record.sender, record.request.contextId); }
  async work(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const records = this.store.entries<Incoming>("incoming").map((r) => r.value);
      // A cancellation delivered before its original send prevents execution, including after a restart.
      for (const record of records.filter((r) => r.status === "queued" && r.request.operation === "cancel")) await this.cancel(record);
      for (const record of records.filter((r) => r.status === "queued" && r.request.operation === "send")) {
        const current = this.store.get<Incoming>("incoming", record.id);
        if (current?.status === "queued") await this.execute(current);
      }
      for (const { value } of this.store.entries<Incoming>("incoming")) {
        if (value.status !== "accepted" || !value.remoteTaskId || !this.backend) continue;
        try { this.acceptResult(value, await this.backend.get(value.remoteTaskId)); }
        catch (error) { this.lastError = errorCode(error); }
      }
    } finally { this.busy = false; }
  }
  private async execute(record: Incoming): Promise<void> {
    if (this.store.get("cancellations", this.bindingKey(record))) { this.cancelBeforeExecution(record); return; }
    if (!this.backend) { this.reject(record, "execution_backend_not_configured"); return; }
    if (this.contact(record.sender)?.execution === "deny" || this.contact(record.sender)?.receive === "deny") { this.reject(record, "sender_blocked"); return; }
    if (!record.approved && this.contact(record.sender)?.execution !== "allow") {
      this.store.set("incoming", record.id, { ...record, status: "pending" }); return;
    }
    const request = decodeRequest(record.request.body);
    const message = request.message!;
    const binding = this.store.get<Binding>("bindings", this.bindingKey(record));
    if (message.taskId && !binding) { this.reject(record, "destination_task_mapping_not_found"); return; }
    const remoteContext = this.store.get<string>("contexts", this.contextKey(record));
    message.taskId = message.taskId ? binding!.remoteTaskId : "";
    message.contextId = remoteContext ?? "";
    message.messageId = digest(key(record.room, record.sender, message.messageId));
    message.referenceTaskIds = message.referenceTaskIds.map((id) => this.store.get<Binding>("bindings", key(record.room, record.sender, id))?.remoteTaskId)
      .filter((id): id is string => Boolean(id));
    request.configuration = { acceptedOutputModes: request.configuration?.acceptedOutputModes ?? [],
      returnImmediately: true, historyLength: 20, taskPushNotificationConfig: undefined };
    this.store.set("incoming", record.id, { ...record, status: "sending" });
    try { this.acceptResult(record, await this.backend.send(request)); }
    catch (error) {
      // A lost acceptance response can have already caused external side effects.
      this.store.set("incoming", record.id, { ...record, status: "uncertain", error: errorCode(error) });
      this.reply(record, undefined, { code: "acceptance_unknown", message: "Execution acceptance is unknown; automatic resending is disabled." });
    }
  }
  private acceptResult(record: Incoming, result: SendMessageResult): void {
    const encoded = encodeResult(result);
    const resultHash = digest(encoded);
    if (record.lastResult === resultHash) return;
    this.store.transaction(() => {
      if (result.contextId) this.store.set("contexts", this.contextKey(record), result.contextId);
      if (!("messageId" in result)) this.store.set("bindings", this.bindingKey(record), { remoteTaskId: result.id, remoteContextId: result.contextId });
      // Receipt of an oversized result is still proof of backend acceptance. Keep that binding;
      // do not misclassify a delivery-size failure as an unknown execution and never rerun work.
      try { sized({ result: encoded, requestId: record.request.requestId, recipient: record.sender, taskId: record.request.taskId, sequence: 1, version: 1 });
        this.reply(record, result);
      } catch (error) {
        if (errorCode(error) !== "matrix_event_too_large_use_file_reference") throw error;
        this.reply(record, undefined, { code: "result_too_large", message: "Execution was accepted, but its result exceeds the Matrix profile limit. Use file references for large output." });
      }
      this.store.set("incoming", record.id, { ...record, status: "messageId" in result || terminal(result) ? "done" : "accepted",
        ...("messageId" in result ? {} : { remoteTaskId: result.id }), lastResult: resultHash });
    });
  }
  private reply(record: Incoming, result?: SendMessageResult, error?: { code: string; message: string }): void {
    const scope = this.bindingKey(record);
    const sequence = (this.store.get<number>("sequences", scope) ?? 0) + 1;
    this.store.set("sequences", scope, sequence);
    const content: ResponseEvent = { version: 1, recipient: record.sender, requestId: record.request.requestId,
      taskId: record.request.taskId, sequence, ...(result ? { result: encodeResult(result) } : {}), ...(error ? { error } : {}) };
    this.queue(key(record.request.requestId, String(sequence)), record.room, RESPONSE_EVENT, content);
  }
  private async cancel(record: Incoming): Promise<void> {
    this.store.set("cancellations", this.bindingKey(record), true);
    const binding = this.store.get<Binding>("bindings", this.bindingKey(record));
    if (!binding) {
      const ambiguous = this.store.entries<Incoming>("incoming").some(({ value }) =>
        this.bindingKey(value) === this.bindingKey(record) && ["sending", "uncertain"].includes(value.status));
      if (ambiguous) {
        this.reject(record, "cancellation_acceptance_unknown"); return;
      }
      this.store.transaction(() => {
        for (const { value } of this.store.entries<Incoming>("incoming")) {
          if (value.request.operation === "send" && ["pending", "queued"].includes(value.status) && this.bindingKey(value) === this.bindingKey(record)) {
            this.cancelBeforeExecution(value);
          }
        }
        this.cancelBeforeExecution(record);
      });
      return;
    }
    try {
      if (!this.backend) throw new Error("execution_backend_not_configured");
      const result = await this.backend.cancel(binding.remoteTaskId);
      this.acceptResult(record, result);
    } catch {
      this.reply(record, undefined, { code: "task_not_cancelable", message: "Destination could not confirm cancellation." });
      this.store.set("incoming", record.id, { ...record, status: "done" });
    }
  }
  private cancelBeforeExecution(record: Incoming): void {
    const result = newTask(record.request.taskId, record.request.contextId, Message.fromJSON({}));
    result.history = [];
    result.status = { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined };
    this.reply(record, result);
    this.store.set("incoming", record.id, { ...record, status: "done" });
  }
  private applyResponse(outgoing: Outgoing, response: ResponseEvent): void {
    const last = this.store.get<number>("received_sequences", outgoing.taskId) ?? 0;
    if (response.sequence <= last) return;
    const task = this.task(outgoing.taskId);
    if (!task) throw new Error("response_task_missing");
    const decoded = response.result ? decodeResult(response.result) : undefined;
    this.store.set("received_sequences", task.id, response.sequence);
    if (response.error) {
      this.store.set("outgoing", outgoing.id, { ...outgoing, status: "done", error: response.error.code });
      if (outgoing.request.operation === "cancel" || terminal(task)) return;
      task.status = { state: response.error.code === "request_rejected" || response.error.code === "sender_blocked"
        ? TaskState.TASK_STATE_REJECTED : TaskState.TASK_STATE_FAILED,
      timestamp: new Date().toISOString(), message: statusMessage(task, response.error.message) };
    } else {
      const result = decoded!;
      this.store.set("outgoing", outgoing.id, { ...outgoing, status: "messageId" in result || terminal(result) ? "done" : "received" });
      if (terminal(task)) return;
      const remap = (message: Message): Message => ({ ...message, taskId: task.id, contextId: task.contextId,
        messageId: this.store.get<string>("message_origins", message.messageId) ?? message.messageId });
      if ("messageId" in result) {
        task.status = { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: remap(result) };
        task.history.push(remap(result));
      } else {
        task.status = result.status ? { ...result.status, message: result.status.message ? remap(result.status.message) : undefined } : undefined;
        task.artifacts = result.artifacts;
        task.history = [...new Map([...task.history, ...result.history.map(remap)].map((m) => [m.messageId, m])).values()];
      }
    }
    this.store.set("tasks", task.id, task);
  }
}
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function errorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message)) return error.message;
  return error instanceof Error ? error.name : "operation_failed";
}
