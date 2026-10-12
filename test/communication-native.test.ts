import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunicationCore } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import { HostWorker } from "../src/execution/host-worker.js";
import { ChannelTools } from "../src/communication/tools.js";
import { interaction } from "../src/communication/interaction.js";
import type { ChannelAdapter, ChannelContent, ChannelMessage } from "../src/communication/types.js";
import type { HostCall, HostPort, HostRun } from "../src/execution/host.js";
const close: Array<() => void> = [];
afterEach(() => { close.splice(0).forEach((fn) => fn()); });
function fixture() {
  const store = new DurableStore(":memory:", "native-test"); close.push(() => store.close());
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("native-test", store, work);
  const sent: ChannelContent[] = [], streamed: Array<{ text: string; final: boolean }> = [];
  const adapter: ChannelAdapter = { kind: "feishu", retrySafe: true,
    capabilities: { receive: ["text", "image"], send: ["text", "image", "file"], stream: true, buttons: true, native: [] },
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    send: async (_route, text) => { sent.push({ text }); return { externalId: "sent" }; },
    sendContent: async (_route, content) => { sent.push(content); return { externalId: "sent" }; },
    readAttachment: vi.fn(async (_source, item) => ({ name: item.name, mediaType: "image/png", data: Buffer.from("image-bytes").toString("base64") })),
    progress: async (_route, text, _key, final) => { streamed.push({ text, final }); return { externalId: "stream" }; },
  };
  core.register({ id: "feishu", ownerAddresses: ["owner"], peerAddresses: ["peer"], groupIds: ["group"] }, adapter);
  const runs: HostRun[] = [], starts: Parameters<HostPort["start"]>[0][] = [], resolved: unknown[] = [];
  let pending: HostCall[] = [], eventPages: any[] = [];
  const host: HostPort = { connect: async () => {},
    start: async (input) => { starts.push(input); const run: HostRun = { id: `run-${runs.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "running", answer: "" }; runs.push(run); return run; },
    get: async (id) => runs.find((run) => run.id === id)!,
    cancel: vi.fn(async (id) => { runs.find((run) => run.id === id)!.status = "cancelled"; }),
    calls: async () => pending,
    resolve: vi.fn(async (_id, callId, result) => { resolved.push(result); pending = pending.filter((call) => call.id !== callId); }),
    steer: vi.fn(async () => {}),
    events: async (_id, after) => eventPages.shift() ?? { events: [], cursor: after, hasMore: false, historyTruncated: false },
    readFile: async () => ({ encoding: "base64", content: Buffer.from([0, 255, 1]).toString("base64") }),
  };
  const worker = new HostWorker("native-test", "worker", store, work, host, "native", "", () => {}, (id, text) => core.saveResult(id, text), undefined, core);
  core.control = (input) => worker.handleInput(input);
  const receive = (id: string, text: string, extra: Partial<ChannelMessage> = {}) => core.receive("feishu", { externalId: id, sender: "owner", threadId: "chat", scope: "direct", text,
    reply: { target: "chat", messageId: id, data: {} }, ...extra });
  const tick = async () => { await core.dispatch(); await worker.tick(); await core.dispatch(); await core.flush(); };
  return { store, work, core, adapter, host, worker, sent, streamed, runs, starts, resolved, receive, tick,
    pending: (call: Partial<HostCall> = {}) => { pending = [{ id: "question", runId: runs[0]!.id, kind: "interaction", name: "item/tool/requestUserInput", input: { questions: [{ id: "date", question: "哪一天？", options: [{ label: "明天" }, { label: "后天" }] }] }, status: "pending", deadlineAt: new Date(Date.now() + 60_000).toISOString(), ...call }]; },
    events: (pages: any[]) => { eventPages = pages; } };
}
describe("native communication round trips", () => {
  it("resumes a worker question as the same task and sends the result to the answering message", async () => {
    const h = fixture(); await h.core.start(); h.receive("one", "安排会议"); await h.core.dispatch();
    const task = h.core.status().inbox[0]!.taskId!; const claim = h.work.claim("external")!;
    h.work.update(claim.claimId!, "need-input", "哪一天？", undefined, "external"); await h.core.dispatch();
    h.receive("two", "明天"); await h.core.dispatch();
    expect(h.core.status().inbox[1]!.taskId).toBe(task); expect(h.work.inspect(task).status).toBe("submitted");
    expect(h.core.input(task)!.replyRoute.messageId).toBe("two");
  });
  it("delivers native questions as buttons and sends a button answer back to that exact call", async () => {
    const h = fixture(); await h.core.start(); h.receive("one", "安排会议"); await h.tick(); h.pending(); await h.tick();
    const question = h.sent.find((item) => item.buttons?.length)!;
    expect(question.text).toContain("哪一天");
    h.receive("answer", "", { action: { token: question.buttons![0]!.token } }); await h.tick();
    expect(h.resolved).toEqual([{ answers: { date: { answers: ["明天"] } } }]); expect(h.starts).toHaveLength(1);
  });
  it("accepts a free text answer without queuing another model task", async () => {
    const h = fixture(); await h.core.start(); h.receive("one", "安排会议"); await h.tick(); h.pending(); await h.tick();
    h.receive("answer", "周五"); await h.tick(); expect(h.starts).toHaveLength(1);
    expect(h.work.list(true)).toHaveLength(1); expect(h.resolved[0]).toEqual({ answers: { date: { answers: ["周五"] } } });
  });
  it("does not let another group sender answer or cancel the current sender's task", async () => {
    const h = fixture(); await h.core.start(); const group = { scope: "group" as const, groupId: "group" };
    h.receive("one", "开始", group); await h.tick(); h.pending(); await h.tick();
    const token = h.sent.find((item) => item.buttons?.length)!.buttons![0]!.token;
    h.receive("wrong", "", { ...group, sender: "peer", action: { token } }); await h.tick();
    h.receive("stop", "/cancel", { ...group, sender: "peer" }); await h.tick();
    expect(h.resolved).toHaveLength(0); expect(h.host.cancel).not.toHaveBeenCalled();
  });
  it("cancels and steers the active run without creating a new task", async () => {
    const h = fixture(); await h.core.start(); h.receive("one", "开始"); await h.tick();
    h.receive("steer", "/steer 改成中文"); await h.tick(); expect(h.host.steer).toHaveBeenCalledWith("run-0", "改成中文");
    h.receive("stop", "/cancel"); await h.tick(); expect(h.host.cancel).toHaveBeenCalledWith("run-0");
    expect(h.work.list(true)).toHaveLength(1);
  });
  it("retries a lost answer acknowledgement with the same result and never starts another run", async () => {
    const h = fixture(); await h.core.start(); h.receive("one", "开始"); await h.tick(); h.pending(); await h.tick();
    const resolve = h.host.resolve; let first = true;
    h.host.resolve = async (...args) => { await resolve(...args); if (first) { first = false; throw new Error("response_lost"); } };
    h.receive("answer", "周五"); await expect(h.core.dispatch()).rejects.toThrow("response_lost"); await h.tick();
    expect(h.starts).toHaveLength(1); expect(h.resolved).toHaveLength(2); expect(h.resolved[0]).toEqual(h.resolved[1]);
    expect(h.store.get<any>("communication_questions", "question")?.closed).toBe(true);
    expect(h.work.list(true)).toHaveLength(1);
  });
  it("passes an image-only message as real bytes to Host and caches its download", async () => {
    const h = fixture(); await h.core.start();
    expect(h.receive("image", "", { attachments: [{ id: "image-key", name: "photo.png", mediaType: "image/*", kind: "image" }] }).state).toBe("received");
    await h.tick(); expect(h.starts[0]!.attachments![0]!.data).toBe(Buffer.from("image-bytes").toString("base64"));
    await h.tick(); expect(h.adapter.readAttachment).toHaveBeenCalledTimes(1);
  });
  it("streams event deltas and updates the same stream with the complete final result", async () => {
    const h = fixture(); await h.core.start(); h.receive("one", "开始");
    h.events([{ events: [{ sequence: 1, event: { type: "assistant.delta", text: "你" } }], cursor: 1, hasMore: false, historyTruncated: false }]); await h.tick();
    h.events([{ events: [{ sequence: 2, event: { type: "assistant.delta", text: "好" } }], cursor: 2, hasMore: false, historyTruncated: false }]); await h.tick();
    h.runs[0]!.status = "completed"; h.runs[0]!.answer = "你好"; await h.tick();
    expect(h.streamed).toEqual([{ text: "你", final: false }, { text: "你好", final: false }, { text: "你好", final: true }]);
    expect(h.sent).toHaveLength(0);
  });
  it("keeps task notices separate from the final stream update", async () => {
    const h = fixture(); await h.core.start(); h.receive("one", "开始");
    h.events([{ events: [{ sequence: 1, event: { type: "assistant.delta", text: "正在处理" } }], cursor: 1, hasMore: false, historyTruncated: false }]); await h.tick();
    const claim = h.work.inspect(h.work.list()[0]!.id);
    h.work.update(claim.claimId!, "progress", "还有一步", undefined, "worker");
    await h.core.dispatch(); await h.core.flush();
    expect(h.streamed.every((item) => !item.final)).toBe(true);
    expect(h.sent.at(-1)!.text).toBe("还有一步");
  });
  it("accepts the explicitly linked owner's answer from another private channel", async () => {
    const h = fixture();
    h.core.register({ id: "telegram", ownerAddresses: ["owner-telegram"] }, { ...h.adapter, kind: "telegram" });
    await h.core.start(); h.receive("one", "开始"); await h.tick(); h.pending(); await h.tick();
    h.core.receive("telegram", { externalId: "answer", sender: "owner-telegram", scope: "direct", threadId: "tg", text: "明天", reply: { target: "tg", messageId: "answer", data: {} } });
    await h.tick(); expect(h.starts).toHaveLength(1); expect(h.resolved).toEqual([{ answers: { date: { answers: ["明天"] } } }]);
  });
  it("does not let a streaming API failure stop tools or questions", async () => {
    const h = fixture(); await h.core.start(); h.receive("one", "开始"); await h.tick(); h.pending();
    h.adapter.progress = async () => { throw new Error("rate_limited"); };
    h.events([{ events: [{ sequence: 1, event: { type: "assistant.delta", text: "你好" } }], cursor: 1, hasMore: false, historyTruncated: false }]); await h.tick();
    expect(h.sent.some((item) => item.buttons?.length)).toBe(true);
  });
  it("sends binary Host workspace files through the channel tool and durable outbox", async () => {
    const h = fixture(); await h.core.start(); h.receive("one", "开始"); await h.tick();
    const tool = new ChannelTools(h.core, h.host);
    await tool.execute({ id: "file", runId: "run-0", kind: "tool", name: "channel", input: { operation: "send", files: [{ path: "output.bin", name: "output.bin", mediaType: "application/octet-stream" }] }, status: "pending", deadlineAt: "2999-01-01" });
    await h.core.flush(); expect(Buffer.from(h.sent.at(-1)!.media![0]!.data, "base64")).toEqual(Buffer.from([0, 255, 1]));
  });
  it("preserves quoted context and records edits without repeating an operation", async () => {
    const h = fixture(); h.receive("one", "原文"); h.receive("two", "解释这个", { quoted: { messageId: "one" } }); await h.core.dispatch();
    const second = h.work.inspect(h.core.status().inbox[1]!.taskId!); expect(JSON.stringify(second.input)).toContain("原文");
    h.receive("edit", "修改原文", { event: { type: "message-edit", data: { messageId: "one" } } }); await h.core.dispatch();
    expect(h.work.list(true)).toHaveLength(2);
  });
  it("reconnects a failed startup after backoff", async () => {
    const h = fixture(); vi.mocked(h.adapter.start).mockRejectedValueOnce(new Error("network_failed")); await h.core.start();
    expect(h.core.status().connections[0]!.started).toBe(false); await h.core.reconnect(Date.now() + 5000);
    expect(h.core.status().connections[0]!.started).toBe(true); expect(h.adapter.start).toHaveBeenCalledTimes(2);
  });
});
it("preserves different native approval response shapes", () => {
  const call = { id: "call", runId: "run", kind: "interaction", status: "pending", deadlineAt: "2999-01-01" };
  expect(interaction({ ...call, name: "permission", input: { input: { command: "echo test" }, toolUseID: "native" } }).answer("同意")).toMatchObject({ behavior: "allow", updatedInput: { command: "echo test" } });
  expect(interaction({ ...call, name: "item/commandExecution/requestApproval", input: {} }).answer("拒绝")).toEqual({ decision: "decline" });
  expect(interaction({ ...call, name: "approval", input: {} }).answer("同意")).toEqual({ choice: "once" });
});
