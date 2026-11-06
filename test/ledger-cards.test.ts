import { afterEach, describe, expect, it } from "vitest";
import { HANDOFF_LINK } from "../src/ledger/control.js";
import { personId } from "../src/ledger/registry.js";
import { enc, ik, owner, root, setup, until } from "./ledger-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const by = { type: "person", id: personId(owner), name: "alice" };

describe("card answers through the web (ADR 0005 16.1)", () => {
  it("answers each interaction family by choice, text or native result and maps the status", async () => {
    const t = await setup(cleanup);
    t.host.plan = (n) => n !== 1 ? [] : [
      { id: "q1", kind: "interaction", name: "clarify", input: { questions: [{ id: "env", question: "哪个环境？" }] } },
      { id: "q2", kind: "interaction", name: "clarify", input: { questions: [{ id: "a", question: "A?" }, { id: "b", question: "B?" }] } },
      { id: "a1", kind: "interaction", name: "item/commandExecution/requestApproval", input: { command: "rm -rf build" } },
      { id: "p1", kind: "interaction", name: "session/request_permission", input: { toolCall: { title: "写文件" },
        options: [{ optionId: "ok", name: "允许", kind: "allow_once" }, { optionId: "no", name: "拒绝", kind: "reject_once" }] } },
      { id: "u1", kind: "interaction", name: "item/tool/requestUserInput", input: { questions: [{ id: "color", question: "颜色", options: [{ label: "红" }, { label: "蓝" }] }] } },
      { id: "e1", kind: "interaction", name: "mcpServer/elicitation/request", input: { message: "填写名字", requestedSchema: { properties: { name: { type: "string" } } } } },
      { id: "n1", kind: "interaction", name: "custom/native", input: { prompt: "原生" } },
    ];
    await t.send({ idempotencyKey: ik(), text: "开始" });
    const cards = Object.fromEntries(await Promise.all(["q1", "q2", "a1", "p1", "u1", "e1", "n1"].map(async (id) => [id, await t.card((card) => card.callId === id)])));
    expect(cards.q1).toMatchObject({ kind: "question", source: "host", freeText: true, status: "pending", choices: [], native: { method: "clarify" } });
    expect(cards.a1).toMatchObject({ kind: "approval", freeText: false, choices: [{ choiceId: "0", label: "同意" }, { choiceId: "1", label: "拒绝" }] });
    expect(cards.u1).toMatchObject({ kind: "question", choices: [{ choiceId: "0", label: "红" }, { choiceId: "1", label: "蓝" }] });
    expect(await t.answer(cards.q2.cardId, { idempotencyKey: ik(), text: "不是 JSON" })).toEqual({ status: 422, data: { error: "invalid_answer", detail: "structured_answers_required" } });
    expect(await t.answer(cards.a1.cardId, { idempotencyKey: ik(), result: { decision: "accept" } })).toEqual({ status: 422, data: { error: "choice_or_text_required" } });
    expect(await t.answer(cards.a1.cardId, { idempotencyKey: ik(), choiceId: "7" })).toEqual({ status: 422, data: { error: "choice_not_found" } });
    expect(await t.answer(cards.a1.cardId, { idempotencyKey: ik() })).toEqual({ status: 422, data: { error: "choice_or_text_required" } });
    const answers: Array<[string, Record<string, unknown>, string, unknown]> = [
      ["q1", { text: "staging" }, "answered", { answers: { env: "staging" } }],
      ["q2", { text: JSON.stringify({ a: "1", b: "2" }) }, "answered", { answers: { a: "1", b: "2" } }],
      ["a1", { choiceId: "0" }, "approved", { decision: "accept" }],
      ["p1", { choiceId: "1" }, "rejected", { outcome: { outcome: "selected", optionId: "no" } }],
      ["u1", { text: "蓝" }, "answered", { answers: { color: { answers: ["蓝"] } } }],
      ["e1", { text: "小王" }, "answered", { action: "accept", content: { name: "小王" } }],
      ["n1", { result: { native: true } }, "answered", { native: true }],
    ];
    for (const [id, body, status, result] of answers) {
      const response = await t.answer(cards[id].cardId, { idempotencyKey: ik(), ...body });
      expect(response).toMatchObject({ status: 200, data: { status: "accepted", card: { cardId: cards[id].cardId, status } } });
      expect(t.host.resolved.find((item) => item.callId === id)?.result).toEqual(result);
    }
    const events = await until(t.events, (items) => items.some((event) => event.kind === "message" && event.role === "assistant"));
    const updates = events.filter((event) => event.kind === "card.update");
    expect(updates.find((event) => event.cardId === cards.a1.cardId)).toMatchObject({ status: "approved", answeredBy: by, summary: "同意" });
    expect(updates.find((event) => event.cardId === cards.q1.cardId)).toMatchObject({ status: "answered", summary: "staging" });
    expect(t.ledger.cardRecord(cards.q1.cardId)).toMatchObject({ surface: "web", answeredBy: personId(owner) });
    expect(events.filter((event) => event.kind === "card").every((event) => event.card.status !== "pending")).toBe(true);
  }, 30_000);

  it("answers Mau connector approvals through the Host port with the result shape Mau parses", async () => {
    const t = await setup(cleanup);
    const card = (id: string) => ({ id, kind: "interaction", name: "approval", input: { question: "发送邮件给 bob", tool: "发送邮件给 bob", choices: ["once", "deny"],
      input: { tool: "mail__send", connection: "mail", arguments: { to: "bob" } } } });
    t.host.plan = (n) => n === 1 ? [card("mau-approval:c1"), card("mau-approval:c2")] : [];
    await t.send({ idempotencyKey: ik(), text: "发邮件" });
    const first = await t.card((item) => item.callId === "mau-approval:c1"), second = await t.card((item) => item.callId === "mau-approval:c2");
    expect(first).toMatchObject({ kind: "connector_approval", source: "mau-approval", choices: [{ label: "允许一次" }, { label: "拒绝" }],
      native: { method: "approval", params: { tool: "发送邮件给 bob" } } });
    expect(await t.answer(first.cardId, { idempotencyKey: ik(), result: { choice: "once" } })).toEqual({ status: 422, data: { error: "choice_or_text_required" } });
    expect((await t.answer(first.cardId, { idempotencyKey: ik(), choiceId: "0" })).data).toMatchObject({ status: "accepted", card: { status: "approved" } });
    expect((await t.answer(second.cardId, { idempotencyKey: ik(), text: "拒绝" })).data).toMatchObject({ status: "accepted", card: { status: "rejected" } });
    // ConnectorApprovals.decide reads `{ choice: "once" | "deny" }`.
    expect(t.host.resolved.map((item) => [item.callId, item.result])).toEqual([["mau-approval:c1", { choice: "once" }], ["mau-approval:c2", { choice: "deny" }]]);
  }, 20_000);

  it("keeps the private handoff link out of history, serves it live while pending, and answers cancel and free text", async () => {
    const t = await setup(cleanup);
    const link = "https://live.example.test/s/secret-handoff-123";
    const handoff = (id: string) => ({ id, kind: "interaction", name: "item/tool/requestUserInput", input: { questions: [{ id: "handoff",
      question: `浏览器已交给你接管。请在此私密链接中操作，不要转发：\n${link}\n完成后直接回到对话告诉 Agent。`, options: [{ label: "取消接管" }] }] } });
    t.host.plan = (n) => n === 1 ? [handoff("mau-handoff:h1"), handoff("mau-handoff:h2")] : [];
    await t.send({ idempotencyKey: ik(), text: "登录网站" });
    const first = await t.card((item) => item.callId === "mau-handoff:h1"), second = await t.card((item) => item.callId === "mau-handoff:h2");
    expect(first).toMatchObject({ kind: "question", source: "mau-handoff", freeText: true, choices: [{ label: "取消接管" }] });
    expect(JSON.stringify(await t.events())).not.toContain("secret-handoff-123");
    expect(first.text).toContain(HANDOFF_LINK);
    const live = await t.api(`${t.chat}/cards/${enc(first.cardId)}`);
    expect(live.data).toMatchObject({ cardId: first.cardId, status: "pending", source: "mau-handoff" });
    expect(live.data.text).toContain(link);
    expect((await t.answer(first.cardId, { idempotencyKey: ik(), choiceId: "0" })).data).toMatchObject({ status: "accepted", card: { status: "answered" } });
    expect((await t.answer(second.cardId, { idempotencyKey: ik(), text: "我登录好了" })).data.status).toBe("accepted");
    // answerHandoff: "取消接管" ends the handoff; other text is steered to the run.
    expect(t.host.resolved.map((item) => item.result)).toEqual([{ answers: { handoff: { answers: ["取消接管"] } } }, { answers: { handoff: { answers: ["我登录好了"] } } }]);
    const closed = await t.api(`${t.chat}/cards/${enc(first.cardId)}`);
    expect(closed.data.status).toBe("answered");
    expect(closed.data.text).not.toContain(link);
    // The 404 scope: a card of another chat, or an unknown card.
    expect(await t.api(`${t.chat}/cards/cd_missing`)).toEqual({ status: 404, data: { error: "card_not_found" } });
    expect(await t.answer("cd_missing", { idempotencyKey: ik(), choiceId: "0" })).toEqual({ status: 404, data: { error: "card_not_found" } });
    expect(await t.answer(first.cardId, { idempotencyKey: ik(), choiceId: "0" }, "bob")).toEqual({ status: 404, data: { error: "chat_not_found" } });
  }, 20_000);

  it("refuses chat answers to sensitive input", async () => {
    const t = await setup(cleanup);
    t.host.plan = (n) => n === 1 ? [{ id: "s1", kind: "interaction", name: "secret", input: { prompt: "token" } }] : [];
    await t.send({ idempotencyKey: ik(), text: "登录" });
    const card = await t.card((item) => item.callId === "s1");
    expect(card).toMatchObject({ kind: "sensitive", freeText: false });
    expect(await t.answer(card.cardId, { idempotencyKey: ik(), text: "hunter2" })).toEqual({ status: 422, data: { error: "sensitive_input_requires_native_entry" } });
    expect(t.host.resolved).toEqual([]);
  }, 20_000);

  it("returns duplicate for a retry, 409 for a reused key, stale for a later answer from any surface", async () => {
    const t = await setup(cleanup);
    const approval = (id: string) => ({ id, kind: "interaction", name: "item/commandExecution/requestApproval", input: { command: id } });
    t.host.plan = (n) => n === 1 ? [approval("c1"), approval("c2"), approval("c3"), approval("c4")] : [];
    await t.send({ idempotencyKey: ik(), text: "执行" });
    const [c1, c2, c3, c4] = await Promise.all(["c1", "c2", "c3", "c4"].map((id) => t.card((item) => item.callId === id)));
    const key = ik();
    expect((await t.answer(c1.cardId, { idempotencyKey: key, choiceId: "0" })).data.status).toBe("accepted");
    expect((await t.answer(c1.cardId, { idempotencyKey: key, choiceId: "0" })).data).toMatchObject({ status: "duplicate", card: { status: "approved" } });
    expect(await t.answer(c1.cardId, { idempotencyKey: key, choiceId: "1" })).toEqual({ status: 409, data: { error: "idempotency_key_reused" } });
    expect((await t.answer(c1.cardId, { idempotencyKey: ik(), choiceId: "1" })).data).toMatchObject({ status: "stale", card: { status: "approved" } });
    // The run surface answers c2 first; the web answer is then stale. Both share one card record.
    const run = await t.api(`${root}/agents/${t.agent.id}/communication/runs/${c2.claimId}/calls/c2/result`, "alice", "POST", { result: { decision: "decline" } });
    expect(run.data).toEqual({ status: "accepted" });
    expect(t.ledger.cardRecord(c2.cardId)).toMatchObject({ status: "rejected", surface: "run-api", answeredBy: personId(owner) });
    expect((await t.answer(c2.cardId, { idempotencyKey: ik(), choiceId: "0" })).data).toMatchObject({ status: "stale", card: { status: "rejected" } });
    expect((await t.api(`${root}/agents/${t.agent.id}/communication/runs/${c2.claimId}/calls/c2/result`, "alice", "POST", { result: { decision: "accept" } })).data)
      .toEqual({ status: "stale" });
    // Mau's call endpoint (`communication/calls/:callId/result`) records into the same card.
    await until(() => t.extension().status() as any, (status) => status.host.calls.some((call: any) => call.id === "c3"));
    expect((await t.api(`${root}/agents/${t.agent.id}/communication/calls/c3/result`, "alice", "POST", { result: { decision: "accept" } })).data).toEqual({ status: "accepted" });
    expect(t.ledger.cardRecord(c3.cardId)).toMatchObject({ status: "approved", surface: "run-api" });
    // A chat answer (Matrix owner DM) to the last open card.
    t.extension().communication!.receive("matrix", { externalId: "$answer", sender: owner, scope: "direct", threadId: "!dm:example.test", text: "同意",
      reply: { target: "!dm:example.test", messageId: "$answer", data: { sender: owner, thread: "" } } });
    await until(() => t.ledger.cardRecord(c4.cardId)!, (card) => card.status !== "pending");
    expect(t.ledger.cardRecord(c4.cardId)).toMatchObject({ status: "approved", surface: "channel", answeredBy: personId(owner), summary: "同意" });
    expect((await t.answer(c4.cardId, { idempotencyKey: ik(), choiceId: "1" })).data.status).toBe("stale");
    expect(t.host.resolved.map((item) => item.callId)).toEqual(["c1", "c2", "c3", "c4"]);
  }, 30_000);

  it("re-resolves a planned answer once after a Host failure between plan and resolve", async () => {
    const t = await setup(cleanup);
    t.host.plan = (n) => n === 1 ? [{ id: "c1", kind: "interaction", name: "clarify", input: { question: "继续吗？" } }] : [];
    await t.send({ idempotencyKey: ik(), text: "开始" });
    const card = await t.card();
    t.host.failResolve = 1;
    const key = ik();
    expect(await t.answer(card.cardId, { idempotencyKey: key, text: "继续" })).toEqual({ status: 503, data: { error: "card_answer_pending", retryAfterMs: 1000 } });
    expect(t.ledger.cardRecord(card.cardId)).toMatchObject({ status: "pending", answerKey: `web:${personId(owner)}:${key}`, result: { answer: "继续" } });
    await until(() => t.ledger.cardRecord(card.cardId)!, (record) => record.status === "answered");
    expect(t.host.resolved).toEqual([{ runId: "run-1", callId: "c1", result: { answer: "继续" } }]);
    // The client's retry gets this request's answer, not a stale.
    expect((await t.answer(card.cardId, { idempotencyKey: key, text: "继续" })).data).toMatchObject({ status: "accepted", card: { status: "answered" } });
    expect((await t.answer(card.cardId, { idempotencyKey: key, text: "继续" })).data.status).toBe("duplicate");
    const events = await until(t.events, (items) => items.some((event) => event.kind === "message" && event.role === "assistant"));
    expect(events.filter((event) => event.kind === "card.update")).toMatchObject([{ status: "answered", answeredBy: by, summary: "继续" }]);
  }, 20_000);

  it("closes cards the Host answered itself, and cancels the open ones when the run ends", async () => {
    const t = await setup(cleanup);
    t.host.plan = (n) => n === 1 ? [{ id: "c1", kind: "interaction", name: "clarify", input: { question: "一" } },
      { id: "c2", kind: "interaction", name: "clarify", input: { question: "二" } }] : [];
    await t.send({ idempotencyKey: ik(), text: "开始" });
    const c1 = await t.card((item) => item.callId === "c1"), c2 = await t.card((item) => item.callId === "c2");
    t.host.answerNatively("run-1", "c1");
    await until(() => t.ledger.cardRecord(c1.cardId)!, (card) => card.status !== "pending");
    expect(t.ledger.cardRecord(c1.cardId)).toMatchObject({ status: "answered", surface: "host", answeredBy: null });
    expect((await t.answer(c1.cardId, { idempotencyKey: ik(), text: "晚了" })).data.status).toBe("stale");
    t.host.runs.get("run-1")!.status = "cancelled";
    await until(() => t.ledger.cardRecord(c2.cardId)!, (card) => card.status !== "pending");
    expect(t.ledger.cardRecord(c2.cardId)!.status).toBe("canceled");
  }, 20_000);

  it("offers 重新执行 / 不用了 for an unknown turn and retries as a possible duplicate", async () => {
    const t = await setup(cleanup);
    t.host.failStart = 1;
    const sent = await t.send({ idempotencyKey: ik(), text: "写周报" });
    const card = await t.card((item) => item.source === "router");
    expect(card).toMatchObject({ kind: "question", source: "router", freeText: false, choices: [{ choiceId: "0", label: "重新执行" }, { choiceId: "1", label: "不用了" }] });
    const turn = (await t.events()).find((event) => event.kind === "turn" && event.state === "unknown");
    expect(turn).toMatchObject({ turnId: card.turnId });
    expect((await t.answer(card.cardId, { idempotencyKey: ik(), choiceId: "0" })).data).toMatchObject({ status: "accepted", card: { status: "answered" } });
    const events = await until(t.events, (items) => items.some((event) => event.kind === "message" && event.role === "assistant" && event.text === "回答-2"));
    const retry = events.filter((event) => event.kind === "message" && event.role === "user");
    expect(retry.map((event) => [event.text, event.possibleDuplicate ?? false])).toEqual([["写周报", false], ["写周报", true]]);
    expect(retry[1].eventId).not.toBe(sent.data.event.eventId);
    expect(t.host.starts).toHaveLength(2);
    expect(events.find((event) => event.kind === "turn" && event.turnId === card.turnId && event.state === "failed")).toBeTruthy();
    // 不用了 closes the next unknown turn without running it again.
    t.host.failStart = 1;
    await t.send({ idempotencyKey: ik(), text: "再写一份" });
    const second = await t.card((item) => item.source === "router" && item.cardId !== card.cardId);
    expect((await t.answer(second.cardId, { idempotencyKey: ik(), text: "不用了" })).data.status).toBe("accepted");
    await until(t.events, (items) => items.some((event) => event.kind === "turn" && event.turnId === second.turnId && event.state === "failed"));
    expect(t.host.starts).toHaveLength(3);
  }, 30_000);

  it("reports the features and keeps the routes off without the flags", async () => {
    const on = await setup(cleanup);
    expect((await on.api(`${root}/web/me`)).data.limits.features).toMatchObject({ send: true, cards: true, reset: true });
    const off = await setup(cleanup, { ledgerCards: false, ledgerControl: false });
    expect((await off.api(`${root}/web/me`)).data.limits.features).toMatchObject({ send: true, cards: false, reset: false });
    expect((await off.answer("cd_x", { idempotencyKey: ik(), choiceId: "0" })).status).toBe(404);
    expect((await off.api(`${off.chat}/reset`, "alice", "POST", { idempotencyKey: ik() })).status).toBe(404);
    const noSend = await setup(cleanup, { ledgerSend: false });
    expect((await noSend.api(`${root}/web/me`)).data.limits.features).toMatchObject({ send: false, cards: false, reset: false });
  }, 20_000);
});
