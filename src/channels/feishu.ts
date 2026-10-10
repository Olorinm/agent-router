import { createLarkChannel, Domain, LarkChannelError, LoggerLevel, type LarkChannel, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { bindAccount, ChannelSendError, sendChunks, type ChannelAdapter, type ChannelContext, type ReplyRoute } from "../communication/types.js";

export class FeishuChannel implements ChannelAdapter {
  readonly kind = "feishu";
  readonly retrySafe = false;
  private context!: ChannelContext;
  readonly channel: LarkChannel;
  constructor(options: { appId: string; appSecret: string; domain?: "feishu" | "lark"; groupIds?: string[] }, channel?: LarkChannel) {
    this.channel = channel ?? createLarkChannel({ appId: options.appId, appSecret: options.appSecret,
      domain: options.domain === "lark" ? Domain.Lark : Domain.Feishu, loggerLevel: LoggerLevel.error,
      source: "agent-router", handshakeTimeoutMs: 15_000, includeRawEvent: true,
      policy: { dmMode: "open", requireMention: true, groupAllowlist: options.groupIds ?? [] },
      // Keep each provider message intact: Router owns deduplication and turn serialization.
      safety: { dedup: { ttl: 0 }, staleMessageWindowMs: 0, chatQueue: { enabled: false },
        batch: { text: { delayMs: 0, maxMessages: 1 }, media: { delayMs: 0, maxItems: 1 } } },
      outbound: { textChunkLimit: 4000, retry: { maxAttempts: 1 } },
    });
  }
  async start(context: ChannelContext): Promise<void> {
    this.context = context;
    if (!context.checkpoint("activation")) context.checkpoint("activation", Date.now());
    this.channel.on("message", (message) => this.receive(message));
    this.channel.on("error", () => context.error("feishu_receive_failed"));
    this.channel.on("reconnecting", () => context.error("feishu_reconnecting"));
    this.channel.on("reconnected", () => context.error(""));
    await this.channel.connect();
    bindAccount(context, this.channel.botIdentity!.openId);
  }
  async stop(): Promise<void> { await this.channel.disconnect(); }
  receive(message: NormalizedMessage): void {
    if (message.senderId === this.channel.botIdentity?.openId || message.createTime < this.context.checkpoint<number>("activation")!) return;
    if (!this.channel.botIdentity) { this.context.error("feishu_identity_unavailable"); throw new Error("feishu_identity_unavailable"); }
    bindAccount(this.context, this.channel.botIdentity.openId);
    try { this.context.receive({ externalId: message.messageId, sender: message.senderId,
      threadId: message.rootId || message.threadId ? `${message.chatId}:${message.rootId || message.threadId}` : message.chatId,
      scope: message.chatType === "p2p" ? "direct" : "group", text: message.content,
      ...(message.chatType === "group" ? { groupId: message.chatId } : {}),
      reply: { target: message.chatId, messageId: message.messageId, data: { inThread: String(Boolean(message.threadId || message.rootId)) } },
      attachments: message.resources.map((resource) => ({ id: resource.fileKey, name: resource.fileName ?? resource.type,
        mediaType: resource.type === "image" ? "image/*" : "application/octet-stream" })),
    }); } catch (error) { this.context.error("feishu_receipt_failed"); throw error; }
  }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    return sendChunks(this.context, sendKey, text, 1500, async (part) => {
      try {
        const result = await this.channel.send(route.target, { text: part }, { replyTo: route.messageId, replyInThread: route.data.inThread === "true" });
        return result.messageId;
      } catch (error) {
        if (error instanceof LarkChannelError) {
          if (["rate_limited", "not_connected"].includes(error.code)) throw new ChannelSendError("retry", `feishu_${error.code}`);
          if (["permission_denied", "format_error", "target_revoked"].includes(error.code)) throw new ChannelSendError("failed", `feishu_${error.code}`);
        }
        throw new ChannelSendError("uncertain", "feishu_acceptance_unknown");
      }
    });
  }
}
