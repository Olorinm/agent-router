import { ChannelHttpError, ServiceHttp } from "./http.js";
import { setTimeout as sleep } from "node:timers/promises";
import { PollingChannel } from "./polling.js";
import { bindAccount, ChannelSendError, type ChannelAdapter, type ReplyRoute } from "../communication/types.js";

interface MailEvent { sequence: number; inbox_id: string; event_id: string; type: string; created_at: string; data: { message?: Record<string, any> }; }
export class GroveMailChannel extends PollingChannel implements ChannelAdapter {
  readonly kind = "grove-mail";
  readonly retrySafe = true;
  private readonly path: string;
  constructor(readonly inboxId: string, readonly http: ServiceHttp, private readonly initialCursor = 0) {
    super(); this.path = `/v0/inboxes/${encodeURIComponent(inboxId)}`;
  }
  protected async initialize(): Promise<void> {
    await this.http.request(this.path);
    bindAccount(this.context, `${new URL(this.http.baseUrl).origin}/${this.inboxId}`);
    if (!this.context.checkpoint("activation")) this.context.checkpoint("activation", new Date().toISOString());
  }
  protected async poll(signal: AbortSignal): Promise<void> {
    const cursor = this.context.checkpoint<number>("cursor") ?? this.initialCursor;
    const page = await this.http.request(`${this.path}/events/lifecycle?after=${cursor}&limit=100`, { signal });
    if (!Array.isArray(page.events) || !Number.isSafeInteger(page.next_cursor) || page.next_cursor < cursor) throw new Error("invalid_mail_event_page");
    const activation = this.context.checkpoint<string>("activation")!;
    let sequence = cursor;
    for (const event of page.events as MailEvent[]) {
      if (event.inbox_id !== this.inboxId || !Number.isSafeInteger(event.sequence) || event.sequence <= sequence || event.sequence > page.next_cursor) throw new Error("mail_event_scope_mismatch");
      sequence = event.sequence;
      if (event.type !== "message.received" || event.created_at < activation) continue;
      const message = event.data?.message;
      if (!message || message.inbox_id !== this.inboxId || typeof message.message_id !== "string" || typeof message.from !== "string") throw new Error("invalid_mail_message");
      const bracket = message.from.match(/<([^<>]+)>\s*$/);
      const sender = (bracket?.[1] ?? message.from).trim();
      const text = message.extracted_text ?? message.text ?? "";
      const recipients = [...(message.to ?? []), ...(message.cc ?? [])].map((item: string | { address: string }) =>
        (typeof item === "string" ? item : item.address).trim().toLowerCase());
      const group = new Set(recipients).size > 1;
      const threadId = message.thread_id || message.message_id;
      this.context.receive({ externalId: event.event_id, sender, threadId: message.thread_id || message.message_id,
        scope: group ? "group" : "direct", ...(group ? { groupId: threadId } : {}), text: `${message.subject ? `主题：${message.subject}\n\n` : ""}${text}`,
        reply: { target: this.inboxId, messageId: message.message_id, data: {} },
      });
    }
    // Every row in this scoped page is now either persisted or deliberately ignored.
    this.context.checkpoint("cursor", page.next_cursor);
    if (!page.events.length) await sleep(1000, undefined, { signal });
  }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    if (route.target !== this.inboxId) throw new ChannelSendError("failed", "mail_reply_scope_mismatch");
    try {
      const result = await this.http.request(`${this.path}/messages/${encodeURIComponent(route.messageId)}/reply`, {
        body: { text }, headers: { "idempotency-key": sendKey },
      });
      if (result.status !== "accepted" || typeof result.message_id !== "string") throw new ChannelSendError("uncertain", "mail_submission_unknown");
      return { externalId: result.message_id };
    } catch (error) {
      if (error instanceof ChannelSendError) throw error;
      if (error instanceof ChannelHttpError) {
        if (error.code === "send_uncertain") throw new ChannelSendError("uncertain", "mail_submission_unknown");
        if ([400, 401, 403, 404, 409, 422].includes(error.status)) throw new ChannelSendError("failed", error.code);
      }
      // Grove Mail durably associates this key with one SMTP attempt, including uncertain outcomes.
      throw new ChannelSendError("retry", "mail_send_retry");
    }
  }
}
