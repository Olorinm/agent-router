import { afterEach, expect, it, vi } from "vitest";
import { MatrixChannel } from "../src/channels/matrix.js";
import { CommunicationCore } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import type { MatrixConnector } from "../src/matrix/connector.js";
import type { ChannelAdapter, ChannelContext, ChannelMessage } from "../src/communication/types.js";

const close: Array<() => void> = [];
afterEach(() => { close.splice(0).forEach((fn) => fn()); });

function matrix(members: string[], trusted = (id: string) => ["@owner:hs", "@_ar_peer:hs"].includes(id), group = false) {
  const messages: ChannelMessage[] = [], saved = new Map<string, unknown>();
  const context: ChannelContext = { receive: (message) => { messages.push(message); }, error() {}, checkpoint: ((key: string, value?: unknown) => {
    if (value === undefined) return saved.get(key); saved.set(key, value);
  }) as ChannelContext["checkpoint"] };
  const connector = { userId: "@_ar_self:hs", store: { get: () => ({ members, ...(group ? { group } : {}) }) } } as unknown as MatrixConnector & { onTextMessage?: (room: string, event: unknown) => void };
  const channel = new MatrixChannel(connector, { trusted });
  const send = async (content: Record<string, unknown>, sender = "@owner:hs") => {
    connector.onTextMessage!("!room:hs", { event_id: `$${messages.length}`, sender, type: "m.room.message", origin_server_ts: Date.now() + 1000, content });
    return messages.at(-1)!;
  };
  return { channel, context, send, messages };
}

it("Matrix groups report intentional mentions, pills, @all text and whether only the owner's agents are present", async () => {
  const room = matrix(["@owner:hs", "@_ar_self:hs", "@_ar_peer:hs"]);
  await room.channel.start(room.context);
  expect((await room.send({ msgtype: "m.text", body: "hi", "m.mentions": { user_ids: ["@_ar_self:hs"] } })).mentions).toEqual({ self: true, all: false });
  expect((await room.send({ msgtype: "m.text", body: "Ada look", formatted_body: '<a href="https://matrix.to/#/@_ar_self:hs">Ada</a> look' })).mentions!.self).toBe(true);
  expect((await room.send({ msgtype: "m.text", body: "@所有人 开会" })).mentions).toEqual({ self: false, all: true });
  expect((await room.send({ msgtype: "m.text", body: "hi", "m.mentions": { room: true } })).mentions!.all).toBe(true);
  const plain = await room.send({ msgtype: "m.text", body: "just chatting about all@example.com" });
  expect(plain.mentions).toEqual({ self: false, all: false });
  expect(plain.privateGroup).toBe(true);

  const mixed = matrix(["@owner:hs", "@_ar_self:hs", "@colleague:hs"]);
  await mixed.channel.start(mixed.context);
  expect((await mixed.send({ msgtype: "m.text", body: "x" })).privateGroup).toBe(false);

  const pair = matrix(["@owner:hs", "@_ar_self:hs"], undefined, true);
  await pair.channel.start(pair.context);
  const marked = await pair.send({ msgtype: "m.text", body: "x" });
  expect(marked.scope).toBe("group"); expect(marked.privateGroup).toBe(true);

  const direct = matrix(["@owner:hs", "@_ar_self:hs"]);
  await direct.channel.start(direct.context);
  const message = await direct.send({ msgtype: "m.text", body: "x" });
  expect(message.scope).toBe("direct"); expect(message.mentions).toBeUndefined(); expect(message.privateGroup).toBeUndefined();
});

it("an owner's addressed group message starts work; unaddressed, agent and outsider messages do not", async () => {
  const store = new DurableStore(":memory:", "groups"); close.push(() => store.close());
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("groups", store, work);
  const adapter: ChannelAdapter = { kind: "matrix", retrySafe: true, capabilities: { receive: ["text"], send: ["text"], stream: false, buttons: false, native: [] },
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), send: async () => ({ externalId: "sent" }) };
  core.register({ id: "matrix", ownerAddresses: ["@owner:hs"], peerAddresses: [], groupIds: [] }, adapter);
  await core.start();
  const receive = (id: string, extra: Partial<ChannelMessage>) => core.receive("matrix", { externalId: id, sender: "@owner:hs", threadId: "!g:hs", scope: "group",
    groupId: "!g:hs", text: "please help", reply: { target: "!g:hs", messageId: id, data: {} }, ...extra });
  expect(receive("plain", { mentions: { self: false, all: false }, privateGroup: true }).state).toBe("ignored");
  expect(receive("me", { mentions: { self: true, all: false }, privateGroup: true }).state).toBe("received");
  expect(receive("everyone", { mentions: { self: false, all: true }, privateGroup: false }).state).toBe("received");
  expect(receive("agent", { sender: "@_ar_peer:hs", mentions: { self: true, all: false }, privateGroup: true }).state).toBe("ignored");
  expect(receive("outsider", { sender: "@colleague:hs", mentions: { self: true, all: false }, privateGroup: false }).state).toBe("ignored");
  await core.dispatch();
  const inbox = core.status().inbox, task = (id: string) => inbox.find((item) => item.id && core.input(item.taskId ?? "")?.source.externalId === id);
  const me = task("me")!, everyone = task("everyone")!;
  expect(core.isPrivateGroupOwnerTask(me.conversationId, me.taskId!)).toBe(true);
  expect(core.isPrivateGroupOwnerTask(everyone.conversationId, everyone.taskId!)).toBe(false);
  expect(core.isOwnerTask(me.conversationId, me.taskId!)).toBe(false);
});
