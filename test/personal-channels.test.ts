import { afterEach, describe, expect, it, vi } from "vitest";
import { Bot } from "grammy";
import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { TelegramChannel } from "../src/channels/telegram.js";
import { FeishuChannel } from "../src/channels/feishu.js";
import { GroveMailChannel } from "../src/channels/grove-mail.js";
import { WeixinChannel } from "../src/channels/weixin/index.js";
import { getUpdates } from "../src/channels/weixin/vendor/api.js";
import { MatrixChannel } from "../src/channels/matrix.js";
import { MatrixConnector } from "../src/matrix/connector.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import type { RoomEvent } from "../src/matrix/protocol.js";
import { CommunicationCore } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { ServiceHttp, ChannelHttpError } from "../src/channels/http.js";
import type { ChannelContext, ChannelMessage, ReplyRoute } from "../src/communication/types.js";
import { channelConfigSchema } from "../src/service/channels.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function context() {
  const checkpoints = new Map<string, unknown>(), messages: ChannelMessage[] = [], errors: string[] = [];
  const value: ChannelContext = { receive: (message) => { messages.push(message); },
    checkpoint: ((key: string, value?: unknown) => { if (value === undefined) return checkpoints.get(key); checkpoints.set(key, value); }) as ChannelContext["checkpoint"],
    error: (error) => { errors.push(error); } };
  return { value, checkpoints, messages, errors };
}
const signal = () => new AbortController().signal;
class Telegram extends TelegramChannel {
  async activate(context: ChannelContext) { this.context = context; await this.initialize(); }
  async once() { await this.poll(signal()); }
}
class Mail extends GroveMailChannel {
  async activate(context: ChannelContext) { this.context = context; await this.initialize(); }
  async once() { await this.poll(signal()); }
}
class Weixin extends WeixinChannel {
  async activate(context: ChannelContext) { this.context = context; await this.initialize(); }
  async once() { await this.poll(signal()); }
}
const route: ReplyRoute = { connectionId: "channel", target: "chat", messageId: "7", data: {} };

describe("official channel contracts", () => {
  it("receives delayed Feishu SDK events while skipping pre-activation backlog", async () => {
    const c = context(), activatedAt = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(activatedAt);
    const channel = new FeishuChannel({ appId: "fixture", appSecret: "fixture" });
    vi.spyOn(channel.channel.rawClient, "request").mockResolvedValue({ code: 0, bot: { open_id: "bot", app_name: "Test" } });
    // Stub only the network handshake; retain the SDK's dispatcher, normalization and safety pipeline.
    vi.spyOn(channel.channel as unknown as { connectWebSocket(timeout: number): Promise<void> }, "connectWebSocket").mockResolvedValue();
    await channel.start(c.value);
    try {
      clock.mockReturnValue(activatedAt + 2000);
      await channel.channel.dispatcher.invoke({ schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: {
        sender: { sender_id: { open_id: "owner" }, sender_type: "user" },
        message: { message_id: "sdk-delayed-message", chat_id: "chat", chat_type: "p2p", message_type: "text",
          create_time: String(activatedAt + 1000), content: JSON.stringify({ text: "你好" }) },
      } }, { needCheck: false });
      expect(c.errors).toEqual([]);
      expect(c.messages).toMatchObject([{ externalId: "sdk-delayed-message", sender: "owner", scope: "direct", text: "你好" }]);
      await channel.channel.dispatcher.invoke({ schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: {
        sender: { sender_id: { open_id: "owner" }, sender_type: "user" },
        message: { message_id: "sdk-old-message", chat_id: "chat", chat_type: "p2p", message_type: "text",
          create_time: String(activatedAt - 1000), content: JSON.stringify({ text: "old" }) },
      } }, { needCheck: false });
      expect(c.messages).toHaveLength(1);
    } finally { await channel.stop(); }
  });
  it("normalizes Feishu thread routes and uses the official Channel send API", async () => {
    const c = context(), send = vi.fn(async () => ({ messageId: "reply" }));
    const native = { on: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), botIdentity: { openId: "bot" }, send } as unknown as LarkChannel;
    const channel = new FeishuChannel({ appId: "app", appSecret: "secret" }, native); await channel.start(c.value);
    const message: NormalizedMessage = { messageId: "input", chatId: "chat", chatType: "group", senderId: "owner", content: "hello",
      resources: [], mentions: [], mentionAll: false, mentionedBot: true, rawContentType: "text", createTime: Date.now(), rootId: "root" };
    channel.receive(message); const received = c.messages[0]!;
    expect(received.threadId).toBe("chat:root"); expect(received.groupId).toBe("chat");
    await channel.send({ connectionId: "channel", ...received.reply }, "中文🙂".repeat(1000), "key");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual(["chat", { text: "中文🙂".repeat(500) }, { replyTo: "input", replyInThread: true }]);
  });
  it("does not disguise a Feishu receipt failure", async () => {
    const c = context(); c.value.receive = () => { throw new Error("disk_full"); };
    const native = { on: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), botIdentity: { openId: "bot" } } as unknown as LarkChannel;
    const channel = new FeishuChannel({ appId: "app", appSecret: "secret" }, native); await channel.start(c.value);
    expect(() => channel.receive({ messageId: "input", chatId: "chat", chatType: "p2p", senderId: "owner", content: "hello", resources: [] } as unknown as NormalizedMessage)).toThrow("disk_full");
    expect(c.errors).toContain("feishu_receipt_failed");
  });
  it("uses grammY while advancing Telegram offsets only after durable receipt", async () => {
    const c = context(), bot = new Bot("123:test", { botInfo: { id: 123, is_bot: true, first_name: "bot", username: "testbot" } });
    const update = { update_id: 50, message: { message_id: 7, date: Math.floor(Date.now() / 1000), from: { id: 456, is_bot: false, first_name: "owner" }, chat: { id: 456, type: "private" as const, first_name: "owner" }, text: "hello" } };
    const offsets: number[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === "getWebhookInfo") return { ok: true, result: { url: "", has_custom_certificate: false, pending_update_count: 0 } };
      if (method === "getUpdates") { offsets.push((payload as { offset: number }).offset); return { ok: true, result: [update] }; }
      throw new Error("unexpected_method");
    });
    const channel = new Telegram("unused", bot); await channel.activate(c.value);
    const receive = c.value.receive; c.value.receive = () => { throw new Error("disk_full"); };
    await expect(channel.once()).rejects.toThrow(); expect(c.checkpoints.has("update")).toBe(false);
    c.value.receive = receive; await channel.once(); expect(c.checkpoints.get("update")).toBe(50);
    expect(offsets).toEqual([0, 0]); expect(c.messages[0]!.reply.messageId).toBe("7");
  });
  it("refuses polling a Telegram bot that already has a webhook without deleting it", async () => {
    const c = context(), methods: string[] = [], bot = new Bot("123:test", { botInfo: { id: 123, is_bot: true, first_name: "bot", username: "testbot" } });
    bot.api.config.use(async (_previous, method) => {
      methods.push(method);
      return { ok: true, result: { url: "https://existing.example.test/webhook", has_custom_certificate: false, pending_update_count: 0 } };
    });
    await expect(new Telegram("unused", bot).activate(c.value)).rejects.toMatchObject({ status: 409, code: "telegram_existing_webhook_must_be_removed" });
    expect(methods).toEqual(["getWebhookInfo"]); expect(c.messages).toHaveLength(0);
  });
  it("skips old Telegram backlog when a connection is first activated", async () => {
    const c = context(), bot = new Bot("123:test", { botInfo: { id: 123, is_bot: true, first_name: "bot", username: "testbot" } });
    bot.api.config.use(async (_previous, method) => method === "getWebhookInfo" ? { ok: true, result: { url: "", has_custom_certificate: false, pending_update_count: 0 } } :
      ({ ok: true, result: [{ update_id: 50, message: { message_id: 7, date: 1, from: { id: 456, is_bot: false, first_name: "owner" }, chat: { id: 456, type: "private", first_name: "owner" }, text: "old" } }] }));
    const channel = new Telegram("unused", bot); await channel.activate(c.value); await channel.once();
    expect(c.messages).toHaveLength(0); expect(c.checkpoints.get("update")).toBe(50);
  });
  it("retains Grove Mail's scoped immutable event snapshot and reply idempotency key", async () => {
    const c = context(), requests: Array<{ path: string; body: unknown; key: string | null }> = [];
    const inbox = "agent@example.test", date = "2999-01-01T00:00:00Z";
    const http = new ServiceHttp("https://mail.example.test", "secret", async (url, init) => {
      const path = String(url); requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get("idempotency-key") });
      if (path.endsWith("/reply")) return Response.json({ status: "accepted", message_id: "sent" });
      if (path.includes("events/lifecycle")) return Response.json({ next_cursor: 2, events: [
        { sequence: 1, inbox_id: inbox, event_id: "old", type: "message.received", created_at: "2000-01-01T00:00:00Z", data: {} },
        { sequence: 2, inbox_id: inbox, event_id: "event", type: "message.received", created_at: date,
          data: { message: { inbox_id: inbox, message_id: "message", thread_id: "thread", from: "Owner <owner@example.test>", to: [inbox], extracted_text: "current", text: "quoted history", subject: "hello" } } },
      ] });
      return Response.json({ inbox_id: inbox });
    });
    const channel = new Mail(inbox, http); await channel.activate(c.value); await channel.once();
    expect(c.messages).toHaveLength(1); expect(c.messages[0]!.text).toBe("主题：hello\n\ncurrent");
    expect(c.messages[0]!.sender).toBe("owner@example.test"); expect(c.checkpoints.get("cursor")).toBe(2);
    await channel.send({ connectionId: "channel", ...c.messages[0]!.reply }, "reply", "stable-key");
    expect(requests.at(-1)).toMatchObject({ body: { text: "reply" }, key: "stable-key" });
  });
  it("does not advance a Mail cursor when receipt fails, or silently reset an expired cursor", async () => {
    const c = context(), inbox = "agent@example.test"; let expired = false;
    const http = new ServiceHttp("https://mail.example.test", "secret", async (url) => {
      if (!String(url).includes("events/lifecycle")) return Response.json({ inbox_id: inbox });
      if (expired) return Response.json({ error: "cursor_expired" }, { status: 410 });
      return Response.json({ next_cursor: 5, events: [{ sequence: 5, inbox_id: inbox, event_id: "event", type: "message.received", created_at: "2999-01-01T00:00:00Z",
        data: { message: { inbox_id: inbox, message_id: "message", from: "owner@example.test", text: "hello" } } }] });
    });
    const channel = new Mail(inbox, http); await channel.activate(c.value);
    c.value.receive = () => { throw new Error("disk_full"); }; await expect(channel.once()).rejects.toThrow("disk_full");
    expect(c.checkpoints.has("cursor")).toBe(false); expired = true; await expect(channel.once()).rejects.toMatchObject({ status: 410 });
    expect(c.checkpoints.has("cursor")).toBe(false);
  });
  it("recognizes Grove Mail's actual structured uncertain-send error without resubmitting", async () => {
    const c = context(), inbox = "agent@example.test";
    const http = new ServiceHttp("https://mail.example.test", "secret", async (url) =>
      String(url).endsWith("/reply") ? Response.json({ name: "BadGateway", code: "send_uncertain", message: "SMTP outcome unknown", error: { code: "send_uncertain", message: "SMTP outcome unknown" } }, { status: 502 }) : Response.json({ inbox_id: inbox }));
    const channel = new Mail(inbox, http); await channel.activate(c.value);
    await expect(channel.send({ ...route, target: inbox }, "reply", "stable-key")).rejects.toMatchObject({ disposition: "uncertain", message: "mail_submission_unknown" });
  });
  it("isolates mail with multiple recipients instead of mixing it into private owner context", async () => {
    const c = context(), inbox = "agent@example.test";
    const http = new ServiceHttp("https://mail.example.test", "secret", async (url) => Response.json(String(url).includes("events/lifecycle") ? { next_cursor: 1,
      events: [{ sequence: 1, inbox_id: inbox, event_id: "group", type: "message.received", created_at: "2999-01-01T00:00:00Z",
        data: { message: { inbox_id: inbox, message_id: "m", thread_id: "thread", from: "owner@example.test", to: [inbox], cc: ["other@example.test"], text: "group" } } }] } : {}));
    const channel = new Mail(inbox, http); await channel.activate(c.value); await channel.once();
    expect(c.messages[0]).toMatchObject({ scope: "group", groupId: "thread" });
  });
  it("preserves Tencent's lossless 64-bit message identifiers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ret":0,"msgs":[{"message_id":18446744073709551610}],"get_updates_buf":"cursor"}')));
    const value = await getUpdates({ baseUrl: "https://ilinkai.weixin.qq.com", token: "secret", get_updates_buf: "", timeoutMs: 1000 });
    expect(value.msgs![0]!.message_id).toBe("18446744073709551610");
  });
  it("freezes each Weixin reply context token and advances its cursor after receipt", async () => {
    const c = context(), sent: unknown[] = [];
    const api = { updates: async () => ({ ret: 0, msgs: [{ message_id: "one", from_user_id: "owner", message_type: 1, context_token: "context-one", item_list: [{ type: 1, text_item: { text: "hello" } }] }], get_updates_buf: "next" }),
      send: async (body: unknown) => { sent.push(body); return { ret: 0, message_id: "reply" }; } };
    const channel = new Weixin({ accountId: "bot", userId: "owner", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com" }, api);
    await channel.activate(c.value); await channel.once(); expect(c.checkpoints.get("cursor")).toBe("next");
    await channel.send({ connectionId: "channel", ...c.messages[0]!.reply }, "reply", "key");
    expect(sent[0]).toMatchObject({ msg: { from_user_id: "", to_user_id: "owner", context_token: "context-one", client_id: "key:0" } });
  });
  it("holds Weixin cursors on failed receipts and surfaces an expired login", async () => {
    const c = context(); let expired = false;
    const api = { updates: async () => expired ? { ret: -14 } : { ret: 0, msgs: [{ message_id: "one", from_user_id: "owner", message_type: 1, item_list: [{ type: 1, text_item: { text: "hello" } }] }], get_updates_buf: "next" }, send: async () => ({ ret: 0 }) };
    const channel = new Weixin({ accountId: "bot", userId: "owner", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com" }, api);
    await channel.activate(c.value); c.value.receive = () => { throw new Error("disk_full"); }; await expect(channel.once()).rejects.toThrow("disk_full");
    expect(c.checkpoints.has("cursor")).toBe(false); expired = true; await expect(channel.once()).rejects.toMatchObject({ code: "weixin_login_expired" });
    await expect(channel.send({ ...route, data: {} }, "reply", "key")).rejects.toThrow("weixin_reply_context_missing");
    await expect(channel.send({ ...route, data: { contextToken: "token", groupId: "group" } }, "reply", "key")).rejects.toThrow("weixin_group_reply_not_supported");
  });
  it("refuses replacing a connection with a different Weixin account", async () => {
    const c = context(); c.checkpoints.set("account", "previous");
    const channel = new Weixin({ accountId: "bot", userId: "owner", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com" });
    await expect(channel.activate(c.value)).rejects.toThrow("channel_account_changed");
  });
});

it("receives Matrix plain chat in its existing transaction and leaves its cursor untouched on receipt failure", async () => {
  const agent = "@bot:example.test", owner = "@owner:example.test", store = new DurableStore(":memory:", agent);
  try {
    const sent: Array<{ txn: string; content: object }> = [];
    const transport: MatrixTransport = { identity: async () => agent, sync: async () => ({ next_batch: "idle" }), history: async () => ({ events: [] }),
      createRoom: async () => "!room:example.test", join: async () => {}, stop: () => {},
      state: async () => [agent, owner].map((id) => ({ type: "m.room.member", state_key: id, content: { membership: "join" } } as RoomEvent)),
      send: async (_room, _type, content, txn) => { sent.push({ txn, content }); return "$reply"; } };
    const connector = new MatrixConnector(agent, store, transport, undefined), channel = new MatrixChannel(connector);
    const core = new CommunicationCore("agent", store, connector.cli!); core.register({ id: "matrix", ownerAddresses: [owner] }, channel); await core.start();
    const receipt = core.context("matrix"), receive = receipt.receive; let fail = true;
    receipt.receive = (message) => { if (fail) throw new Error("disk_full"); receive(message); }; await channel.start(receipt);
    const event = { event_id: "$input", sender: owner, type: "m.room.message", origin_server_ts: Date.now() + 1000, content: { msgtype: "m.text", body: "hello" } };
    const batch = { next_batch: "next", rooms: { join: { "!room:example.test": { timeline: { events: [event] } } } } };
    await expect(connector.acceptSync(batch)).rejects.toThrow("disk_full"); expect(store.get("meta", "sync")).toBeUndefined(); expect(core.status().inbox).toHaveLength(0);
    fail = false; await connector.acceptSync(batch); expect(store.get("meta", "sync")).toBe("next"); expect(core.status().inbox).toHaveLength(1);
    await channel.send({ connectionId: "matrix", target: "!room:example.test", messageId: "$input", data: { sender: owner } }, "reply", "stable");
    expect(sent[0]).toMatchObject({ txn: "stable-0", content: { "m.relates_to": { "m.in_reply_to": { event_id: "$input" } } } });
  } finally { store.close(); }
});

it("validates duplicate connections and keeps channel secrets out of config values", () => {
  const matrix = { id: "matrix", kind: "matrix" };
  expect(() => channelConfigSchema.parse({ agents: [{ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", connections: [matrix, matrix] }] })).toThrow("duplicate_connection_id");
  expect(() => channelConfigSchema.parse({ agents: [{ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", connections: [{ id: "telegram", kind: "telegram", token: "inline" }] }] })).toThrow();
});

it("classifies non-JSON HTTP rejection before trying to parse its response", async () => {
  const http = new ServiceHttp("https://host.example.test", "secret", async () => new Response("unauthorized", { status: 401 }));
  await expect(http.request("/v1/health")).rejects.toBeInstanceOf(ChannelHttpError);
});
