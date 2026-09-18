import { z } from "zod";
import { ChannelError, type ChannelAdapter, type ChannelMessage } from "./types.js";

const attachmentSchema = z.object({ filename: z.string().max(1000).optional(), attachment_id: z.string(), size: z.number().optional() });
const mailSchema = z.object({
  inbox_id: z.string(), message_id: z.string().max(1024), thread_id: z.string().max(1024),
  from: z.string().max(1000), labels: z.array(z.string()), created_at: z.string().datetime(),
  to: z.array(z.string()).default([]), subject: z.string().max(2000).optional(),
  extracted_text: z.string().optional(), text: z.string().optional(), html: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}), attachments: z.array(attachmentSchema).default([]),
  authentication_results: z.object({ dmarc: z.string().optional() }).nullish(),
});
const pageSchema = z.object({ messages: z.array(mailSchema), next_page_token: z.string().nullish() });
const replySchema = z.object({ message_id: z.string(), thread_id: z.string() });
export function mailbox(value: string): string | undefined {
  const raw = value.trim();
  const address = raw.includes("<") ? /^[^<>\r\n]*<([^<>\r\n]+)>$/.exec(raw)?.[1] : raw;
  if (!address || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(address)) return undefined;
  return address.toLowerCase();
}

/** AgentMail owns mail transport and domain screening, not Router permissions. */
export class AgentMailAdapter implements ChannelAdapter {
  private readonly lifetime = new AbortController();
  close(): void { this.lifetime.abort(); }
  constructor(private readonly options: {
    inbox: string; apiKey: string; known?: (messageId: string) => boolean; fetch?: typeof fetch;
  }) {
    if (mailbox(options.inbox) !== options.inbox) throw new Error("agentmail_inbox_must_be_canonical_address");
    if (!options.apiKey || /\s/.test(options.apiKey)) throw new Error("agentmail_api_key_invalid");
  }
  private async request(path: string, body?: unknown, deliveryId?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(this.options.inbox)}/${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]),
        headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(deliveryId ? { "Idempotency-Key": deliveryId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new ChannelError("agentmail_network_error"); }
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get("retry-after");
      const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 60_000;
      throw new ChannelError(`agentmail_http_${response.status}`, response.status >= 400 && response.status < 500 && response.status !== 429,
        Number.isFinite(delay) ? Math.max(1000, Math.min(delay, 3_600_000)) : 60_000);
    }
    // Bound remote data without loading an arbitrary response in memory.
    const reader = response.body?.getReader();
    if (!reader) throw new ChannelError("agentmail_empty_response", true);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 2_000_000) { await reader.cancel(); throw new ChannelError("agentmail_response_too_large", true); }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new ChannelError("agentmail_invalid_response", true); }
  }
  async poll(cursor: string | undefined, startedAt: string) {
    const query = new URLSearchParams({ limit: "100", ascending: "true", labels: "received",
      include_spam: "false", include_blocked: "false", include_unauthenticated: "false", include_trash: "false" });
    if (cursor) query.set("page_token", cursor);
    const parsed = pageSchema.safeParse(await this.request(`messages?${query}`));
    if (!parsed.success) throw new ChannelError("agentmail_invalid_page", true);
    const messages: ChannelMessage[] = [];
    for (const summary of parsed.data.messages) {
      // Scan every page, using server-created time rather than the sender's Date
      // header to avoid executing old mail or losing delayed/backdated mail.
      if (summary.inbox_id !== this.options.inbox) throw new ChannelError("agentmail_inbox_mismatch", true);
      if (Date.parse(summary.created_at) < Date.parse(startedAt) || this.options.known?.(summary.message_id)) continue;
      const detail = mailSchema.safeParse(await this.request(`messages/${encodeURIComponent(summary.message_id)}`));
      if (!detail.success) throw new ChannelError("agentmail_invalid_message", true);
      const mail = detail.data;
      if (mail.inbox_id !== this.options.inbox || mail.message_id !== summary.message_id) throw new ChannelError("agentmail_message_mismatch", true);
      if (!mail.labels.includes("received") || mail.labels.some(l => ["sent", "draft", "spam", "blocked", "unauthenticated", "trash"].includes(l))) continue;
      const sender = mailbox(mail.from);
      if (!sender || sender === this.options.inbox) continue;
      const headers = Object.fromEntries(Object.entries(mail.headers).map(([name, value]) => [name.toLowerCase(), value.toLowerCase()]));
      if ((headers["auto-submitted"] && headers["auto-submitted"] !== "no") || headers["x-agent-router-entry"] ||
        ["bulk", "junk", "list"].includes(headers["precedence"] ?? "")) continue;
      const body = mail.extracted_text?.trim() || mail.text?.trim();
      const attachments = mail.attachments.length ? `\n\n[附件尚未读取，只列出文件名：${mail.attachments.map(a => a.filename ?? a.attachment_id).join("；")}]` : "";
      const text = `邮件主题：${mail.subject ?? "（无主题）"}\n发件人：${sender}\n\n${body ?? "[邮件没有可读取的纯文本正文，请回复要求发送文字内容。]"}${attachments}`;
      messages.push({ id: mail.message_id, conversation: mail.thread_id, subject: sender, subjectDomain: sender.split("@")[1]!,
        // Use the receiver's structured result. An Authentication-Results header
        // in the message body/headers cannot assert trust. DMARC validates the
        // sender domain, not the person's real-world or cross-channel identity.
        authentication: mail.authentication_results?.dmarc === "pass" ? "provider-screened" : "unverified", receivedAt: mail.created_at,
        text: text.length > 22000 ? `${text.slice(0, 22000)}\n[邮件过长，内容已截断；请要求发件人拆分后继续。]` : text });
    }
    const next = parsed.data.next_page_token ?? "";
    if (next && next === cursor) throw new ChannelError("agentmail_repeated_page_cursor", true);
    return { messages: messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)), cursor: next, more: Boolean(next) };
  }
  async reply(message: ChannelMessage, text: string, deliveryId: string): Promise<string> {
    if (mailbox(message.subject) !== message.subject) throw new ChannelError("agentmail_invalid_recipient", true);
    const result = replySchema.safeParse(await this.request(`messages/${encodeURIComponent(message.id)}/reply`, {
      to: [message.subject], cc: [], bcc: [], reply_all: false, text,
      headers: { "Auto-Submitted": "auto-replied", "X-Agent-Router-Entry": "agentmail" },
    }, deliveryId));
    if (!result.success) throw new ChannelError("agentmail_invalid_reply_receipt", true);
    if (result.data.thread_id !== message.conversation) throw new ChannelError("agentmail_reply_thread_mismatch", true);
    return result.data.message_id;
  }
}
