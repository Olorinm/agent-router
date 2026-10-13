import { createLarkChannel, Domain, LarkChannelError, LoggerLevel, type LarkChannel, type CardActionEvent, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { bindAccount, ChannelSendError, sendChunks, type ChannelAdapter, type ChannelContext, type ReplyRoute, type AttachmentReference, type ChannelMessage, type ChannelContent, type ChannelCapabilities } from "../communication/types.js";

import { mediaContent, readBytes } from "../communication/media.js";
import { digest } from "../execution/protocol.js";

export class FeishuChannel implements ChannelAdapter {
  readonly kind = "feishu";
  readonly retrySafe = false;
  readonly capabilities = { receive: ["text", "image", "file", "audio", "video", "sticker-reference", "quote", "card-action", "reaction", "comment"], send: ["text", "image", "file", "audio", "video", "card", "sticker", "post"], stream: true, buttons: true, native: ["card", "post", "sticker", "edit", "recall", "reaction", "chat-info", "share-chat", "share-user"], nativeArguments: { card: "card: provider card JSON", post: "post: provider rich post JSON", sticker: "fileKey", edit: "text, optional messageId", recall: "optional messageId", reaction: "emoji, optional messageId", "chat-info": "no args", "share-chat": "chatId", "share-user": "userId" } };
  private unsubscribers: Array<() => void> = [];
  private streams = new Map<string, { set(text: string): Promise<void>; finish(): void; result: Promise<{ messageId: string }> }>();
  private context!: ChannelContext;
  readonly channel: LarkChannel;
  constructor(options: { appId: string; appSecret: string; domain?: "feishu" | "lark" }, channel?: LarkChannel) {
    this.channel = channel ?? createLarkChannel({ appId: options.appId, appSecret: options.appSecret,
      domain: options.domain === "lark" ? Domain.Lark : Domain.Feishu, loggerLevel: LoggerLevel.error,
      source: "agent-router", handshakeTimeoutMs: 15_000, includeRawEvent: true,
      policy: { dmMode: "open", requireMention: true },
      // Keep each provider message intact: Router owns deduplication and turn serialization.
      // SDK zero means immediate expiry. Router's durable activation checkpoint filters old backlog.
      safety: { dedup: { ttl: 0 }, staleMessageWindowMs: Number.MAX_SAFE_INTEGER, chatQueue: { enabled: false },
        batch: { text: { delayMs: 0, maxMessages: 1 }, media: { delayMs: 0, maxItems: 1 } } },
      outbound: { textChunkLimit: 4000, retry: { maxAttempts: 1 } },
    });
  }
  groupPolicy(message: ChannelMessage): "open" | "allowlist" {
    // The SDK already requires @bot in IM groups. Document comments keep their own access list.
    return message.reply.data.commentId ? "allowlist" : "open";
  }
  async start(context: ChannelContext): Promise<void> {
    this.context = context;
    if (!context.checkpoint("activation")) context.checkpoint("activation", Date.now());
    for (const unsubscribe of this.unsubscribers.splice(0)) if (typeof unsubscribe === "function") unsubscribe();
    this.unsubscribers.push(this.channel.on("message", (message) => this.receive(message)),
      this.channel.on("cardAction", (event) => this.cardAction(event)),
      this.channel.on("reaction", (event) => { void this.sourceFor(event.messageId, event.operator.openId).then((prior) => {
        this.context.receive({ ...prior, externalId: `reaction:${digest(event)}`, sender: event.operator.openId, text: "", attachments: [],
          event: { type: "reaction", data: { messageId: event.messageId, emoji: event.emojiType, action: event.action } } });
      }).catch(() => context.error("feishu_reaction_receipt_failed")); }),
      this.channel.on("comment", async (event) => {
        if (event.operator.openId === this.channel.botIdentity?.openId || event.timestamp < this.context.checkpoint<number>("activation")!) return;
        const threadId = `comment:${event.fileToken}:${event.commentId}`;
        if (!event.mentionedBot && !this.context.checkpoint(threadId)) return;
        const replyRoute = { target: event.fileToken, messageId: event.commentId, data: { fileType: event.fileType, commentId: event.commentId } };
        const result = await this.readComment(replyRoute);
        const replies = result.data?.items?.[0]?.reply_list?.replies ?? [];
        const reply = event.replyId ? replies.find((item) => item.reply_id === event.replyId) : replies[0];
        const text = reply?.content.elements.map((item) => item.text_run?.text ?? item.docs_link?.url ?? item.person?.user_id ?? "").join("") ?? "";
        this.context.receive({ externalId: `comment:${digest(event)}`, sender: event.operator.openId ?? event.operator.userId ?? "unknown",
          threadId, scope: "group", groupId: `document:${event.fileToken}`, text, event: { type: "comment", data: { ...event } }, reply: replyRoute });
        this.context.checkpoint(threadId, true);
      }));
    this.unsubscribers.push(this.channel.on("error", () => context.error("feishu_receive_failed")));
    this.unsubscribers.push(this.channel.on("reconnecting", () => context.error("feishu_reconnecting")));
    this.unsubscribers.push(this.channel.on("reconnected", () => context.error("")));
    await this.channel.connect();
    bindAccount(context, this.channel.botIdentity!.openId);
  }
  async stop(): Promise<void> { for (const unsubscribe of this.unsubscribers.splice(0)) if (typeof unsubscribe === "function") unsubscribe(); for (const stream of this.streams.values()) stream.finish(); await this.channel.disconnect(); }
  receive(message: NormalizedMessage): void {
    if (message.senderId === this.channel.botIdentity?.openId || message.createTime < this.context.checkpoint<number>("activation")!) return;
    if (!this.channel.botIdentity) { this.context.error("feishu_identity_unavailable"); throw new Error("feishu_identity_unavailable"); }
    bindAccount(this.context, this.channel.botIdentity.openId);
    try { const received: ChannelMessage = { externalId: message.messageId, sender: message.senderId,
      threadId: message.rootId || message.threadId ? `${message.chatId}:${message.rootId || message.threadId}` : message.chatId,
      scope: message.chatType === "p2p" ? "direct" : "group", text: message.content,
      ...(message.chatType === "group" ? { groupId: message.chatId } : {}),
      reply: { target: message.chatId, messageId: message.messageId, data: { inThread: String(Boolean(message.threadId || message.rootId)) } },
      attachments: message.resources.map((resource) => ({ id: resource.fileKey, name: resource.fileName ?? resource.type,
        kind: resource.type, mediaType: resource.type === "image" ? "image/*" : resource.type === "audio" ? "audio/ogg" : resource.type === "video" ? "video/mp4" : "application/octet-stream" })),
      ...(message.replyToMessageId ? { quoted: { messageId: message.replyToMessageId } } : {}),
      native: { contentType: message.rawContentType, mentions: message.mentions, ...(message.raw ? { raw: message.raw } : {}) },
    }; this.context.receive(received); this.context.checkpoint(`message:${message.messageId}`, received); } catch (error) { this.context.error("feishu_receipt_failed"); throw error; }
  }
  private async sourceFor(messageId: string, sender: string, chatId?: string): Promise<ChannelMessage> {
    const prior = this.context.checkpoint<ChannelMessage>(`message:${messageId}`) ??
      this.context.checkpoint<{ source: ChannelMessage }>(`sent-route:${messageId}`)?.source;
    if (prior) { if (chatId && prior.reply.target !== chatId) throw new Error("feishu_callback_scope_mismatch"); return prior; }
    const result = await this.channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
    const message = result.data?.items?.[0];
    if (!message?.chat_id || chatId && message.chat_id !== chatId) throw new Error("feishu_callback_scope_mismatch");
    const chat = await this.channel.getChatInfo(message.chat_id);
    return { externalId: messageId, sender, threadId: message.root_id || message.thread_id ? `${message.chat_id}:${message.root_id || message.thread_id}` : message.chat_id,
      scope: chat.chatType === "p2p" ? "direct" : "group", ...(chat.chatType === "group" ? { groupId: message.chat_id } : {}), text: "",
      reply: { target: message.chat_id, messageId, data: { inThread: String(Boolean(message.root_id || message.thread_id)) } } };
  }
  private remember(route: ReplyRoute, id: string) {
    const source = this.context.checkpoint<ChannelMessage>(`message:${route.messageId}`);
    if (source) this.context.checkpoint(`sent-route:${id}`, { route, source });
  }
  private async cardAction(event: CardActionEvent) {
    const value = event.action.value as { agentRouter?: string } | undefined;
    const source = await this.sourceFor(event.messageId, event.operator.openId, event.chatId);
    this.context.receive({ ...source, externalId: `card:${digest(event)}`, sender: event.operator.openId, text: "", attachments: [],
      ...(value?.agentRouter ? { action: { token: value.agentRouter } } : { event: { type: "card-action", data: { action: event.action } } }) });
  }
  async readAttachment(message: ChannelMessage, attachment: AttachmentReference) {
    if (attachment.kind === "sticker") throw new Error("feishu_sticker_download_unsupported");
    const result = await this.channel.rawClient.im.v1.messageResource.get({ path: { message_id: message.reply.messageId, file_key: attachment.id }, params: { type: attachment.kind === "image" ? "image" : "file" } });
    return mediaContent(attachment.name, attachment.mediaType, await readBytes(result.getReadableStream()));
  }
  async readQuote(message: ChannelMessage) {
    const result = await this.channel.rawClient.im.v1.message.get({ path: { message_id: message.quoted!.messageId! } });
    const item = result.data?.items?.[0];
    if (!item || item.chat_id !== message.reply.target) throw new Error("feishu_quote_scope_mismatch");
    try { const content = JSON.parse(item.body?.content ?? "{}"); return String(content.text ?? item.body?.content ?? ""); }
    catch { return item.body?.content; }
  }
  async sendContent(route: ReplyRoute, content: ChannelContent, sendKey: string) {
    if (route.data.commentId) {
      if (content.card || content.media?.length || content.html) throw new ChannelSendError("failed", "feishu_comment_content_unsupported");
      return this.send(route, content.text, sendKey);
    }
    const options = { ...(route.messageId ? { replyTo: route.messageId } : {}), replyInThread: route.data.inThread === "true" };
    if (content.card || content.buttons?.length) {
      const card = content.card ?? { config: { wide_screen_mode: true }, elements: [
        { tag: "markdown", content: content.text }, { tag: "action", actions: content.buttons!.map((button) => ({ tag: "button", text: { tag: "plain_text", content: button.label }, value: { agentRouter: button.token } })) },
      ] };
      const receipt = await sendChunks(this.context, sendKey, "card", 100, async () => (await this.providerSend(() => this.channel.send(route.target, { card }, options))).messageId);
      const source = this.context.checkpoint<ChannelMessage>(`message:${route.messageId}`);
      if (source) for (const id of receipt.externalId.split(",")) this.context.checkpoint(`sent-route:${id}`, { route, source });
      return receipt;
    }
    const ids: string[] = [];
    if (content.text) ids.push((await this.send(route, content.text, `${sendKey}:text`)).externalId);
    for (const [index, item] of (content.media ?? []).entries()) {
      const source = Buffer.from(item.data, "base64");
      const input = item.mediaType.startsWith("image/") ? { image: { source } } : item.mediaType.startsWith("audio/") ? { audio: { source } } : item.mediaType.startsWith("video/") ? { video: { source } } : { file: { source, fileName: item.name } };
      ids.push((await sendChunks(this.context, `${sendKey}:media:${index}`, "media", 100, async () => (await this.providerSend(() => this.channel.send(route.target, input, options))).messageId)).externalId);
    }
    return { externalId: ids.join(",") };
  }
  async progress(route: ReplyRoute, text: string, streamKey: string, final: boolean) {
    const saved = this.context.checkpoint<{ messageId?: string; state?: string }>(`stream:${streamKey}`);
    if (saved?.state === "submitting" && !saved.messageId) throw new ChannelSendError("uncertain", "feishu_stream_creation_unknown");
    let stream = this.streams.get(streamKey);
    if (!stream && saved?.messageId) {
      await this.channel.updateCard(saved.messageId, { schema: "2.0", ...(final ? { config: { streaming_mode: false } } : {}), body: { elements: [{ tag: "markdown", content: text }] } });
      return { externalId: saved.messageId };
    }
    if (!stream) {
      let ready!: () => void, finish!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      const done = new Promise<void>((resolve) => { finish = resolve; });
      this.context.checkpoint(`stream:${streamKey}`, { state: "submitting" });
      stream = { set: async () => {}, finish, result: Promise.resolve({ messageId: "" }) }; this.streams.set(streamKey, stream);
      const result = this.channel.stream(route.target, { markdown: async (controller) => {
        this.context.checkpoint(`stream:${streamKey}`, { messageId: controller.messageId }); this.remember(route, controller.messageId);
        stream!.set = (value) => controller.setContent(value); ready(); await done;
      } }, { replyTo: route.messageId, replyInThread: route.data.inThread === "true" });
      stream.result = result;
      try { await Promise.race([started, result.then(() => { throw new Error("feishu_stream_closed_early"); })]); }
      catch (error) {
        this.streams.delete(streamKey);
        if (error instanceof LarkChannelError && ["rate_limited", "permission_denied", "format_error", "not_connected"].includes(error.code)) this.context.checkpoint(`stream:${streamKey}`, { state: "retry" });
        throw error;
      }
    }
    await stream.set(text);
    if (final) { stream.finish(); const result = await stream.result; this.streams.delete(streamKey); this.context.checkpoint(`stream:${streamKey}`, { messageId: result.messageId }); return { externalId: result.messageId }; }
    return { externalId: this.context.checkpoint<{ messageId: string }>(`stream:${streamKey}`)!.messageId };
  }
  async native(route: ReplyRoute, operation: string, args: Record<string, unknown>) {
    if (route.data.commentId) {
      if (operation === "comment-read") return this.readComment(route);
      throw new Error("feishu_comment_operation_unsupported");
    }
    const id = typeof args.messageId === "string" ? args.messageId : route.messageId;
    if (id !== route.messageId && ["edit", "recall", "reaction"].includes(operation)) await this.sourceFor(id, this.channel.botIdentity!.openId, route.target);
    if (operation === "share-chat") return this.channel.send(route.target, { shareChat: { chatId: String(args.chatId) } }, { replyTo: route.messageId });
    if (operation === "share-user") return this.channel.send(route.target, { shareUser: { userId: String(args.userId) } }, { replyTo: route.messageId });
    if (operation === "card") return this.channel.send(route.target, { card: args.card as object }, { replyTo: route.messageId });
    if (operation === "post") return this.channel.send(route.target, { post: args.post as object }, { replyTo: route.messageId });
    if (operation === "sticker") return this.channel.send(route.target, { sticker: { fileKey: String(args.fileKey) } }, { replyTo: route.messageId });
    if (operation === "edit") return this.channel.editMessage(id, String(args.text));
    if (operation === "recall") return this.channel.recallMessage(id);
    if (operation === "reaction") return this.channel.addReaction(id, String(args.emoji));
    if (operation === "chat-info") return this.channel.getChatInfo(route.target);
    throw new Error("feishu_native_operation_unsupported");
  }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    if (route.data.commentId) return sendChunks(this.context, sendKey, text, 1500, async (part) => {
      const result = await this.channel.rawClient.drive.v1.fileCommentReply.create({ path: { file_token: route.target, comment_id: route.data.commentId! },
        params: { file_type: this.commentType(route) }, data: { content: { elements: [{ type: "text_run", text_run: { text: part } }] } } });
      if (result.code) throw new ChannelSendError("failed", "feishu_comment_rejected");
      if (!result.data?.reply_id) throw new ChannelSendError("uncertain", "feishu_comment_acceptance_unknown");
      return result.data.reply_id;
    });
    return sendChunks(this.context, sendKey, text, 1500, async (part) => this.providerSend(async () => {
      const result = await this.channel.send(route.target, { text: part }, { replyTo: route.messageId, replyInThread: route.data.inThread === "true" });
      this.remember(route, result.messageId); return result.messageId;
    }));
  }
  private async providerSend<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ChannelSendError) throw error;
      if (error instanceof LarkChannelError) {
        if (["rate_limited", "not_connected"].includes(error.code)) throw new ChannelSendError("retry", `feishu_${error.code}`);
        if (["permission_denied", "format_error", "target_revoked"].includes(error.code)) throw new ChannelSendError("failed", `feishu_${error.code}`);
      }
      throw new ChannelSendError("uncertain", "feishu_acceptance_unknown");
    }
  }
  capabilitiesFor(route: ReplyRoute): ChannelCapabilities {
    return route.data.commentId ? { receive: ["text", "comment"], send: ["text"], stream: false, buttons: false, native: ["comment-read"],
      nativeArguments: { "comment-read": "no args; reads the current document comment thread" } } : this.capabilities;
  }
  private commentType(route: Omit<ReplyRoute, "connectionId">) {
    const type = route.data.fileType;
    if (!["doc", "docx", "sheet", "file", "slides", "bitable", "apps"].includes(type ?? "")) throw new ChannelSendError("failed", "feishu_comment_file_type_invalid");
    return type as "doc" | "docx" | "sheet" | "file" | "slides" | "bitable" | "apps";
  }
  private async readComment(route: Omit<ReplyRoute, "connectionId">) {
    const result = await this.channel.rawClient.drive.v1.fileComment.batchQuery({ path: { file_token: route.target },
      params: { file_type: this.commentType(route) }, data: { comment_ids: [route.data.commentId!] } });
    if (result.code) throw new Error("feishu_comment_read_failed"); return result;
  }
}
