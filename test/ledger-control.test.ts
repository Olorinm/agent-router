import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacySession } from "../src/ledger/ledger.js";
import { personId } from "../src/ledger/registry.js";
import { enc, ik, owner, root, setup, until } from "./ledger-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
type T = Awaited<ReturnType<typeof setup>>;
const running = (t: T) => until(t.events, (items) => items.some((event) => event.kind === "turn" && event.state === "running"))
  .then((items) => items.find((event) => event.kind === "turn" && event.state === "running").turnId as string);
const turnState = (t: T, turnId: string, state: string) => until(t.events, (items) => items.some((event) => event.kind === "turn" && event.turnId === turnId && event.state === state));
async function socket(t: T) {
  const { ticket } = (await t.api(`${root}/web/socket-tickets`, "alice", "POST", {})).data;
  const ws = new WebSocket(`ws://127.0.0.1:${t.port}${root}/web/socket?ticket=${ticket}`);
  const frames: any[] = [];
  ws.addEventListener("message", (event) => frames.push(event.data === "pong" ? "pong" : JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  cleanup.push(() => ws.close());
  ws.send(JSON.stringify({ type: "req", id: "1", method: "subscribe", params: { chats: [{ chatId: t.chatId }] } }));
  await until(() => frames, (items) => items.some((frame) => frame.id === "1"));
  return frames;
}

describe("cancel and steer (ADR 0005 16.2)", () => {
  it("cancels a channel turn from the web, and work and schedule turns through the run API", async () => {
    const t = await setup(cleanup);
    t.host.hold = true;
    await t.send({ idempotencyKey: ik(), text: "长任务" });
    const turnId = await running(t);
    expect(await t.api(`${t.chat}/turns/${enc(turnId)}/cancel`, "alice", "POST", {})).toEqual({ status: 200, data: { status: "accepted" } });
    await turnState(t, turnId, "canceled");
    expect(t.host.cancels).toEqual(["run-1"]);
    const events = await t.events();
    expect(events.filter((event) => event.kind === "notice" && event.text === "正在停止当前任务。")).toMatchObject([{ turnId }]);
    expect(await t.api(`${t.chat}/turns/${enc(turnId)}/cancel`, "alice", "POST", {})).toEqual({ status: 200, data: { status: "already_finished", state: "canceled" } });
    expect(await t.api(`${t.chat}/turns/t-missing/cancel`, "alice", "POST", {})).toEqual({ status: 404, data: { error: "turn_not_found" } });
    expect((await t.api(`${t.chat}/turns/${enc(turnId)}/cancel`, "bob", "POST", {})).status).toBe(404);
    // Work and schedule turns have no inbox record; their scope is now the ledger turn.
    const work = await t.api(`${root}/agents/${t.agent.id}/communication/work-events`, "alice", "POST", { eventId: "work-1", input: "整理文件" });
    expect((await t.api(`${root}/agents/${t.agent.id}/communication/tasks/${work.data.taskId}/cancel`, "alice", "POST", {})).data).toEqual({ status: "accepted" });
    const schedule = await t.extension().sessions!.submit({ eventId: "schedule-1", input: "每日汇总",
      admission: { kind: "schedule", owner, agentId: t.agent.id, reference: "rule-1", toolGrants: {} } });
    expect((await t.api(`${root}/agents/${t.agent.id}/communication/tasks/${schedule.taskId}/cancel`, "alice", "POST", {})).data).toEqual({ status: "accepted" });
    await until(() => t.extension().sessions!.get("schedule-1"), (event) => event.status === "cancelled" || event.cancelRequested === true || event.status === "canceled");
  }, 30_000);

  it("steers a running turn, idempotently, and reports unsupported kernels", async () => {
    const t = await setup(cleanup);
    t.host.hold = true;
    await t.send({ idempotencyKey: ik(), text: "写报告" });
    const turnId = await running(t), key = ik();
    const steer = (body: Record<string, unknown>) => t.api(`${t.chat}/turns/${enc(turnId)}/steer`, "alice", "POST", body);
    const first = await steer({ idempotencyKey: key, text: "顺便把结论写成表格" });
    expect(first).toMatchObject({ status: 200, data: { status: "accepted", event: { kind: "message", role: "user", text: "顺便把结论写成表格", steer: true, turnId,
      idempotencyKey: key, sender: { type: "person", id: personId(owner) }, channel: { kind: "web" } } } });
    expect((await steer({ idempotencyKey: key, text: "顺便把结论写成表格" })).data.event.eventId).toBe(first.data.event.eventId);
    expect(await steer({ idempotencyKey: key, text: "别的" })).toEqual({ status: 409, data: { error: "idempotency_key_reused" } });
    expect(t.host.steers).toEqual([{ runId: "run-1", input: "顺便把结论写成表格" }]);
    t.host.steerUnsupported = true;
    expect((await steer({ idempotencyKey: ik(), text: "再补充" })).data).toEqual({ status: "unsupported" });
    expect((await t.events()).filter((event) => event.steer)).toHaveLength(1);
    t.host.steerUnsupported = false; t.host.hold = false;
    await turnState(t, turnId, "completed");
    expect(await steer({ idempotencyKey: ik(), text: "太晚了" })).toEqual({ status: 409, data: { error: "turn_not_running" } });
  }, 30_000);
});

describe("reset (ADR 0005 16.3)", () => {
  it("refuses while busy, cancels with cancelActive and starts the next turn in a new window and Host session", async () => {
    const t = await setup(cleanup);
    t.host.hold = true;
    await t.send({ idempotencyKey: ik(), text: "第一轮" });
    const turnId = await running(t);
    const reset = (body: Record<string, unknown>) => t.api(`${t.chat}/reset`, "alice", "POST", body);
    expect(await reset({ idempotencyKey: ik() })).toEqual({ status: 409, data: { error: "session_busy", activeTurns: [turnId], queuedInputs: 0 } });
    const key = ik();
    const done = await reset({ idempotencyKey: key, cancelActive: true });
    expect(done).toMatchObject({ status: 200, data: { window: 2, event: { kind: "window", window: 2, reason: "reset" } } });
    expect((await reset({ idempotencyKey: key, cancelActive: true })).data).toEqual(done.data);
    await turnState(t, turnId, "canceled");
    t.host.hold = false;
    await t.send({ idempotencyKey: ik(), text: "第二轮" });
    await until(t.events, (items) => items.some((event) => event.kind === "message" && event.text === "回答-2"));
    const sessionKey = legacySession(t.agent.id, "owner-main");
    expect((t.host.starts[1]!.context as any).conversationId).toBe(`${sessionKey}.w2`);
    expect(t.host.starts[1]!.sessionId).not.toBe(t.host.starts[0]!.sessionId);
    expect(t.ledger.session(sessionKey)!.window).toBe(2);
    expect(t.ledger.contextFor(sessionKey)).toBe(`${sessionKey}.w2`);
    // Owner admission still holds in the new window.
    expect(t.host.starts[1]!.admission).toMatchObject({ kind: "owner" });
    const kinds = (await t.events()).filter((event) => ["window", "message"].includes(event.kind)).map((event) => event.kind === "window" ? `window:${event.window}` : event.text);
    // The canceled turn's late final message still lands, tagged with the old window.
    expect(kinds).toEqual(["第一轮", "window:2", "已取消。", "第二轮", "回答-2"]);
    expect(t.ledger.events(sessionKey).filter((event) => event.kind === "message").map((event) => event.window)).toEqual([1, 1, 2, 2]);
  }, 30_000);

  it("runs /new from a Feishu owner DM against the shared session, replying only there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-feishu-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "secret"), "feishu-secret");
    const t = await setup(cleanup, {}, [{ id: "matrix", kind: "matrix" }, { id: "feishu", kind: "feishu", appId: "cli_test", appSecretFile: join(dir, "secret"), ownerAddresses: ["ou_owner"] }]);
    await t.send({ idempotencyKey: ik(), text: "网页消息" });
    await until(t.events, (items) => items.some((event) => event.text === "回答-1"));
    const feishu = (externalId: string, text: string) => t.extension().communication!.receive("feishu", { externalId, sender: "ou_owner", scope: "direct",
      threadId: "oc_dm", text, reply: { target: "oc_dm", messageId: externalId, data: {} } });
    feishu("om_new", "/new");
    const events = await until(t.events, (items) => items.some((event) => event.kind === "notice" && event.text === "已开始新对话。"));
    expect(events.find((event) => event.kind === "window")).toMatchObject({ window: 2, reason: "reset" });
    const notice = events.find((event) => event.text === "已开始新对话。");
    expect(notice.channel).toEqual({ kind: "feishu" });
    expect(t.ledger.deliveriesFor(notice.eventId)).toMatchObject([{ connectionId: "feishu", purpose: "notice" }]);
    expect(t.host.starts).toHaveLength(1);
    // Busy: the command refuses and says so in that conversation.
    t.host.hold = true;
    await t.send({ idempotencyKey: ik(), text: "长任务" });
    await until(t.events, (items) => items.filter((event) => event.kind === "turn" && event.state === "running").length >= 2);
    feishu("om_new2", "新对话");
    await until(t.events, (items) => items.some((event) => event.text === "当前任务进行中，请先停止。"));
    expect(t.ledger.session(legacySession(t.agent.id, "owner-main"))!.window).toBe(2);
  }, 30_000);
});

describe("purge (ADR 0005 16.4)", () => {
  it("needs the typed confirmation, deletes the transcript, tombstones claims and continues in a new window", async () => {
    const t = await setup(cleanup);
    await t.send({ idempotencyKey: ik(), text: "要删掉的话" });
    const matrix = { externalId: "$m1", sender: owner, scope: "direct" as const, threadId: "!dm:example.test", text: "Matrix 私信",
      reply: { target: "!dm:example.test", messageId: "$m1", data: { sender: owner, thread: "" } } };
    t.extension().communication!.receive("matrix", matrix);
    const before = await until(t.events, (items) => items.some((event) => event.text === "回答-2"));
    const frames = await socket(t);
    const purge = (body: Record<string, unknown>) => t.api(`${t.chat}/purge`, "alice", "POST", body);
    expect(await purge({ idempotencyKey: ik(), confirm: "dm:other" })).toEqual({ status: 422, data: { error: "purge_confirmation_required" } });
    const done = await purge({ idempotencyKey: ik(), confirm: t.chatId });
    expect(done).toEqual({ status: 200, data: { generation: 2, purgedEvents: before.length, window: 2 } });
    await until(() => frames, (items) => items.some((frame) => frame.event === "snapshot_required" && frame.data.reason === "generation_changed"));
    const page = (await t.api(`${t.chat}/events`)).data;
    expect(page).toMatchObject({ generation: 2, lastSeq: 1, events: [{ seq: 1, kind: "window", window: 2 }] });
    expect(JSON.stringify(page)).not.toContain("要删掉的话");
    const store = (await t.service.runtime(t.agent.id)).connector.store;
    expect(JSON.stringify(store.entries("communication_inbox"))).not.toContain("要删掉的话");
    expect(t.ledger.claimFor("matrix", "$m1")).toMatchObject({ state: "tombstone", eventId: null });
    // A redelivered channel message does not come back.
    t.extension().communication!.receive("matrix", matrix);
    await new Promise((r) => setTimeout(r, 300));
    expect((await t.events()).map((event) => event.kind)).toEqual(["window"]);
    // The chat continues in the new window and execution context.
    await t.send({ idempotencyKey: ik(), text: "重新开始" });
    const after = await until(t.events, (items) => items.some((event) => event.text === "回答-3"));
    expect(after.map((event) => event.seq)).toEqual(after.map((_event, index) => index + 1));
    expect((t.host.starts[2]!.context as any).conversationId).toBe(`${legacySession(t.agent.id, "owner-main")}.w2`);
    expect((await t.api(`${root}/web/chats/${enc(t.chatId)}`)).data).toMatchObject({ generation: 2, readSeq: 0 });
  }, 30_000);
});
