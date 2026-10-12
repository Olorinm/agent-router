import { Bot, GrammyError, InputFile, type Context } from "grammy";
import { PollingChannel } from "./polling.js";
import { ChannelHttpError } from "./http.js";
import { bindAccount, ChannelSendError, sendChunks, type ChannelAdapter, type ReplyRoute, type AttachmentReference, type ChannelMessage, type ChannelContent } from "../communication/types.js";

import { download, mediaContent } from "../communication/media.js";
import { digest } from "../execution/protocol.js";

export class TelegramChannel extends PollingChannel implements ChannelAdapter {
  readonly kind = "telegram";
  readonly retrySafe = false;
  readonly capabilities = { receive: ["text", "image", "file", "audio", "voice", "video", "sticker", "quote", "callback", "reaction", "contact", "location", "poll", "edit", "generation-stop"], send: ["text", "image", "file", "audio", "voice", "video", "sticker", "buttons"], stream: true, buttons: true, native: ["typing", "reaction", "edit", "delete", "location", "contact", "poll", "sticker", "formatted-text"], nativeArguments: { typing: "no args", reaction: "emoji, optional messageId", edit: "text, optional messageId", delete: "optional messageId", location: "latitude, longitude", contact: "phone, name", poll: "question, options: [{text}]", sticker: "fileId", "formatted-text": "text, parseMode: HTML or MarkdownV2" } };
  readonly bot: Bot;
  private listening = false;
  constructor(token: string, bot?: Bot) { super(); this.bot = bot ?? new Bot(token, { client: { timeoutSeconds: 30 } }); }
  protected async initialize(): Promise<void> {
    try { await this.bot.init(AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]) as Parameters<typeof this.bot.init>[0]); }
    catch (error) { throw telegramError(error); }
    try {
      const webhook = await this.bot.api.getWebhookInfo(AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]) as Parameters<typeof this.bot.api.getWebhookInfo>[0]);
      if (webhook.url) throw new ChannelHttpError(409, "telegram_existing_webhook_must_be_removed");
    } catch (error) { throw telegramError(error); }
    bindAccount(this.context, String(this.bot.botInfo.id));
    if (!this.context.checkpoint("activation")) this.context.checkpoint("activation", Math.floor(Date.now() / 1000));
    if (!this.listening) {
      this.bot.on(["message", "edited_message"], (context) => this.receive(context));
      this.bot.on("callback_query:data", async (context) => {
        const callback = context.callbackQuery, message = callback.message;
        if (!message) return;
        const source = this.context.checkpoint<ChannelMessage>(`sent-route:${message.chat.id}:${message.message_id}`) ?? {
          externalId: String(context.update.update_id), sender: String(callback.from.id), threadId: `${message.chat.id}${"message_thread_id" in message && message.message_thread_id ? `:${message.message_thread_id}` : ""}`,
          scope: message.chat.type === "private" ? "direct" as const : "group" as const, ...(message.chat.type !== "private" ? { groupId: String(message.chat.id) } : {}), text: "",
          reply: { target: String(message.chat.id), messageId: String(message.message_id), data: { topic: "message_thread_id" in message ? String(message.message_thread_id ?? "") : "" } },
        };
        this.context.receive({ ...source, externalId: String(context.update.update_id), sender: String(callback.from.id), text: "", attachments: [],
          ...(callback.data.startsWith("ar:") ? { action: { token: callback.data.slice(3) } } : { event: { type: "callback", data: { value: callback.data } } }) });
        await context.answerCallbackQuery().catch(() => {});
      });
      this.bot.on("message_reaction", (context) => {
        const event = context.messageReaction; if (!event.user || event.user.is_bot) return;
        const source = this.context.checkpoint<ChannelMessage>(`message:${event.chat.id}:${event.message_id}`) ?? this.context.checkpoint<ChannelMessage>(`sent-route:${event.chat.id}:${event.message_id}`); if (!source) return;
        this.context.receive({ ...source, externalId: String(context.update.update_id), sender: String(event.user.id), text: "", attachments: [], event: { type: "reaction", data: { ...event } } });
      });
      this.bot.on("stopped_message_generation", (context) => {
        const event = context.update.stopped_message_generation as any;
        const source = this.context.checkpoint<ChannelMessage>(`draft:${event.draft_id}`); if (!source || String(event.chat.id) !== source.reply.target) return;
        this.context.receive({ ...source, externalId: String(context.update.update_id), text: "/cancel", attachments: [] });
      });
      this.listening = true;
    }
  }
  private receive(context: Context): void {
    const message = context.message ?? context.editedMessage;
    if (!message?.from || message.from.is_bot) return;
    if (message.date < this.context.checkpoint<number>("activation")!) return;
    const topic = message.message_thread_id;
    const attachments: AttachmentReference[] = [];
    const add = (value: any, kind: AttachmentReference["kind"], mediaType: string, name: string) => { if (value?.file_id) attachments.push({ id: value.file_id, name: value.file_name ?? name, kind, mediaType: value.mime_type ?? mediaType }); };
    add(message.photo?.at(-1), "image", "image/jpeg", "photo.jpg");
    add(message.document, "file", "application/octet-stream", "document");
    add(message.audio, "audio", "audio/mpeg", "audio.mp3");
    add(message.voice, "audio", "audio/ogg", "voice.ogg");
    add(message.video ?? message.animation ?? message.video_note, "video", "video/mp4", "video.mp4");
    add(message.sticker, "sticker", message.sticker?.is_video ? "video/webm" : message.sticker?.is_animated ? "application/x-tgsticker" : "image/webp", "sticker");
    const received: ChannelMessage = { externalId: String(context.update.update_id), sender: String(message.from.id),
      threadId: `${message.chat.id}${topic ? `:${topic}` : ""}`, scope: message.chat.type === "private" ? "direct" : "group",
      ...(message.chat.type !== "private" ? { groupId: String(message.chat.id) } : {}), text: message.text ?? message.caption ?? "", attachments,
      ...(message.reply_to_message ? { quoted: { messageId: String(message.reply_to_message.message_id), text: message.reply_to_message.text ?? message.reply_to_message.caption ?? "" } } : {}),
      native: { message: message as unknown as Record<string, unknown> },
      ...(context.editedMessage ? { event: { type: "message-edit", data: { messageId: String(message.message_id) } } } : {}),
      ...(!message.text && !message.caption && !attachments.length ? { event: { type: "native-message", data: message as unknown as Record<string, unknown> } } : {}),
      reply: { target: String(message.chat.id), messageId: String(message.message_id), data: { topic: topic ? String(topic) : "" } },
    }; this.context.receive(received); this.context.checkpoint(`message:${message.chat.id}:${message.message_id}`, received);
  }
  protected async poll(signal: AbortSignal): Promise<void> {
    const offset = this.context.checkpoint<number>("update") ?? -1;
    let updates;
    try {
      // grammY's types still name the AbortController polyfill; Node's signal implements the runtime contract.
      updates = await this.bot.api.getUpdates({ offset: offset + 1, timeout: 20, allowed_updates: ["message", "edited_message", "callback_query", "message_reaction", "stopped_message_generation"] },
        signal as Parameters<typeof this.bot.api.getUpdates>[1]);
    } catch (error) {
      throw telegramError(error);
    }
    for (const update of updates) {
      await this.bot.handleUpdate(update);
      this.context.checkpoint("update", update.update_id); // Confirm only after durable receipt.
    }
  }
  async readAttachment(_message: ChannelMessage, attachment: AttachmentReference) {
    const file = await this.bot.api.getFile(attachment.id);
    if (!file.file_path) throw new Error("telegram_file_unavailable");
    return mediaContent(attachment.name, attachment.mediaType, await download(`https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`));
  }
  async sendContent(route: ReplyRoute, content: ChannelContent, sendKey: string) {
    const options = { reply_parameters: { message_id: Number(route.messageId) }, ...(route.data.topic ? { message_thread_id: Number(route.data.topic) } : {}) };
    const ids: string[] = [];
    if (content.buttons?.length) {
      const receipt = await sendChunks(this.context, sendKey, content.text, 2000, async (text) => this.providerSend(async () => {
        const sent = await this.bot.api.sendMessage(route.target, text, { ...options,
          reply_markup: { inline_keyboard: content.buttons!.map((button) => [{ text: button.label, callback_data: `ar:${button.token}` }]) } });
        const source = this.context.checkpoint<ChannelMessage>(`message:${route.target}:${route.messageId}`);
        if (source) this.context.checkpoint(`sent-route:${route.target}:${sent.message_id}`, source);
        return String(sent.message_id);
      }));
      return receipt;
    }
    if (content.text) ids.push((await this.send(route, content.text, `${sendKey}:text`)).externalId);
    for (const [index, item] of (content.media ?? []).entries()) {
      ids.push((await sendChunks(this.context, `${sendKey}:media:${index}`, "media", 100, async () => this.providerSend(async () => {
        const file = new InputFile(Buffer.from(item.data, "base64"), item.name);
        const result = item.mediaType.startsWith("image/") ? await this.bot.api.sendPhoto(route.target, file, options) :
          item.mediaType === "audio/ogg" ? await this.bot.api.sendVoice(route.target, file, options) :
          item.mediaType.startsWith("audio/") ? await this.bot.api.sendAudio(route.target, file, options) :
          item.mediaType.startsWith("video/") ? await this.bot.api.sendVideo(route.target, file, options) : await this.bot.api.sendDocument(route.target, file, options);
        const source = this.context.checkpoint<ChannelMessage>(`message:${route.target}:${route.messageId}`);
        if (source) this.context.checkpoint(`sent-route:${route.target}:${result.message_id}`, source);
        return String(result.message_id);
      }))).externalId);
    }
    return { externalId: ids.join(",") };
  }
  async progress(route: ReplyRoute, text: string, streamKey: string, final: boolean) {
    if (final) return this.send(route, text, `stream-final:${streamKey}`);
    const draftId = parseInt(digest(streamKey).slice(0, 7), 16) + 1;
    const source = this.context.checkpoint<ChannelMessage>(`message:${route.target}:${route.messageId}`);
    if (source) this.context.checkpoint(`draft:${draftId}`, source);
    await this.bot.api.sendMessageDraft(Number(route.target), draftId, Array.from(text).slice(-4000).join(""), {
      can_stop: true, ...(route.data.topic ? { message_thread_id: Number(route.data.topic) } : {}),
    });
    return { externalId: `draft:${draftId}` };
  }
  async native(route: ReplyRoute, operation: string, args: Record<string, unknown>) {
    const id = Number(args.messageId ?? route.messageId);
    const options = { reply_parameters: { message_id: Number(route.messageId) }, ...(route.data.topic ? { message_thread_id: Number(route.data.topic) } : {}) };
    if (operation === "formatted-text") {
      if (!["HTML", "MarkdownV2"].includes(String(args.parseMode))) throw new Error("telegram_parse_mode_invalid");
      return this.bot.api.sendMessage(route.target, String(args.text), { parse_mode: args.parseMode as "HTML" | "MarkdownV2", reply_parameters: { message_id: Number(route.messageId) }, ...(route.data.topic ? { message_thread_id: Number(route.data.topic) } : {}) });
    }
    if (operation === "typing") return this.bot.api.sendChatAction(route.target, "typing", route.data.topic ? { message_thread_id: Number(route.data.topic) } : {});
    if (operation === "reaction") return this.bot.api.setMessageReaction(route.target, id, [{ type: "emoji", emoji: String(args.emoji) as "👍" }]);
    if (operation === "edit") return this.bot.api.editMessageText(route.target, id, String(args.text));
    if (operation === "delete") return this.bot.api.deleteMessage(route.target, id);
    if (operation === "location") return this.bot.api.sendLocation(route.target, Number(args.latitude), Number(args.longitude), options);
    if (operation === "contact") return this.bot.api.sendContact(route.target, String(args.phone), String(args.name), options);
    if (operation === "poll") return this.bot.api.sendPoll(route.target, String(args.question), args.options as Array<{ text: string }>, options);
    if (operation === "sticker") return this.bot.api.sendSticker(route.target, String(args.fileId), options);
    throw new Error("telegram_native_operation_unsupported");
  }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    return sendChunks(this.context, sendKey, text, 2000, async (part) => this.providerSend(async () => {
      const result = await this.bot.api.sendMessage(route.target, part, {
        reply_parameters: { message_id: Number(route.messageId) },
        ...(route.data.topic ? { message_thread_id: Number(route.data.topic) } : {}),
      }, AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)]) as Parameters<typeof this.bot.api.sendMessage>[3]);
      const source = this.context.checkpoint<ChannelMessage>(`message:${route.target}:${route.messageId}`);
      if (source) this.context.checkpoint(`sent-route:${route.target}:${result.message_id}`, source);
      return String(result.message_id);
    }));
  }
  private async providerSend<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ChannelSendError) throw error;
      if (error instanceof GrammyError) {
        if (error.error_code === 429) throw new ChannelSendError("retry", "telegram_rate_limited", (error.parameters.retry_after ?? 1) * 1000);
        if ([400, 401, 403].includes(error.error_code)) throw new ChannelSendError("failed", `telegram_http_${error.error_code}`);
      }
      throw new ChannelSendError("uncertain", "telegram_acceptance_unknown");
    }
  }
}
function telegramError(error: unknown): unknown {
  if (error instanceof GrammyError && [401, 403, 409].includes(error.error_code)) return new ChannelHttpError(401, `telegram_http_${error.error_code}`);
  if (error instanceof GrammyError && error.error_code === 429) return new ChannelHttpError(429, "telegram_rate_limited");
  return error;
}
