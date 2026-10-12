import { ChannelHttpError } from "../http.js";
import { PollingChannel } from "../polling.js";
import { bindAccount, ChannelSendError, sendChunks, type ChannelAdapter, type ReplyRoute, type AttachmentReference, type ChannelMessage, type ChannelContent } from "../../communication/types.js";
import { getUpdates, sendMessage, getConfig, sendTyping } from "./vendor/api.js";
import type { GetUpdatesResp, SendMessageReq, SendMessageResp } from "./vendor/types.js";
import { readWeixinMedia, uploadWeixinMedia } from "./media.js";
import { MessageType, MessageState, MessageItemType } from "./vendor/types.js";

export interface WeixinCredentials { accountId: string; userId: string; token: string; baseUrl: string; }
interface WeixinApi {
  updates(cursor: string, signal: AbortSignal): Promise<GetUpdatesResp>;
  send(body: SendMessageReq): Promise<SendMessageResp>;
}
export class WeixinChannel extends PollingChannel implements ChannelAdapter {
  readonly kind = "weixin";
  readonly retrySafe = false;
  readonly capabilities = { receive: ["text", "image", "audio", "video", "file", "voice-transcript", "quote"], send: ["text", "image", "audio-mp3-amr-silk", "video", "file"], stream: false, buttons: false, native: ["typing"], nativeArguments: { typing: "no args" } };
  private readonly api: WeixinApi;
  constructor(readonly credentials: WeixinCredentials, api?: WeixinApi) {
    super();
    this.api = api ?? {
      updates: (cursor, signal) => getUpdates({ baseUrl: credentials.baseUrl, token: credentials.token,
        get_updates_buf: cursor, timeoutMs: 25_000, abortSignal: signal }),
      send: (body) => sendMessage({ baseUrl: credentials.baseUrl, token: credentials.token, body, timeoutMs: 20_000 }),
    };
  }
  protected async initialize(): Promise<void> {
    bindAccount(this.context, this.credentials.accountId);
    if (!this.context.checkpoint("activation")) this.context.checkpoint("activation", Date.now());
  }
  protected async poll(signal: AbortSignal): Promise<void> {
    const result = await this.api.updates(this.context.checkpoint<string>("cursor") ?? "", signal);
    if (signal.aborted) return;
    if (result.ret || result.errcode) {
      if (result.ret === -14 || result.errcode === -14) throw new ChannelHttpError(401, "weixin_login_expired");
      throw new Error("weixin_poll_failed");
    }
    for (const message of result.msgs ?? []) {
      if (message.message_type !== MessageType.USER || !message.from_user_id || message.from_user_id === this.credentials.accountId) continue;
      if (message.create_time_ms !== undefined && message.create_time_ms < this.context.checkpoint<number>("activation")!) continue;
      if (!message.message_id) throw new Error("weixin_message_id_missing");
      const items = message.item_list ?? [];
      const text = items.map((item) => item.text_item?.text ?? item.voice_item?.text ?? "").filter(Boolean).join("\n");
      const attachments: AttachmentReference[] = [];
      for (const [index, item] of items.entries()) {
        const media = item.image_item?.media ?? item.voice_item?.media ?? item.video_item?.media ?? item.file_item?.media;
        if (!media) continue;
        const kind = item.image_item ? "image" : item.voice_item ? "audio" : item.video_item ? "video" : "file";
        const audioType = ({ 5: "audio/amr", 6: "audio/silk", 7: "audio/mpeg", 8: "audio/ogg" } as Record<number, string>)[item.voice_item?.encode_type ?? 0] ?? "audio/octet-stream";
        attachments.push({ id: `${message.message_id}:${index}`, name: item.file_item?.file_name ?? `${kind}-${index}`,
          mediaType: kind === "image" ? "image/*" : kind === "audio" ? audioType : kind === "video" ? "video/mp4" : "application/octet-stream", kind,
          data: { media, ...(item.image_item?.aeskey ? { aeskey: item.image_item.aeskey } : {}) } });
      }
      const quoted = items.find((item) => item.ref_msg)?.ref_msg;
      this.context.receive({ externalId: message.message_id, sender: message.from_user_id,
        threadId: message.group_id ?? message.from_user_id, scope: message.group_id ? "group" : "direct", text, attachments,
        ...(quoted ? { quoted: { text: quoted.title ?? quoted.message_item?.text_item?.text ?? "", ...(quoted.svr_id ? { messageId: quoted.svr_id } : {}) } } : {}),
        ...(message.group_id ? { groupId: message.group_id } : {}),
        reply: { target: message.from_user_id, messageId: message.message_id,
          data: { contextToken: message.context_token ?? "", groupId: message.group_id ?? "" } },
      });
    }
    if (result.get_updates_buf !== undefined) this.context.checkpoint("cursor", result.get_updates_buf);
  }
  async readAttachment(_message: ChannelMessage, attachment: AttachmentReference) { return readWeixinMedia(attachment); }
  async sendContent(route: ReplyRoute, content: ChannelContent, sendKey: string) {
    const ids: string[] = [];
    // Weixin has no bot buttons: keep choices usable through the displayed text labels.
    if (content.text) ids.push((await this.send(route, content.text, `${sendKey}:text`)).externalId);
    if (!route.data.contextToken || route.data.groupId) throw new ChannelSendError("failed", "weixin_reply_context_invalid");
    for (const [index, item] of (content.media ?? []).entries()) {
      ids.push((await sendChunks(this.context, `${sendKey}:media:${index}`, "media", 100, async () => {
        const media = await uploadWeixinMedia(this.credentials, route.target, item);
        const result = await this.api.send({ msg: { from_user_id: "", to_user_id: route.target, client_id: `${sendKey}:media:${index}`, message_type: MessageType.BOT,
          message_state: MessageState.FINISH, context_token: route.data.contextToken!, item_list: [media] } });
        if (result.ret) throw new ChannelSendError("failed", "weixin_send_rejected");
        return result.message_id ?? `${sendKey}:media:${index}`;
      })).externalId);
    }
    return { externalId: ids.join(",") };
  }
  async native(route: ReplyRoute, operation: string, _args: Record<string, unknown>) {
    if (operation !== "typing") throw new Error("weixin_native_operation_unsupported");
    const config = await getConfig({ baseUrl: this.credentials.baseUrl, token: this.credentials.token, ilinkUserId: route.target, contextToken: route.data.contextToken ?? "" });
    if (!config.typing_ticket) throw new Error("weixin_typing_ticket_missing");
    await sendTyping({ baseUrl: this.credentials.baseUrl, token: this.credentials.token, body: { ilink_user_id: route.target, typing_ticket: config.typing_ticket, status: 1 } });
  }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    const contextToken = route.data.contextToken;
    if (!contextToken) throw new ChannelSendError("failed", "weixin_reply_context_missing");
    if (route.data.groupId) throw new ChannelSendError("failed", "weixin_group_reply_not_supported");
    return sendChunks(this.context, sendKey, text, 1500, async (part, index) => {
      try {
        const result = await this.api.send({ msg: { from_user_id: "", to_user_id: route.target,
          client_id: `${sendKey}:${index}`, message_type: MessageType.BOT, message_state: MessageState.FINISH, context_token: contextToken,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: part } }] } });
        if (result.ret) throw new ChannelSendError("failed", "weixin_send_rejected");
        return result.message_id ?? `${sendKey}:${index}`;
      } catch (error) {
        if (error instanceof ChannelSendError) throw error;
        // The vendored API distinguishes an explicit provider rejection from a transport failure.
        if (error instanceof Error && /^sendMessage ret=-?\d+ errmsg=/.test(error.message)) {
          if (error.message.startsWith("sendMessage ret=-14 ")) this.context.error("weixin_login_expired");
          throw new ChannelSendError("failed", "weixin_send_rejected");
        }
        throw new ChannelSendError("uncertain", "weixin_acceptance_unknown");
      }
    });
  }
}
