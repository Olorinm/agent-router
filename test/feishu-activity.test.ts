import { afterEach, describe, expect, it, vi } from "vitest";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { feishuActivity } from "../src/channels/feishu-activity.js";
import { FEISHU_EMOJIS } from "../src/channels/feishu-emojis.js";
import { FeishuChannel } from "../src/channels/feishu.js";
import { CommunicationCore, type OutboxRecord } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import type { ChannelContext, ReplyRoute } from "../src/communication/types.js";

afterEach(() => vi.restoreAllMocks());
const route: ReplyRoute = { connectionId: "feishu", target: "group", messageId: "source", data: {} };
function fixture() {
  const checkpoints = new Map<string, unknown>(), reactions = new Map<string, { emoji: string; app: string }>();
  const context: ChannelContext = { receive: vi.fn(), error: vi.fn(), checkpoint: ((key: string, value?: unknown) => {
    if (value === undefined) return checkpoints.get(key); checkpoints.set(key, value);
  }) as ChannelContext["checkpoint"] };
  const list = vi.fn(async ({ params }: any) => ({ code: 0, data: { has_more: false, page_token: "", items: [...reactions].filter(([, r]) => r.emoji === params.reaction_type)
    .map(([id, r]) => ({ reaction_id: id, operator: { operator_id: r.app, operator_type: "app" as const } })) } }));
  const add = vi.fn(async (_message: string, emoji: string) => { reactions.set("mine", { emoji, app: "app" }); return "mine"; });
  const remove = vi.fn(async ({ path }: any) => { reactions.delete(path.reaction_id); return { code: 0 }; });
  const handlers = new Map<string, (event: any) => void>();
  const native = { on: (name: string, fn: (event: any) => void) => { handlers.set(name, fn); return () => {}; },
    connect: vi.fn(), disconnect: vi.fn(), botIdentity: { openId: "bot" }, addReaction: add,
    send: vi.fn(async () => ({ messageId: "answer" })), rawClient: { im: { v1: { messageReaction: { list, delete: remove } } } } };
  const channel = native as unknown as LarkChannel;
  const update = (active: boolean, key = "turn", choose?: () => string) => feishuActivity(channel, context, "app", route, active, key, choose);
  return { context, checkpoints, reactions, list, add, remove, handlers, native, channel, update };
}

describe("Feishu activity reactions", () => {
  it("chooses once from the whole catalog and preserves that choice across retries and restart", async () => {
    const f = fixture();
    await f.update(true);
    const emoji = f.add.mock.calls[0]![1];
    expect(FEISHU_EMOJIS).toContain(emoji);
    // A new caller has only the durable checkpoint, not the previous in-memory selection.
    await feishuActivity(f.channel, f.context, "app", route, true, "turn", () => "WRONGED");
    expect(f.add).toHaveBeenCalledTimes(1);
    await f.update(false); await f.update(false);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.reactions.get("mine")?.emoji).toBe(emoji);
    // No semantic allowlist: even an emoji unrelated to work passes through unchanged.
    await f.update(true, "other-turn", () => "POOP");
    expect(f.add).toHaveBeenLastCalledWith("source", "POOP");
  });
  it("recovers a lost add response without changing emoji or duplicating notifications", async () => {
    const f = fixture();
    f.add.mockImplementationOnce(async (_id, emoji) => { f.reactions.set("mine", { emoji, app: "app" }); throw new Error("response_lost"); });
    await expect(f.update(true, "turn", () => "HappyDragon")).rejects.toThrow("response_lost");
    await f.update(true, "turn", () => "SMILE");
    expect(f.add).toHaveBeenCalledTimes(1);
    await f.update(false);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.checkpoints.get("activity:turn")).toMatchObject({ emoji: "HappyDragon", phase: "active" });
    expect(f.reactions.get("mine")?.emoji).toBe("HappyDragon");
  });
  it("retains an uncertain addition and preserves pre-existing reactions", async () => {
    const f = fixture();
    f.reactions.set("other-bot", { emoji: "SMILE", app: "another-app" });
    f.add.mockImplementationOnce(async (_id, emoji) => { f.reactions.set("mine", { emoji, app: "app" }); throw new Error("response_lost"); });
    await expect(f.update(true, "turn", () => "SMILE")).rejects.toThrow();
    await f.update(false);
    expect([...f.reactions.keys()]).toEqual(["other-bot", "mine"]);
    await f.update(true, "next", () => "SMILE"); await f.update(false, "next");
    expect([...f.reactions.keys()]).toEqual(["other-bot", "mine"]);
    expect(f.add).toHaveBeenCalledTimes(1);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("ignores old queued cleanup operations without calling Feishu or changing checkpoints", async () => {
    const f = fixture();
    await f.update(false);
    expect(f.checkpoints.size).toBe(0);
    for (const phase of ["selected", "adding", "active", "removing", "removed"]) {
      const saved = { emoji: "SMILE", phase, reactionId: "mine", owned: true };
      f.checkpoints.set("activity:turn", saved);
      await f.update(false); await f.update(false);
      expect(f.checkpoints.get("activity:turn")).toEqual(saved);
    }
    expect(f.list).not.toHaveBeenCalled(); expect(f.add).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it("ignores bot reaction callbacks so automatic feedback cannot start another agent turn", async () => {
    const f = fixture(), channel = new FeishuChannel({ appId: "app", appSecret: "fixture" }, f.channel);
    await channel.start(f.context);
    f.handlers.get("reaction")!({ messageId: "source", operator: { openId: "bot" }, emojiType: "SMILE", action: "added" });
    f.handlers.get("reaction")!({ messageId: "source", operator: { openId: "app-id" }, raw: { operator_type: "app" }, emojiType: "SMILE", action: "removed" });
    expect(f.context.receive).not.toHaveBeenCalled(); expect(f.context.error).not.toHaveBeenCalled();
    await channel.stop();
  });
  it("keeps useful progress and delivers the answer while retaining the receipt", async () => {
    const f = fixture(), store = new DurableStore(":memory:", "agent"), work = new CliWork(store, () => "allow");
    const core = new CommunicationCore("agent", store, work), adapter = new FeishuChannel({ appId: "app", appSecret: "fixture" }, f.channel);
    core.register({ id: "feishu", ownerAddresses: ["owner"] }, adapter);
    try {
      await core.start();
      core.receive("feishu", { externalId: "source", sender: "owner", scope: "direct", threadId: "chat", text: "hello",
        reply: { target: route.target, messageId: route.messageId, data: {} } });
      await core.dispatch(); const task = work.claim("worker")!;
      await core.dispatch(); await core.flush();
      expect(f.add).toHaveBeenCalledTimes(1); expect(f.native.send).not.toHaveBeenCalled();
      work.update(task.claimId!, "progress", "Connection retrying.");
      await core.dispatch(); await core.flush();
      expect(f.add).toHaveBeenCalledTimes(1);
      expect(f.native.send).toHaveBeenCalledWith("group", { text: "Connection retrying." }, expect.anything());
      work.update(task.claimId!, "reply", "answer");
      await core.dispatch(); await core.flush();
      expect(f.native.send).toHaveBeenLastCalledWith("group", { text: "answer" }, expect.anything());
      const stopped = store.entries<OutboxRecord>("communication_outbox").find(r => r.value.activity?.active === false)!;
      expect(stopped.value.state).toBe("accepted");
      await core.flush(Date.now() + 60_000);
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.reactions.size).toBe(1);
    } finally { await core.stop(); store.close(); }
  });
  it("recovers an interrupted outbox send and retains the receipt while waiting for user input", async () => {
    const f = fixture(), store = new DurableStore(":memory:", "agent"), work = new CliWork(store, () => "allow");
    const adapter = new FeishuChannel({ appId: "app", appSecret: "fixture" }, f.channel);
    let core = new CommunicationCore("agent", store, work);
    core.register({ id: "feishu", ownerAddresses: ["owner"] }, adapter);
    try {
      await core.start();
      core.receive("feishu", { externalId: "source", sender: "owner", scope: "direct", threadId: "chat", text: "hello",
        reply: { target: route.target, messageId: route.messageId, data: {} } });
      await core.dispatch(); const task = work.claim("worker")!;
      await core.dispatch(); await core.flush();
      const pending = store.entries<OutboxRecord>("communication_outbox")[0]!;
      store.set("communication_outbox", pending.id, { ...pending.value, state: "submitting" });
      await core.stop();
      core = new CommunicationCore("agent", store, work);
      core.register({ id: "feishu", ownerAddresses: ["owner"] }, new FeishuChannel({ appId: "app", appSecret: "fixture" }, f.channel));
      await core.start(); await core.flush();
      expect(f.add).toHaveBeenCalledTimes(1);
      expect(store.get<OutboxRecord>("communication_outbox", pending.id)?.state).toBe("accepted");
      work.update(task.claimId!, "need-input", "Which option?");
      await core.dispatch(); await core.flush();
      expect(f.reactions.size).toBe(1);
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.native.send).toHaveBeenCalledWith("group", { text: "Which option?" }, expect.anything());
    } finally { await core.stop(); store.close(); }
  });
});
