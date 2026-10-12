import { afterEach, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { Bot } from "grammy";
import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { FeishuChannel } from "../src/channels/feishu.js";
import { TelegramChannel } from "../src/channels/telegram.js";
import { WeixinChannel } from "../src/channels/weixin/index.js";
import { GroveMailChannel } from "../src/channels/grove-mail.js";
import { ServiceHttp } from "../src/channels/http.js";
import { encryptAesEcb } from "../src/channels/weixin/vendor/aes-ecb.js";
import { channelConfigSchema } from "../src/service/channels.js";
import { MatrixChannel } from "../src/channels/matrix.js";
import { SdkMatrixTransport } from "../src/matrix/transport.js";
import type { MatrixConnector } from "../src/matrix/connector.js";
import { uploadWeixinMedia } from "../src/channels/weixin/media.js";
import { decryptAesEcb } from "../src/channels/weixin/vendor/aes-ecb.js";
import type { ChannelContext, ChannelMessage, ReplyRoute } from "../src/communication/types.js";
afterEach(() => { vi.unstubAllGlobals(); });
const png = Buffer.from([137,80,78,71,13,10,26,10,0,255]);
function context() {
  const messages: ChannelMessage[] = [], saved = new Map<string, unknown>();
  const value: ChannelContext = { receive: (message) => { messages.push(message); }, error() {}, checkpoint: ((key: string, value?: unknown) => {
    if (value === undefined) return saved.get(key); saved.set(key, value);
  }) as ChannelContext["checkpoint"] };
  return { value, messages, saved };
}
const route: ReplyRoute = { connectionId: "channel", target: "456", messageId: "7", data: {} };
it("downloads Feishu resources using the source message ID and forwards native card callbacks", async () => {
  const c = context(), handlers = new Map<string, any>();
  const resource = vi.fn(async () => ({ getReadableStream: () => Readable.from([png]) }));
  const send = vi.fn(async () => ({ messageId: "card" }));
  const channel = new FeishuChannel({ appId: "fixture", appSecret: "fixture" }, { on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; }, connect: async () => {}, disconnect: async () => {}, botIdentity: { openId: "bot" }, send,
    rawClient: { im: { v1: { messageResource: { get: resource } } } } } as unknown as LarkChannel);
  await channel.start(c.value);
  channel.receive({ messageId: "source", chatId: "chat", chatType: "p2p", senderId: "owner", content: "", createTime: Date.now(), resources: [{ type: "image", fileKey: "image" }], mentions: [], rawContentType: "image", mentionAll: false, mentionedBot: false } as NormalizedMessage);
  const source = c.messages[0]!; const media = await channel.readAttachment(source, source.attachments![0]!);
  expect(Buffer.from(media.data, "base64")).toEqual(png); expect(media.mediaType).toBe("image/png");
  expect(resource).toHaveBeenCalledWith({ path: { message_id: "source", file_key: "image" }, params: { type: "image" } });
  await channel.sendContent({ connectionId: "channel", ...source.reply }, { text: "同意？", buttons: [{ label: "同意", token: "choice" }] }, "question");
  await handlers.get("cardAction")({ messageId: "card", chatId: "chat", operator: { openId: "owner" }, action: { value: { agentRouter: "choice" }, tag: "button" } });
  expect(c.messages.at(-1)!.action).toEqual({ token: "choice" }); expect(c.messages.at(-1)!.threadId).toBe("chat");
});
it("uses Feishu's official stream producer and completes the same card", async () => {
  const c = context(), setContent = vi.fn(async () => {});
  const native = { on: () => () => {}, connect: async () => {}, disconnect: async () => {}, botIdentity: { openId: "bot" },
    stream: vi.fn(async (_target, input) => { await input.markdown({ messageId: "stream-card", setContent }); return { messageId: "stream-card" }; }) };
  const channel = new FeishuChannel({ appId: "fixture", appSecret: "fixture" }, native as unknown as LarkChannel); await channel.start(c.value);
  expect((await channel.progress(route, "你", "run", false)).externalId).toBe("stream-card");
  expect((await channel.progress(route, "你好", "run", true)).externalId).toBe("stream-card");
  expect(native.stream).toHaveBeenCalledTimes(1); expect(setContent.mock.calls).toEqual([["你"], ["你好"]]);
});
it("recovers an uncached Feishu callback from its source message and chat", async () => {
  const c = context(), handlers = new Map<string, any>();
  const channel = new FeishuChannel({ appId: "fixture", appSecret: "fixture" }, {
    on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; }, connect: async () => {}, disconnect: async () => {},
    botIdentity: { openId: "bot" }, getChatInfo: async () => ({ chatType: "group" }),
    rawClient: { im: { v1: { message: { get: async () => ({ data: { items: [{ chat_id: "group", root_id: "root" }] } }) } } } },
  } as unknown as LarkChannel);
  await channel.start(c.value);
  await handlers.get("cardAction")({ messageId: "old-card", chatId: "group", operator: { openId: "owner" }, action: { value: { selection: "native" }, tag: "select_static" } });
  expect(c.messages[0]!.event!.type).toBe("card-action");
  expect(c.messages[0]!.groupId).toBe("group"); expect(c.messages[0]!.threadId).toBe("group:root");
});
it("Feishu document comments stay in a shared thread and reply to that document", async () => {
  const c = context(), handlers = new Map<string, any>();
  const create = vi.fn(async () => ({ code: 0, data: { reply_id: "reply" } }));
  const channel = new FeishuChannel({ appId: "fixture", appSecret: "fixture" }, {
    on: (name: string, fn: any) => { handlers.set(name, fn); return () => {}; }, connect: async () => {}, disconnect: async () => {}, botIdentity: { openId: "bot" },
    rawClient: { drive: { v1: { fileComment: { batchQuery: async () => ({ code: 0, data: { items: [{ reply_list: { replies: [
      { reply_id: "source", content: { elements: [{ type: "text_run", text_run: { text: "帮我看看这段" } }] } },
    ] } }] } }) }, fileCommentReply: { create } } } },
  } as unknown as LarkChannel);
  await channel.start(c.value);
  await handlers.get("comment")({ fileToken: "document", fileType: "docx", commentId: "comment", replyId: "source", operator: { openId: "owner" }, mentionedBot: true, timestamp: Date.now() });
  const message = c.messages[0]!, reply = { connectionId: "feishu", ...message.reply };
  expect(message.scope).toBe("group"); expect(message.groupId).toBe("document:document");
  expect(message.text).toBe("帮我看看这段"); expect(channel.capabilitiesFor(reply).stream).toBe(false);
  await channel.send(reply, "可以", "comment");
  expect(create.mock.calls[0]![0].path).toEqual({ file_token: "document", comment_id: "comment" });
  await expect(channel.sendContent(reply, { text: "", card: {} }, "invalid-card")).rejects.toThrow("feishu_comment_content_unsupported");
});
it("Matrix transfers actual media, preserves thread replies and updates every stream segment", async () => {
  const c = context(), send = vi.fn(async (_room, _type, _body, txn) => `$${txn}`);
  const upload = vi.fn(async () => "mxc://media.example/file");
  let encrypted = false;
  const connector = { userId: "@bot:example", store: { get: () => undefined }, transport: {
    state: async () => [{ type: "m.room.member", state_key: "owner", content: { membership: "join" } }, ...(encrypted ? [{ type: "m.room.encryption", content: {} }] : [])],
    media: { read: async () => png, upload }, send,
  } } as unknown as MatrixConnector;
  const channel = new MatrixChannel(connector); await channel.start(c.value);
  const reply = { ...route, data: { sender: "owner", thread: "$thread" } };
  await channel.sendContent(reply, { text: "", media: [{ name: "image.png", mediaType: "image/png", data: png.toString("base64") }] }, "media");
  expect(upload).toHaveBeenCalledWith(png, "image.png", "image/png");
  expect(send.mock.calls[0]![2]["m.relates_to"].event_id).toBe("$thread");
  const media = await channel.readAttachment({} as ChannelMessage, { id: "mxc://media.example/file", name: "image.png", mediaType: "image/png" });
  expect(Buffer.from(media.data, "base64")).toEqual(png);
  await channel.progress(reply, "a".repeat(5000), "stream", false);
  await channel.progress(reply, "b".repeat(5000), "stream", true);
  const edits = send.mock.calls.filter((call) => call[2]["m.new_content"]);
  expect(edits).toHaveLength(3); expect(edits.map((call) => call[2]["m.new_content"].body).join("")).toBe("b".repeat(5000));
  await channel.sendContent(reply, { text: "hello", html: "<b>hello</b>" }, "html");
  expect(send.mock.calls.at(-1)![2].formatted_body).toBe("<b>hello</b>");
  encrypted = true; const count = upload.mock.calls.length;
  await expect(channel.sendContent(reply, { text: "", media: [{ name: "image.png", mediaType: "image/png", data: png.toString("base64") }] }, "encrypted")).rejects.toThrow("matrix_encrypted_room_not_supported");
  expect(upload).toHaveBeenCalledTimes(count);
});
it("Matrix authenticates media downloads only to its own homeserver", async () => {
  const fetchMock = vi.fn(async () => new Response(new Uint8Array(png)));
  vi.stubGlobal("fetch", fetchMock);
  const transport = new SdkMatrixTransport("https://matrix.example.test", "fixture-token", "@bot:example", { uploadContent: async () => ({ content_uri: "mxc://example/upload" }) } as any);
  expect(await transport.media.read("mxc://remote.example/opaque")).toEqual(png);
  expect(fetchMock.mock.calls[0]![0]).toBe("https://matrix.example.test/_matrix/client/v1/media/download/remote.example/opaque");
  expect((fetchMock.mock.calls[0]![1] as any).headers.authorization).toBe("Bearer fixture-token");
  await expect(transport.media.read("https://elsewhere.example/file")).rejects.toThrow("matrix_media_uri_invalid");
});
it("Weixin uploads AES ciphertext and sends the matching native media reference", async () => {
  let requested: any, encrypted: Buffer | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (String(url).includes("getuploadurl")) { requested = JSON.parse(options.body); return Response.json({ upload_param: "upload" }); }
    encrypted = Buffer.from(options.body);
    return new Response("", { headers: { "x-encrypted-param": "download" } });
  }));
  const item = await uploadWeixinMedia({ accountId: "bot", userId: "owner", token: "fixture", baseUrl: "https://ilinkai.weixin.qq.com" },
    "owner", { name: "image.png", mediaType: "image/png", data: png.toString("base64") });
  expect(requested.media_type).toBe(1); expect(requested.rawsize).toBe(png.length);
  expect(decryptAesEcb(encrypted!, Buffer.from(item.image_item!.media!.aes_key!, "base64"))).toEqual(png);
  expect(item.image_item!.media!.encrypt_query_param).toBe("download");
});
class Telegram extends TelegramChannel { async activate(c: ChannelContext) { this.context = c; await this.initialize(); } async once() { await this.poll(new AbortController().signal); } }
it("Telegram receives voice/photo bytes and quotes, and resolves its inline button callback", async () => {
  const c = context(), methods: string[] = [];
  const bot = new Bot("123:fixture", { botInfo: { id: 123, is_bot: true, first_name: "bot", username: "fixture" } });
  const message = { message_id: 7, date: Math.floor(Date.now() / 1000), from: { id: 456, is_bot: false, first_name: "owner" }, chat: { id: 456, type: "private" }, voice: { file_id: "voice", file_unique_id: "unique", duration: 1 }, reply_to_message: { text: "原文", message_id: 6 } };
  let updates: any[] = [{ update_id: 1, message }];
  bot.api.config.use(async (_previous, method, payload) => {
    methods.push(method);
    const result = method === "getWebhookInfo" ? { url: "", pending_update_count: 0 } : method === "getUpdates" ? updates : method === "getFile" ? { file_id: "voice", file_unique_id: "unique", file_path: "voice.ogg" } : method === "sendMessage" ? { message_id: 10 } : true;
    return { ok: true, result } as any;
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0,255]))));
  const channel = new Telegram("unused", bot); await channel.activate(c.value); await channel.once();
  expect(c.messages[0]!.quoted!.text).toBe("原文"); expect(c.messages[0]!.attachments![0]!.mediaType).toBe("audio/ogg");
  const media = await channel.readAttachment(c.messages[0]!, c.messages[0]!.attachments![0]!); expect(Buffer.from(media.data, "base64")).toEqual(Buffer.from([0,255]));
  await channel.sendContent(route, { text: "选一个", buttons: [{ label: "选项", token: "pick" }] }, "question");
  updates = [{ update_id: 2, callback_query: { id: "callback", from: message.from, chat_instance: "chat", data: "ar:pick", message: { ...message, message_id: 10 } } }];
  await channel.once(); expect(c.messages.at(-1)!.action).toEqual({ token: "pick" }); expect(methods).toContain("answerCallbackQuery");
  await channel.progress(route, "正在输出", "stream", false); expect(methods).toContain("sendMessageDraft");
});
class Weixin extends WeixinChannel { async activate(c: ChannelContext) { this.context = c; await this.initialize(); } async once() { await this.poll(new AbortController().signal); } }
it("Weixin retains voice transcription, decrypts CDN media and preserves quoted text", async () => {
  const c = context(), key = Buffer.alloc(16, 9), plain = Buffer.from([0,255,128]);
  const api = { updates: async () => ({ ret: 0, msgs: [{ message_id: "one", from_user_id: "owner", message_type: 1, context_token: "context", item_list: [{ type: 3, voice_item: { text: "安排明天的会议", encode_type: 7, media: { aes_key: Buffer.from(key.toString("hex")).toString("base64"), encrypt_query_param: "cdn" } }, ref_msg: { title: "原来的会议" } }] }], get_updates_buf: "next" }), send: async () => ({ ret: 0 }) };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(encryptAesEcb(plain, key)))));
  const channel = new Weixin({ accountId: "bot", userId: "owner", token: "fixture", baseUrl: "https://ilinkai.weixin.qq.com" }, api); await channel.activate(c.value); await channel.once();
  const source = c.messages[0]!; expect(source.text).toBe("安排明天的会议"); expect(source.quoted!.text).toBe("原来的会议");
  const media = await channel.readAttachment(source, source.attachments![0]!); expect(Buffer.from(media.data, "base64")).toEqual(plain);
});
class Mail extends GroveMailChannel { async activate(c: ChannelContext) { this.context = c; await this.initialize(); } async once() { await this.poll(new AbortController().signal); } }
it("Grove Mail downloads a scoped attachment grant and sends binary reply attachments", async () => {
  const c = context(), requests: any[] = [];
  const http = new ServiceHttp("https://mail.example.test", "fixture", async (url, init) => {
    requests.push({ url, body: init?.body });
    return Response.json(String(url).includes("events/lifecycle") ? { next_cursor: 1, events: [{ sequence: 1, inbox_id: "agent@example.test", event_id: "event", type: "message.received", created_at: "2999-01-01", data: { message: { inbox_id: "agent@example.test", message_id: "message", from: "owner@example.test", attachments: [{ attachment_id: "attachment", filename: "image.png", content_type: "image/png" }] } } }] } : String(url).includes("/attachments/") ? { download_url: "https://mail.example.test/downloads/fixture" } : String(url).endsWith("/reply") ? { status: "accepted", message_id: "reply" } : {});
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(png))));
  const channel = new Mail("agent@example.test", http); await channel.activate(c.value); await channel.once();
  const source = c.messages[0]!, media = await channel.readAttachment(source, source.attachments![0]!);
  await channel.sendContent({ connectionId: "channel", ...source.reply }, { text: "附件", media: [media] }, "stable");
  expect(JSON.parse(requests.at(-1).body).attachments[0].content).toBe(png.toString("base64"));
});
it("Grove Mail supports an explicit public attachment origin and HTML without forwarding its API key", async () => {
  const c = context(), bodies: any[] = [];
  const http = new ServiceHttp("https://internal-mail.example.test", "fixture-api-key", async (_url, options) => {
    if (options?.body) { bodies.push(JSON.parse(String(options.body))); return Response.json({ status: "accepted", message_id: "reply" }); }
    return Response.json({ download_url: "https://public-mail.example.test/downloads/grant" });
  });
  const fetchMock = vi.fn(async () => new Response(new Uint8Array(png))); vi.stubGlobal("fetch", fetchMock);
  const channel = new Mail("agent@example.test", http, 0, ["https://public-mail.example.test"]); await channel.activate(c.value);
  const source = { reply: { messageId: "message" } } as ChannelMessage, attachment = { id: "file", name: "image.png", mediaType: "image/png" };
  expect(Buffer.from((await channel.readAttachment(source, attachment)).data, "base64")).toEqual(png);
  expect((fetchMock.mock.calls[0]![1] as any).headers).toBeUndefined();
  await channel.sendContent({ ...route, target: "agent@example.test" }, { text: "hello", html: "<b>hello</b>" }, "html");
  expect(bodies[0].html).toBe("<b>hello</b>");
  await expect(new Mail("agent@example.test", http).readAttachment(source, attachment)).rejects.toThrow("mail_attachment_origin_mismatch");
});
it("rejects Weixin groups before any work can execute", () => {
  expect(channelConfigSchema.safeParse({ agents: [{ agentId: "10000000-0000-4000-8000-000000000001", connections: [{ id: "weixin", kind: "weixin", credentialsFile: "private.json", groupIds: ["group"] }] }] }).success).toBe(false);
});
