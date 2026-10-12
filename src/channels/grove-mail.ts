import { ChannelHttpError, ServiceHttp } from "./http.js";
import { setTimeout as sleep } from "node:timers/promises";
import { PollingChannel } from "./polling.js";
import { bindAccount, ChannelSendError, type ChannelAdapter, type ReplyRoute, type AttachmentReference, type ChannelMessage, type ChannelContent } from "../communication/types.js";

import { download, mediaContent } from "../communication/media.js";

interface MailEvent { sequence: number; inbox_id: string; event_id: string; type: string; created_at: string; data: { message?: Record<string, any> }; }
export class GroveMailChannel extends PollingChannel implements ChannelAdapter {
  readonly kind = "grove-mail";
  readonly retrySafe = true;
  readonly capabilities = { receive: ["text", "html", "file", "image", "audio", "video", "quote"], send: ["text", "html", "file", "image", "audio", "video"], stream: false, buttons: false, native: [] };
  private readonly path: string;
  constructor(readonly inboxId: string, readonly http: ServiceHttp, private readonly initialCursor = 0, private readonly attachmentOrigins: string[] = []) {
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
        scope: group ? "group" : "direct", ...(group ? { groupId: threadId } : {}),
        attachments: (message.attachments ?? []).map((item: any) => ({ id: item.attachment_id, name: item.filename ?? "attachment", mediaType: item.content_type ?? "application/octet-stream", kind: "file" })),
        ...(message.in_reply_to ? { quoted: { messageId: message.in_reply_to } } : {}), native: { subject: message.subject ?? "", html: message.extracted_html ?? message.html ?? "", references: message.references ?? [] }, text: `${message.subject ? `主题：${message.subject}\n\n` : ""}${text}`,
        reply: { target: this.inboxId, messageId: message.message_id, data: {} },
      });
    }
    // Every row in this scoped page is now either persisted or deliberately ignored.
    this.context.checkpoint("cursor", page.next_cursor);
    if (!page.events.length) await sleep(1000, undefined, { signal });
  }
  async readAttachment(message: ChannelMessage, attachment: AttachmentReference) {
    const descriptor = await this.http.request(`${this.path}/messages/${encodeURIComponent(message.reply.messageId)}/attachments/${encodeURIComponent(attachment.id)}`);
    const url = new URL(descriptor.download_url);
    // Grants may use a configured public origin distinct from the internal API. Never forward the API key.
    if (!([new URL(this.http.baseUrl).origin, ...this.attachmentOrigins.map((origin) => new URL(origin).origin)].includes(url.origin)) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("mail_attachment_origin_mismatch");
    return mediaContent(attachment.name, attachment.mediaType, await download(url.href));
  }
  async sendContent(route: ReplyRoute, content: ChannelContent, sendKey: string) {
    return this.reply(route, { text: content.text, ...(content.html ? { html: content.html } : {}), attachments: (content.media ?? []).map((item) => ({ filename: item.name, content_type: item.mediaType, content: item.data })) }, sendKey);
  }
  async send(route: ReplyRoute, text: string, sendKey: string) { return this.reply(route, { text }, sendKey); }
  private async reply(route: ReplyRoute, body: object, sendKey: string) {
    if (route.target !== this.inboxId) throw new ChannelSendError("failed", "mail_reply_scope_mismatch");
    try {
      const result = await this.http.request(`${this.path}/messages/${encodeURIComponent(route.messageId)}/reply`, {
        body, headers: { "idempotency-key": sendKey },
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
