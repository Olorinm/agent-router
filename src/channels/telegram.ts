import { Bot, GrammyError, type Context } from "grammy";
import { PollingChannel } from "./polling.js";
import { ChannelHttpError } from "./http.js";
import { bindAccount, ChannelSendError, sendChunks, type ChannelAdapter, type ReplyRoute } from "../communication/types.js";

export class TelegramChannel extends PollingChannel implements ChannelAdapter {
  readonly kind = "telegram";
  readonly retrySafe = false;
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
    if (!this.listening) { this.bot.on("message", (context) => this.receive(context)); this.listening = true; }
  }
  private receive(context: Context): void {
    const message = context.message;
    if (!message?.from || message.from.is_bot) return;
    if (message.date < this.context.checkpoint<number>("activation")!) return;
    const topic = message.message_thread_id;
    this.context.receive({ externalId: String(context.update.update_id), sender: String(message.from.id),
      threadId: `${message.chat.id}${topic ? `:${topic}` : ""}`, scope: message.chat.type === "private" ? "direct" : "group",
      ...(message.chat.type !== "private" ? { groupId: String(message.chat.id) } : {}), text: message.text ?? message.caption ?? "",
      reply: { target: String(message.chat.id), messageId: String(message.message_id), data: { topic: topic ? String(topic) : "" } },
    });
  }
  protected async poll(signal: AbortSignal): Promise<void> {
    const offset = this.context.checkpoint<number>("update") ?? -1;
    let updates;
    try {
      // grammY's types still name the AbortController polyfill; Node's signal implements the runtime contract.
      updates = await this.bot.api.getUpdates({ offset: offset + 1, timeout: 20, allowed_updates: ["message"] },
        signal as Parameters<typeof this.bot.api.getUpdates>[1]);
    } catch (error) {
      throw telegramError(error);
    }
    for (const update of updates) {
      await this.bot.handleUpdate(update);
      this.context.checkpoint("update", update.update_id); // Confirm only after durable receipt.
    }
  }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    return sendChunks(this.context, sendKey, text, 2000, async (part) => {
      try {
        const result = await this.bot.api.sendMessage(route.target, part, {
          reply_parameters: { message_id: Number(route.messageId) },
          ...(route.data.topic ? { message_thread_id: Number(route.data.topic) } : {}),
        }, AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)]) as Parameters<typeof this.bot.api.sendMessage>[3]);
        return String(result.message_id);
      } catch (error) {
        if (error instanceof GrammyError) {
          if (error.error_code === 429) throw new ChannelSendError("retry", "telegram_rate_limited", (error.parameters.retry_after ?? 1) * 1000);
          if ([400, 401, 403].includes(error.error_code)) throw new ChannelSendError("failed", `telegram_http_${error.error_code}`);
        }
        throw new ChannelSendError("uncertain", "telegram_acceptance_unknown");
      }
    });
  }
}
function telegramError(error: unknown): unknown {
  if (error instanceof GrammyError && [401, 403, 409].includes(error.error_code)) return new ChannelHttpError(401, `telegram_http_${error.error_code}`);
  if (error instanceof GrammyError && error.error_code === 429) return new ChannelHttpError(429, "telegram_rate_limited");
  return error;
}
