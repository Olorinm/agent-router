import { afterEach, describe, expect, it } from "vitest";
import { CommunicationCore } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import { HostWorker } from "../src/execution/host-worker.js";
import type { HostPort, HostRun } from "../src/execution/host.js";
import type { ChannelAdapter, ChannelContext, ChannelMessage, NotifyPolicy, ReplyRoute } from "../src/channels/api.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

class Host implements HostPort {
  identity = "fixture-host";
  runs = new Map<string, HostRun>();
  async connect() {}
  async start(input: Parameters<HostPort["start"]>[0]): Promise<HostRun> {
    const run: HostRun = { id: `run-${this.runs.size + 1}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "completed", answer: "做完了" };
    this.runs.set(run.id, run); return run;
  }
  async get(id: string) { return this.runs.get(id)!; }
  async cancel() {}
  async calls() { return []; }
  async resolve() {}
}
/** A two-way channel. `transcript` makes it a transcript surface (web): its replies are recorded, not sent. */
class Chat implements ChannelAdapter {
  readonly retrySafe = true;
  readonly capabilities = { receive: ["text"], send: ["text"], stream: false, buttons: false, native: [] };
  sent: string[] = [];
  context!: ChannelContext;
  constructor(readonly kind: string, readonly ledgerDelivery = false) {}
  async start(context: ChannelContext) { this.context = context; }
  async stop() {}
  async send(_route: ReplyRoute, text: string) { this.sent.push(text); return { externalId: `m${this.sent.length}` }; }
  say(id: string, from: string, text: string, scope: ChannelMessage["scope"] = "direct") {
    this.context.receive({ externalId: id, sender: from, threadId: scope === "direct" ? from : "group-1", scope, text, ...(scope === "group" ? { groupId: "group-1" } : {}),
      reply: { target: from, messageId: id, data: {} } });
  }
}
/** A one-way push channel. */
class Push implements ChannelAdapter {
  readonly kind = "push";
  readonly retrySafe = false;
  readonly capabilities = { receive: [], send: ["text"], stream: false, buttons: false, native: [] };
  pushed: Array<{ text: string; data: Record<string, string> }> = [];
  async start() {}
  async stop() {}
  async send(route: ReplyRoute, text: string) { this.pushed.push({ text, data: route.data }); return { externalId: `p${this.pushed.length}` }; }
}

async function setup(policy: Partial<NotifyPolicy> = {}) {
  const store = new DurableStore(":memory:", "agent"); cleanup.push(() => store.close());
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("agent", store, work);
  const web = new Chat("surface", true), im = new Chat("im"), push = new Push();
  core.register({ id: "web", ownerAddresses: ["owner"], peerAddresses: ["peer"], groupIds: ["group-1"] }, web);
  core.register({ id: "im", ownerAddresses: ["owner"] }, im);
  core.register({ id: "push", ownerAddresses: [], notify: { replies: true, replyAfterSeconds: 0, questions: true, schedules: true, ...policy } }, push);
  await core.start();
  const worker = new HostWorker("agent", "instance", store, work, new Host(), "fixture", "", () => {}, (id, text) => core.saveResult(id, text));
  // Owner messages of every channel share owner-main, so a second turn starts after the first: run a few rounds.
  const run = async () => { for (let round = 0; round < 3; round++) { await core.dispatch(); await worker.tick(); await core.dispatch(); await core.flush(); } };
  const task = (externalId: string) => core.status().inbox.find((item) => item.id && core.input(item.taskId ?? "")?.source.externalId === externalId)!.taskId!;
  return { core, web, im, push, run, task };
}

describe("owner notifications", () => {
  it("an owner's web turn is pushed; a turn on a channel that reaches the owner itself is not", async () => {
    const { web, im, push, run } = await setup();
    web.say("w1", "owner", "查一下机票");
    im.say("i1", "owner", "查一下酒店");
    await run();
    expect(im.sent).toEqual(["做完了"]);
    expect(push.pushed).toEqual([{ text: "做完了", data: { purpose: "reply", sessionKey: expect.stringMatching(/^c-/) } }]);
  });

  it("peers, groups, quick answers and chats open in a browser are not pushed", async () => {
    const quick = await setup({ replyAfterSeconds: 3600 });
    quick.web.say("w1", "owner", "几点了");
    await quick.run();
    expect(quick.push.pushed).toEqual([]);

    const others = await setup();
    others.web.say("p1", "peer", "你好");
    others.web.say("g1", "owner", "@agent 总结一下", "group");
    await others.run();
    expect(others.push.pushed).toEqual([]);

    const open = await setup();
    open.core.watching = () => true;
    open.web.say("w1", "owner", "查一下机票");
    await open.run();
    expect(open.push.pushed).toEqual([]);

    const unknown = await setup();
    unknown.core.watching = () => { throw new Error("hub_unavailable"); };
    unknown.web.say("w1", "owner", "查一下机票");
    await unknown.run();
    expect(unknown.push.pushed).toHaveLength(1);
  });

  it("questions and schedule notices on the web are pushed once each, as the policy allows", async () => {
    const { core, web, push, run, task } = await setup();
    web.say("w1", "owner", "发邮件");
    await run(); push.pushed = [];
    const input = core.input(task("w1"))!;
    core.notice(input, "要发送这封邮件吗？", "question:call-1");
    core.notice(input, "要发送这封邮件吗？", "question:call-1");
    core.notice(input, "已撤回", "stale-action");
    core.queueContent(task("w1"), { text: "九点开会" }, "work-event:e1", { notice: "schedule:e1" });
    core.queueContent(task("w1"), { text: "九点开会" }, "work-event:e1", { notice: "schedule:e1" });
    await core.flush();
    expect(push.pushed).toEqual([{ text: "要发送这封邮件吗？", data: expect.objectContaining({ purpose: "question" }) },
      { text: "九点开会", data: expect.objectContaining({ purpose: "schedule" }) }]);

    const off = await setup({ questions: false, schedules: false });
    off.web.say("w1", "owner", "发邮件");
    await off.run(); off.push.pushed = [];
    off.core.notice(off.core.input(off.task("w1"))!, "要发送这封邮件吗？", "question:call-1");
    off.core.queueContent(off.task("w1"), { text: "九点开会" }, "work-event:e1", { notice: "schedule:e1" });
    await off.core.flush();
    expect(off.push.pushed).toEqual([]);
  });
});
