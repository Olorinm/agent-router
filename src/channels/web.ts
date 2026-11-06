import { bindAccount, type AttachmentReference, type ChannelAdapter, type ChannelContent, type ChannelContext, type ChannelMessage, type MediaContent,
  type RecordedAttachment, type RecordedMedia, type ReplyRoute } from "../communication/types.js";
import type { CommunicationCore, InboxRecord } from "../communication/core.js";
import { digest } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import type { AgentLedger, LedgerEvent } from "../ledger/ledger.js";
import type { OwnerAttachments } from "../ledger/blobs-hub.js";

/** The connection id of the web channel on every agent's channel core (ADR 0005 phase 3). */
export const WEB_CONNECTION = "web";
/** The web channel's account is the owner (ADR 4.1 `account_id`: ownerKey for web). */
export const webAccount = (ownerId: string) => digest(ownerId);
export const webTarget = (personId: string) => `person:${personId}`;
export interface WebSendInput { personId: string; idempotencyKey: string; text: string; replyTo?: string | undefined; attachments?: string[] | undefined }
export interface WebSendResult { duplicate: boolean; event: LedgerEvent; inputState: string | null }

/**
 * Owner web messages as a channel adapter. A web message enters the same ingress → claim → pending input → turn
 * path as every other channel, in the owner-main session. Its delivery is the ledger event itself, so `send` is
 * never reached for a recorded reply (the core settles web outbox rows when they are recorded).
 */
export class WebChannel implements ChannelAdapter {
  readonly kind = "web";
  readonly retrySafe = true;
  readonly capabilities: { receive: string[]; send: string[]; stream: boolean; buttons: boolean; native: string[] };
  /** Agent outbound media (ADR 0005 16.5): stored under the owner's prefix and attached to the content event. */
  readonly recordedMedia: RecordedMedia | undefined;
  private context: ChannelContext | undefined;
  /** `attachments` is the owner's blob service while the `attachments` feature is on. */
  constructor(readonly core: CommunicationCore, readonly ownerId: string, readonly attachments?: OwnerAttachments | undefined) {
    const files = attachments ? ["file", "image", "audio", "video"] : [];
    this.capabilities = { receive: ["text", "quote", "redaction", ...files], send: ["text", ...files], stream: false, buttons: false, native: [] };
    const target = { agentId: core.agentId };
    this.recordedMedia = attachments && {
      store: async (media) => { const items: RecordedAttachment[] = [];
        try { for (const item of media) items.push(await attachments.storeMedia(ownerId, target, item)); }
        catch (error) { attachments.releaseAgent(ownerId, core.agentId, items.map((entry) => entry.attachmentId)); throw error; }
        return items; },
      bind: (ledger, eventId, items) => attachments.writeLedger(ledger, items, eventId),
      release: (items) => attachments.releaseAgent(ownerId, core.agentId, items.map((item) => item.attachmentId)),
    };
  }
  async start(context: ChannelContext): Promise<void> { bindAccount(context, webAccount(this.ownerId)); this.context = context; }
  async stop(): Promise<void> { this.context = undefined; }
  async send(_route: ReplyRoute, _text: string, sendKey: string) { return { externalId: sendKey }; }
  /** Never reached for a recorded event (the core settles web rows when they are recorded); present so content is accepted. */
  async sendContent(_route: ReplyRoute, _content: ChannelContent, sendKey: string) { return { externalId: sendKey }; }
  /** The model reads web attachments from the blob store, like channel media (cap `MAX_MEDIA_BYTES`). */
  async readAttachment(_message: ChannelMessage, attachment: AttachmentReference): Promise<MediaContent> {
    const sha256 = attachment.data?.sha256;
    if (!this.attachments || typeof sha256 !== "string") throw new Error("channel_attachment_read_unsupported");
    return this.attachments.readMedia(this.ownerId, { name: attachment.name, contentType: attachment.mediaType, sha256 });
  }
  private ledger(): AgentLedger {
    if (!this.context) throw new WorkError("web_channel_unavailable", 503);
    const ledger = this.core.ledger;
    if (!ledger?.authoritative) throw new WorkError("agent_ledger_unavailable", 503);
    return ledger;
  }
  private message(personId: string, externalId: string, fields: Partial<ChannelMessage> & Pick<ChannelMessage, "text">): ChannelMessage {
    return { externalId, sender: personId, threadId: webTarget(personId), scope: "direct", reply: { target: webTarget(personId), messageId: externalId, data: {} }, ...fields };
  }
  private receive(message: ChannelMessage): InboxRecord {
    try { return this.core.receive(WEB_CONNECTION, message); }
    catch (error) {
      // Matrix txnId semantics: the same key with a different body is a conflict, never a second message.
      if (error instanceof Error && error.message === "channel_event_id_reused_with_different_payload") throw new WorkError("idempotency_key_reused", 409);
      throw error;
    }
  }
  /**
   * `POST …/messages`. The idempotency key scopes the claim per person; the same key and body return the stored event.
   * Attachments (ADR 0005 16.5 send binding): reserve the caller's uploads, record the message and its `ledger_attachments`
   * rows in one transaction, then mark the uploads bound; a failed send drops the pins and leaves the uploads sendable.
   */
  submit(input: WebSendInput): WebSendResult {
    const ledger = this.ledger(), externalId = `${input.personId}:${input.idempotencyKey}`, ids = input.attachments ?? [];
    if (ids.length && !this.attachments) throw new WorkError("attachments_unsupported", 422);
    const claimed = ledger.claimFor(WEB_CONNECTION, externalId), duplicate = Boolean(claimed);
    const owner = { ownerId: this.ownerId, personId: input.personId }, target = { agentId: this.core.agentId };
    let references: AttachmentReference[] = [], reserved: RecordedAttachment[] = [];
    if (duplicate) {
      // A retry: the uploads are bound by the first send. The same ids reuse its references, so the claim hash compares
      // the request; other ids can only be a conflict.
      const stored = claimed?.inputId ? this.core.store.get<InboxRecord>("communication_inbox", claimed.inputId)?.source.attachments ?? [] : [];
      if (stored.map((item) => item.id).join(",") !== ids.join(",")) throw new WorkError("idempotency_key_reused", 409);
      references = stored;
    } else if (ids.length) {
      reserved = this.attachments!.reserve(owner, ids, target);
      references = reserved.map((item) => ({ id: item.attachmentId, name: item.name, mediaType: item.contentType, kind: kindOf(item.contentType),
        data: { sha256: item.sha256, size: item.size } }));
    }
    const message = this.message(input.personId, externalId, { text: input.text, ...(input.replyTo ? { quoted: { messageId: input.replyTo } } : {}),
      ...(references.length ? { attachments: references } : {}) });
    let record: InboxRecord;
    try {
      // The body is a pure function of the request, so the claim hash compares request bodies.
      record = this.core.store.transaction(() => {
        const received = this.receive(message);
        const eventId = ledger.claimFor(WEB_CONNECTION, externalId)?.eventId;
        if (reserved.length && eventId) this.attachments!.writeLedger(ledger, reserved, eventId);
        return received;
      });
    } catch (error) { if (reserved.length) this.attachments!.abort(this.ownerId, ids, target); throw error; }
    const claim = ledger.claimFor(WEB_CONNECTION, externalId), event = claim?.eventId ? ledger.event(claim.eventId) : undefined;
    if (!event) {
      if (reserved.length) this.attachments!.abort(this.ownerId, ids, target);
      throw new WorkError(record.reason === "input_too_large" ? "message_too_large" : "message_not_recorded", record.reason === "input_too_large" ? 413 : 409);
    }
    if (reserved.length) this.attachments!.commit(owner, ids);
    return { duplicate, event, inputState: (ledger.input(record.id)?.state as string | undefined) ?? null };
  }
  /**
   * Redact one of the person's own web messages: a `redaction` event through ingress, the target's content removed
   * from the transcript and the legacy inbox, and its input dropped if no turn has taken it yet. The same key returns
   * the stored redaction; the same key for another target is a conflict; another key for a redacted target returns
   * the existing redaction.
   */
  redact(personId: string, sessionKey: string, eventId: string, idempotencyKey: string): { duplicate: boolean; event: LedgerEvent; dropped: boolean } {
    const ledger = this.ledger(), target = ledger.event(eventId);
    if (!target || target.sessionKey !== sessionKey) throw new WorkError("event_not_found", 404);
    const prefix = `${WEB_CONNECTION}:${personId}:`;
    if (target.kind !== "message" || target.senderType !== "person" || target.senderId !== personId || !target.idempotencyKey?.startsWith(prefix))
      throw new WorkError("redaction_not_allowed", 403);
    const externalId = `${personId}:redact:${idempotencyKey}`;
    const duplicate = Boolean(ledger.claimFor(WEB_CONNECTION, externalId));
    const existing = ledger.references(eventId, "redaction")[0];
    if (!duplicate && existing) return { duplicate: true, event: existing, dropped: false };
    let dropped = false, released: string[] = [];
    this.core.store.transaction(() => {
      this.receive(this.message(personId, externalId, { text: "", event: { type: "message-redaction", data: { redacts: target.idempotencyKey!.slice(WEB_CONNECTION.length + 1) } } }));
      if (duplicate) return;
      const pending = ledger.inputForEvent(eventId), inputId = pending?.input_id as string | undefined;
      const legacy = inputId ? this.core.store.get<InboxRecord>("communication_inbox", inputId) : undefined;
      dropped = pending?.state === "queued";
      if (dropped) ledger.updateInput(inputId!, "dropped", { reason: "redacted" });
      // The stored hash is kept, so a retry of the original send is still recognised as the same message.
      if (legacy) this.core.store.set("communication_inbox", inputId!, { ...legacy, source: { ...legacy.source, text: "" },
        ...(dropped && legacy.state === "received" ? { state: "done", reason: "redacted_before_start" } : {}) } satisfies InboxRecord);
      released = ledger.detachAttachments(eventId);
      ledger.redactBody(eventId);
    });
    // ADR 16.4: the rows lost their event, so their blob references go too (the blob is swept after its grace period).
    if (released.length) this.attachments?.releaseAgent(this.ownerId, this.core.agentId, released);
    const event = ledger.eventByKey(sessionKey, `${WEB_CONNECTION}:${externalId}`);
    if (!event) throw new WorkError("redaction_not_recorded", 409);
    return { duplicate, event, dropped };
  }
}

const kindOf = (type: string): AttachmentReference["kind"] => type.startsWith("image/") ? "image" : type.startsWith("audio/") ? "audio" : type.startsWith("video/") ? "video" : "file";
