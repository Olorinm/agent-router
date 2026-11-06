import { bindAccount, type ChannelAdapter, type ChannelContext, type ChannelMessage, type ReplyRoute } from "../communication/types.js";
import type { CommunicationCore, InboxRecord } from "../communication/core.js";
import { digest } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import type { AgentLedger, LedgerEvent } from "../ledger/ledger.js";

/** The connection id of the web channel on every agent's channel core (ADR 0005 phase 3). */
export const WEB_CONNECTION = "web";
/** The web channel's account is the owner (ADR 4.1 `account_id`: ownerKey for web). */
export const webAccount = (ownerId: string) => digest(ownerId);
export const webTarget = (personId: string) => `person:${personId}`;
export interface WebSendInput { personId: string; idempotencyKey: string; text: string; replyTo?: string | undefined }
export interface WebSendResult { duplicate: boolean; event: LedgerEvent; inputState: string | null }

/**
 * Owner web messages as a channel adapter. A web message enters the same ingress → claim → pending input → turn
 * path as every other channel, in the owner-main session. Its delivery is the ledger event itself, so `send` is
 * never reached for a recorded reply (the core settles web outbox rows when they are recorded).
 */
export class WebChannel implements ChannelAdapter {
  readonly kind = "web";
  readonly retrySafe = true;
  readonly capabilities = { receive: ["text", "quote", "redaction"], send: ["text"], stream: false, buttons: false, native: [] };
  private context: ChannelContext | undefined;
  constructor(readonly core: CommunicationCore, readonly ownerId: string) {}
  async start(context: ChannelContext): Promise<void> { bindAccount(context, webAccount(this.ownerId)); this.context = context; }
  async stop(): Promise<void> { this.context = undefined; }
  async send(_route: ReplyRoute, _text: string, sendKey: string) { return { externalId: sendKey }; }
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
  /** `POST …/messages`. The idempotency key scopes the claim per person; the same key and body return the stored event. */
  submit(input: WebSendInput): WebSendResult {
    const ledger = this.ledger(), externalId = `${input.personId}:${input.idempotencyKey}`;
    const duplicate = Boolean(ledger.claimFor(WEB_CONNECTION, externalId));
    // The body is a pure function of the request, so the claim hash compares request bodies.
    const record = this.receive(this.message(input.personId, externalId, { text: input.text, ...(input.replyTo ? { quoted: { messageId: input.replyTo } } : {}) }));
    const claim = ledger.claimFor(WEB_CONNECTION, externalId), event = claim?.eventId ? ledger.event(claim.eventId) : undefined;
    if (!event) throw new WorkError(record.reason === "input_too_large" ? "message_too_large" : "message_not_recorded", record.reason === "input_too_large" ? 413 : 409);
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
    let dropped = false;
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
      ledger.redactBody(eventId);
    });
    const event = ledger.eventByKey(sessionKey, `${WEB_CONNECTION}:${externalId}`);
    if (!event) throw new WorkError("redaction_not_recorded", 409);
    return { duplicate, event, dropped };
  }
}
