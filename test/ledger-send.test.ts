import { afterEach, describe, expect, it } from "vitest";
import { CommunicationCore, type InboxRecord, type OutboxRecord } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import { HostWorker } from "../src/execution/host-worker.js";
import type { HostPort, HostRun } from "../src/execution/host.js";
import { AgentLedger, legacySession } from "../src/ledger/ledger.js";
import { personId } from "../src/ledger/registry.js";
import { WEB_CONNECTION, WebChannel } from "../src/channels/web.js";
import type { ChannelAdapter, ChannelContext, ChannelKind, ChannelMessage, ReplyRoute } from "../src/communication/types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class Adapter implements ChannelAdapter {
  context!: ChannelContext;
  sent: Array<{ route: ReplyRoute; text: string; key: string }> = [];
  constructor(readonly kind: ChannelKind, readonly retrySafe = true) {}
  async start(context: ChannelContext) { this.context = context; context.checkpoint("account", `${this.kind}-bot`); }
  async stop() {}
  async send(route: ReplyRoute, text: string, key: string) { this.sent.push({ route, text, key }); return { externalId: `accepted-${key}` }; }
}
class Host implements HostPort {
  identity = "fixture-host";
  starts: Parameters<HostPort["start"]>[0][] = [];
  runs = new Map<string, HostRun>();
  async connect() {}
  async start(input: Parameters<HostPort["start"]>[0]): Promise<HostRun> {
    this.starts.push(input);
    const run: HostRun = { id: `run-${this.starts.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "completed", answer: `回答-${this.starts.length}` };
    this.runs.set(run.id, run); return run;
  }
  async get(id: string) { return this.runs.get(id)!; }
  async cancel() {}
  async calls() { return []; }
  async resolve() {}
}
const owner = "@owner:example.test", person = personId(owner), ownerMain = legacySession("agent", "owner-main");
async function harness() {
  const store = new DurableStore(":memory:", "agent"); cleanup.push(() => store.close());
  const ledger = AgentLedger.open(store); ledger.authoritative = true;
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("agent", store, work);
  core.ownerPersonId = person;
  const feishu = new Adapter("feishu"), web = new WebChannel(core, owner);
  core.register({ id: "feishu", ownerAddresses: ["owner-feishu"] }, feishu);
  core.register({ id: WEB_CONNECTION, ownerAddresses: [person] }, web);
  const host = new Host();
  const worker = new HostWorker("agent", "instance", store, work, host, "fixture", "instructions", () => {}, (id, text) => core.saveResult(id, text), undefined, core);
  await core.start();
  const complete = async () => { await core.dispatch(); await worker.tick(); await worker.tick(); await core.dispatch(); await core.flush(); };
  return { store, ledger, work, core, feishu, web, host, worker, complete };
}
const feishuMessage = (id: string, text = `飞书-${id}`): ChannelMessage => ({ externalId: id, sender: "owner-feishu", scope: "direct", threadId: "chat", text,
  reply: { target: "oc_chat", messageId: id, data: {} } });
const key = (n: number) => `key-${String(n).padStart(16, "0")}`;

describe("web channel ingress and the authoritative ledger queue", () => {
  it("dispatches web and Feishu owner messages from pending inputs in one owner-main session; web replies are recorded, Feishu replies delivered", async () => {
    const h = await harness();
    const first = h.web.submit({ personId: person, idempotencyKey: key(1), text: "网页消息" });
    expect(first).toMatchObject({ duplicate: false, inputState: "queued", event: { sessionKey: ownerMain, kind: "message", senderType: "person", senderId: person,
      idempotencyKey: `web:${person}:${key(1)}`, body: { text: "网页消息", channel: "web" } } });
    await h.complete();
    h.core.receive("feishu", feishuMessage("f1"));
    await h.complete();
    expect(h.host.starts.map((start) => start.input.split("\n")[0])).toEqual(["网页消息", "飞书-f1"]);
    const events = h.ledger.events(ownerMain);
    const finals = events.filter((event) => event.body.final);
    expect(finals.map((event) => [event.body.text, event.body.channel])).toEqual([["回答-1", "web"], ["回答-2", "feishu"]]);
    // Web: the transcript is the delivery. The legacy outbox row is settled for compatibility.
    expect(h.ledger.deliveriesFor(finals[0]!.eventId)).toEqual([]);
    const webOutbox = h.store.entries<OutboxRecord>("communication_outbox").map(({ value }) => value).find((item) => item.route.connectionId === WEB_CONNECTION)!;
    expect(webOutbox).toMatchObject({ state: "accepted", externalId: finals[0]!.eventId });
    // Feishu: unchanged delivery through flush, now read from ledger_deliveries.
    expect(h.ledger.deliveriesFor(finals[1]!.eventId)).toMatchObject([{ purpose: "reply", status: "sent", connectionId: "feishu" }]);
    expect(h.feishu.sent.map((item) => item.text)).toEqual(["回答-2"]);
    expect(events.filter((event) => event.kind === "delivery")).toHaveLength(1);
    const conversations = h.store.db.prepare("SELECT channel, peer_id, parent_id, role FROM ledger_conversations c JOIN ledger_session_conversations s USING(conversation_id) ORDER BY channel").all();
    expect(conversations.map((row) => ({ ...row }))).toEqual([{ channel: "feishu", peer_id: "owner-feishu", parent_id: "oc_chat", role: "participant" },
      { channel: "web", peer_id: `person:${person}`, parent_id: "", role: "primary" }]);
    // Legacy views keep working.
    expect(h.store.get<InboxRecord>("communication_inbox", h.ledger.claimFor(WEB_CONNECTION, `${person}:${key(1)}`)!.inputId)).toMatchObject({ state: "done", connectionId: "web" });
    expect(h.core.isOwnerTask(ownerMain, h.ledger.turns(ownerMain)[0]!.turnId)).toBe(true);
  });
  it("returns the stored event for the same key and body and rejects a different body", async () => {
    const h = await harness();
    const first = h.web.submit({ personId: person, idempotencyKey: key(1), text: "一次" });
    expect(h.web.submit({ personId: person, idempotencyKey: key(1), text: "一次" })).toMatchObject({ duplicate: true, event: { eventId: first.event.eventId } });
    expect(() => h.web.submit({ personId: person, idempotencyKey: key(1), text: "两次" })).toThrow("idempotency_key_reused");
    expect(h.ledger.session(ownerMain)!.lastSeq).toBe(1);
    await h.complete(); await h.complete();
    expect(h.host.starts).toHaveLength(1);
  });
  it("keeps receipt order for concurrent sends and resolves a reply to an earlier web event", async () => {
    const h = await harness();
    const a = h.web.submit({ personId: person, idempotencyKey: key(1), text: "第一条" });
    h.web.submit({ personId: person, idempotencyKey: key(2), text: "第二条", replyTo: a.event.eventId });
    expect(h.ledger.dueInputs().map((id) => h.ledger.input(id)!.event_id)).toEqual([a.event.eventId, expect.any(String)]);
    expect(h.ledger.events(ownerMain)[1]!.body).toMatchObject({ replyTo: a.event.eventId });
    await h.core.dispatch();
    expect(h.store.entries<InboxRecord>("communication_inbox").map(({ value }) => value.state)).toEqual(["submitted", "submitted"]);
    await h.worker.tick();
    expect(h.host.starts[0]!.input).toContain("第一条");
  });
  it("drops a redacted message that no turn has taken, and removes its content", async () => {
    const h = await harness();
    const sent = h.web.submit({ personId: person, idempotencyKey: key(1), text: "说错了" });
    const redaction = h.web.redact(person, ownerMain, sent.event.eventId, key(9));
    expect(redaction).toMatchObject({ duplicate: false, dropped: true, event: { kind: "redaction", refEventId: sent.event.eventId, body: { targetEventId: sent.event.eventId } } });
    expect(h.web.redact(person, ownerMain, sent.event.eventId, key(9))).toMatchObject({ duplicate: true, dropped: false, event: { eventId: redaction.event.eventId } });
    expect(h.web.redact(person, ownerMain, sent.event.eventId, key(8))).toMatchObject({ duplicate: true, event: { eventId: redaction.event.eventId } });
    await h.complete();
    expect(h.host.starts).toHaveLength(0);
    expect(h.ledger.event(sent.event.eventId)!.body).toEqual({ text: "", redacted: true, channel: "web" });
    expect(h.ledger.input(h.ledger.claimFor(WEB_CONNECTION, `${person}:${key(1)}`)!.inputId)).toMatchObject({ state: "dropped", reason: "redacted" });
    const legacy = h.store.entries<InboxRecord>("communication_inbox").map(({ value }) => value);
    expect(legacy.map((item) => [item.state, item.source.text, item.reason ?? null])).toEqual([["done", "", "redacted_before_start"],
      ["done", "", "message-redaction_recorded_without_execution"]]);
    // The original send is still recognised after redaction.
    expect(h.web.submit({ personId: person, idempotencyKey: key(1), text: "说错了" })).toMatchObject({ duplicate: true });
    h.core.receive("feishu", feishuMessage("f1"));
    const feishuEvent = h.ledger.platformEvent("feishu", "f1")!;
    expect(() => h.web.redact(person, ownerMain, feishuEvent, key(7))).toThrow("redaction_not_allowed");
    expect(() => h.web.redact(person, ownerMain, "ev_missing", key(7))).toThrow("event_not_found");
    const other = h.web.submit({ personId: person, idempotencyKey: key(2), text: "另一条" });
    expect(() => h.web.redact(person, ownerMain, other.event.eventId, key(9))).toThrow("idempotency_key_reused");
  });
  it("never replays unknown work, reconciles settled inputs and still dispatches receipts that have no pending input", async () => {
    const h = await harness();
    h.web.submit({ personId: person, idempotencyKey: key(1), text: "一" });
    await h.core.dispatch();
    const turn = h.ledger.turns(ownerMain)[0]!.turnId;
    h.ledger.turnState(turn, "unknown", { agentId: "agent", error: "host_outcome_unknown" });
    expect(h.ledger.input(h.ledger.inputForTurn(turn)!)).toMatchObject({ state: "unknown" });
    expect(h.ledger.dueInputs()).toEqual([]);
    // A pending input whose legacy record was already handled is reconciled, not dispatched again.
    const second = h.web.submit({ personId: person, idempotencyKey: key(2), text: "二" });
    const secondInput = h.ledger.inputForEvent(second.event.eventId)!.input_id as string;
    const record = h.store.get<InboxRecord>("communication_inbox", secondInput)!;
    h.store.set("communication_inbox", secondInput, { ...record, state: "done" });
    // A receipt from before the cutover has a legacy record only.
    const legacy = h.core.receive("feishu", feishuMessage("old"));
    h.store.db.prepare("DELETE FROM ledger_pending_inputs WHERE input_id=?").run(legacy.id);
    await h.core.dispatch();
    expect(h.ledger.input(secondInput)).toMatchObject({ state: "control", reason: "legacy_input_settled" });
    expect(h.store.get<InboxRecord>("communication_inbox", legacy.id)).toMatchObject({ state: "submitted" });
    expect(h.work.list().map((item) => item.id)).toHaveLength(2);
  });
  it("fails the receipt, not just the ledger row, when an authoritative ledger write fails", async () => {
    const h = await harness();
    h.store.db.exec("DROP TABLE ledger_events");
    expect(() => h.core.receive("feishu", feishuMessage("f1"))).toThrow();
    expect(h.store.entries("communication_inbox")).toHaveLength(0);
    expect(h.ledger.claimFor("feishu", "f1")).toBeUndefined();
  });
});
