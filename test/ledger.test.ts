import { afterEach, describe, expect, it } from "vitest";
import { CommunicationCore } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import { HostWorker } from "../src/execution/host-worker.js";
import { WorkSessions } from "../src/execution/sessions.js";
import type { HostCall, HostPort, HostRun } from "../src/execution/host.js";
import { AgentLedger, legacySession } from "../src/ledger/ledger.js";
import { PersonRegistry, personId } from "../src/ledger/registry.js";
import { ChannelSendError, type ChannelAdapter, type ChannelContext, type ChannelKind, type ChannelMessage, type ReplyRoute } from "../src/communication/types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class Adapter implements ChannelAdapter {
  context!: ChannelContext;
  sent: Array<{ route: ReplyRoute; text: string; key: string }> = [];
  error: Error | undefined;
  constructor(readonly kind: ChannelKind, readonly retrySafe = false) {}
  async start(context: ChannelContext) { this.context = context; context.checkpoint("account", `${this.kind}-bot`); }
  async stop() {}
  async send(route: ReplyRoute, text: string, key: string) {
    this.sent.push({ route, text, key }); if (this.error) throw this.error;
    return { externalId: `accepted-${key}` };
  }
}
class Host implements HostPort {
  identity = "fixture-host";
  starts: Parameters<HostPort["start"]>[0][] = [];
  runs = new Map<string, HostRun>();
  pending: HostCall[] = [];
  resolved: unknown[] = [];
  defaultStatus: HostRun["status"] = "completed";
  answer = "回答";
  async connect() {}
  async start(input: Parameters<HostPort["start"]>[0]): Promise<HostRun> {
    this.starts.push(input);
    const run: HostRun = { id: `run-${this.starts.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: this.defaultStatus, answer: this.answer };
    this.runs.set(run.id, run); return run;
  }
  async get(id: string) { const run = this.runs.get(id); if (!run) throw new Error("not_found"); return run; }
  async cancel(id: string) { (await this.get(id)).status = "cancelled"; }
  async calls() { return this.pending; }
  async resolve(id: string, callId: string, result: unknown) { this.resolved.push({ id, callId, result }); }
}
const ownerPerson = personId("@owner:example.test");
function harness() {
  const store = new DurableStore(":memory:", "agent"); cleanup.push(() => store.close());
  const ledger = AgentLedger.open(store);
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("agent", store, work);
  core.ownerPersonId = ownerPerson;
  const feishu = new Adapter("feishu"), telegram = new Adapter("telegram"), matrix = new Adapter("matrix", true);
  for (const [id, adapter] of [["feishu", feishu], ["telegram", telegram], ["matrix", matrix]] as const)
    core.register({ id, ownerAddresses: [`owner-${id}`], peerAddresses: ["peer"], groupIds: ["group"] }, adapter);
  const host = new Host();
  const worker = () => new HostWorker("agent", "instance", store, work, host, "fixture", "instructions", () => {}, (id, text) => core.saveResult(id, text), undefined, core);
  return { store, ledger, work, core, feishu, telegram, matrix, host, worker };
}
function message(id: string, sender = "owner-feishu", overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return { externalId: id, sender, scope: "direct", threadId: "chat", text: `input-${id}`, reply: { target: `chat-${id}`, messageId: id, data: { token: "PRIVATE" } }, ...overrides };
}
async function complete(h: ReturnType<typeof harness>) { await h.core.dispatch(); await h.worker().tick(); await h.core.dispatch(); await h.core.flush(); }
const ownerMain = legacySession("agent", "owner-main");
const kinds = (h: ReturnType<typeof harness>, session = ownerMain) => h.ledger.events(session, { limit: 200 }).map((event) => event.kind);

describe("shadow ledger ingress", () => {
  it("records every owner channel in one owner-main session with one conversation per channel and gapless seq", async () => {
    const h = harness(); await h.core.start();
    const first = h.core.receive("feishu", message("one"));
    h.core.receive("telegram", message("two", "owner-telegram"));
    expect(first.conversationId).toBe(ownerMain);
    const session = h.ledger.session(ownerMain)!;
    expect(session).toMatchObject({ kind: "owner_main", label: "owner-main", lastSeq: 2, generation: 1, window: 1 });
    const events = h.ledger.events(ownerMain);
    expect(events.map((event) => [event.seq, event.kind, event.senderType, event.senderId, event.body.channel]))
      .toEqual([[1, "message", "person", ownerPerson, "feishu"], [2, "message", "person", ownerPerson, "telegram"]]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
    expect(new Set(events.map((event) => event.conversationId)).size).toBe(2);
    const conversations = h.store.db.prepare("SELECT channel, account_id, kind, peer_id, parent_id, session_key FROM ledger_conversations ORDER BY channel").all();
    expect(conversations.map((row) => ({ ...row }))).toEqual([
      { channel: "feishu", account_id: "feishu-bot", kind: "direct", peer_id: "owner-feishu", parent_id: "chat-one", session_key: ownerMain },
      { channel: "telegram", account_id: "telegram-bot", kind: "direct", peer_id: "owner-telegram", parent_id: "chat-two", session_key: ownerMain }]);
    expect(h.ledger.claimFor("feishu", "one")).toMatchObject({ state: "accepted", inputId: first.id, eventId: events[0]!.eventId });
    expect(h.ledger.input(first.id)).toMatchObject({ state: "queued", event_id: events[0]!.eventId });
    expect(h.ledger.platformEvent("feishu", "one")).toBe(events[0]!.eventId);
  });
  it("dedupes redelivery, rejects a changed payload and keeps tombstoned hashes for 30 days", () => {
    const h = harness(), input = message("one");
    h.core.receive("feishu", input); h.core.receive("feishu", input);
    expect(h.ledger.session(ownerMain)!.lastSeq).toBe(1);
    expect(() => h.core.receive("feishu", { ...input, text: "changed" })).toThrow("different_payload");
    const claim = h.ledger.claimFor("feishu", "one")!;
    h.ledger.tombstone("feishu", "one", 1000);
    expect(h.ledger.claim({ connectionId: "feishu", externalId: "one", inputId: claim.inputId, hash: claim.hash })).toMatchObject({ duplicate: true, claim: { state: "tombstone", eventId: null } });
    expect(() => h.ledger.claim({ connectionId: "feishu", externalId: "one", inputId: claim.inputId, hash: "other" })).toThrow("different_payload");
    expect(h.ledger.pruneTombstones(1000 + 29 * 24 * 3600_000)).toBe(0);
    expect(h.ledger.pruneTombstones(1000 + 30 * 24 * 3600_000)).toBe(1);
  });
  it("never writes unknown senders to a transcript and records oversized input as a notice plus delivery", () => {
    const h = harness();
    expect(h.core.receive("feishu", message("stranger", "stranger")).state).toBe("ignored");
    expect(h.ledger.claimFor("feishu", "stranger")).toMatchObject({ state: "ignored", reason: "sender_not_allowed", eventId: null });
    expect(h.ledger.sessions()).toHaveLength(0);
    h.core.receive("feishu", message("large", "owner-feishu", { text: "中".repeat(9000) }));
    expect(h.ledger.claimFor("feishu", "large")).toMatchObject({ state: "ignored", reason: "input_too_large" });
    const [notice] = h.ledger.events(ownerMain);
    expect(notice).toMatchObject({ kind: "notice", senderType: "system" });
    expect(h.ledger.deliveriesFor(notice!.eventId)).toMatchObject([{ purpose: "notice", status: "queued", connectionId: "feishu" }]);
  });
  it("records reactions, edits and redactions against the original event without a pending input", () => {
    const h = harness();
    const original = h.core.receive("matrix", message("$original", "owner-matrix"));
    const target = h.ledger.platformEvent("matrix", "$original")!;
    h.core.receive("matrix", message("$reaction", "owner-matrix", { text: "", event: { type: "reaction", data: { "m.relates_to": { event_id: "$original", key: "👍" } } } }));
    const edit = h.core.receive("matrix", message("$edit", "owner-matrix", { text: "fixed", event: { type: "message-edit", data: { "m.relates_to": { rel_type: "m.replace", event_id: "$original" } } } }));
    h.core.receive("matrix", message("$redact", "owner-matrix", { text: "", event: { type: "message-redaction", data: { redacts: "$original" } } }));
    expect(h.ledger.events(ownerMain).map((event) => [event.kind, event.refEventId, event.body.targetEventId ?? null]))
      .toEqual([["message", null, null], ["reaction", target, target], ["edit", target, target], ["redaction", target, target]]);
    expect(h.ledger.events(ownerMain)[1]!.body).toMatchObject({ key: "👍", removed: false });
    expect(h.ledger.input(original.id)).toBeTruthy(); expect(h.ledger.input(edit.id)).toBeUndefined();
  });
  it("isolates peers and groups into their own sessions, with the legacy conversation ids as session keys", () => {
    const h = harness();
    const peer = h.core.receive("feishu", message("peer", "peer"));
    const group = h.core.receive("feishu", message("group", "owner-feishu", { scope: "group", groupId: "group", threadId: "group:root" }));
    expect(h.ledger.session(peer.conversationId)).toMatchObject({ kind: "peer", label: "feishu:direct:peer" });
    expect(h.ledger.session(group.conversationId)).toMatchObject({ kind: "group" });
    expect(h.ledger.events(peer.conversationId)[0]).toMatchObject({ senderType: "external", senderId: "peer" });
    const row = h.store.db.prepare("SELECT kind, peer_id, thread_id FROM ledger_conversations WHERE session_key=?").get(group.conversationId);
    expect({ ...row }).toEqual({ kind: "group", peer_id: "group", thread_id: "group:root" });
  });
  it("leaves legacy behavior intact when a ledger write fails, including inside a provider transaction", async () => {
    const h = harness(); await h.core.start();
    h.store.db.exec("DROP TABLE ledger_events");
    expect(h.store.transaction(() => h.core.receive("matrix", message("one", "owner-matrix"))).state).toBe("received");
    expect(h.core.receive("feishu", message("two")).state).toBe("received");
    expect(h.ledger.lastError).toBe("ledger_write_failed");
    expect(h.ledger.claimFor("matrix", "one")).toBeUndefined();
    await complete(h);
    expect(h.host.starts).toHaveLength(1); expect(h.matrix.sent).toHaveLength(1);
  });
});

describe("shadow ledger turns and deliveries", () => {
  it("records queued, running and completed turns, the final reply and its delivery with platform ids", async () => {
    const h = harness(); await h.core.start();
    const input = h.core.receive("matrix", message("$in", "owner-matrix"));
    await complete(h);
    const task = h.store.get<{ taskId: string }>("communication_inbox", input.id)!.taskId;
    expect(h.ledger.turn(task)).toMatchObject({ state: "completed", admission: "owner", sessionKey: ownerMain, originConversationId: expect.stringMatching(/^cv_/) });
    expect(kinds(h)).toEqual(["message", "turn", "turn", "message", "turn", "delivery"]);
    const events = h.ledger.events(ownerMain);
    expect(events.filter((event) => event.kind === "turn").map((event) => event.body.state)).toEqual(["queued", "running", "completed"]);
    const final = events[3]!;
    expect(final).toMatchObject({ role: "assistant", senderType: "agent", senderId: "agent", turnId: task, idempotencyKey: `turn:${task}:final`, body: { text: "回答", final: true } });
    expect(h.ledger.turn(task)!.finalEventId).toBe(final.eventId);
    expect(events[0]!.turnId).toBe(task);
    expect(h.ledger.deliveriesFor(final.eventId)).toMatchObject([{ purpose: "reply", status: "sent", attempts: 1, platformMessageId: expect.stringContaining("accepted-") }]);
    expect(events[5]!.body).toMatchObject({ targetEventId: final.eventId, delivery: { status: "sent", channel: "matrix" } });
    expect(h.ledger.platformEvent("matrix", h.matrix.sent[0]!.key.replace(/^/, "accepted-"))).toBe(final.eventId);
    expect(h.ledger.input(input.id)).toMatchObject({ state: "started", turn_id: task });
  });
  it("marks a lost non-idempotent delivery unknown and a retried idempotent delivery sent", async () => {
    const h = harness(); await h.core.start();
    h.core.receive("feishu", message("one")); h.feishu.error = new Error("response_lost");
    await complete(h);
    const final = h.ledger.events(ownerMain).find((event) => event.body.final)!;
    expect(h.ledger.deliveriesFor(final.eventId)[0]).toMatchObject({ status: "unknown", error: "response_lost" });
    expect(h.ledger.events(ownerMain).at(-1)!.body).toMatchObject({ delivery: { status: "unknown", error: "response_lost" } });
    h.core.receive("telegram", message("two", "owner-telegram"));
    h.telegram.error = new ChannelSendError("retry", "rate_limited"); await complete(h);
    const second = h.ledger.events(ownerMain).filter((event) => event.body.final)[1]!;
    expect(h.ledger.deliveriesFor(second.eventId)[0]).toMatchObject({ status: "queued", attempts: 1 });
    h.telegram.error = undefined; await h.core.flush(Date.now() + 100_000);
    expect(h.ledger.deliveriesFor(second.eventId)[0]).toMatchObject({ status: "sent", attempts: 2 });
  });
  it("records an interaction as a card, the chat answer as card.update and control input as control", async () => {
    const h = harness(); await h.core.start();
    h.host.defaultStatus = "running";
    h.host.pending = [{ id: "call-1", runId: "run-1", kind: "interaction", name: "approval", input: { reason: "可以继续吗" }, status: "pending", deadlineAt: "2999-01-01T00:00:00Z" }];
    h.core.receive("feishu", message("one")); await h.core.dispatch();
    const worker = h.worker(); h.core.control = (input) => worker.handleInput(input);
    await worker.tick(); await worker.tick(); await h.core.flush();
    const card = h.ledger.events(ownerMain).find((event) => event.kind === "card")!;
    expect(card.body.card).toMatchObject({ kind: "approval", callId: "call-1", choices: [{ choiceId: "0", label: "允许一次" }, { choiceId: "1", label: "拒绝" }] });
    expect(h.ledger.pendingCards(ownerMain)).toBe(1);
    expect(h.ledger.deliveriesFor(card.eventId)).toMatchObject([{ purpose: "card", status: "sent" }]);
    const answer = h.core.receive("feishu", message("two", "owner-feishu", { text: "1" }));
    await h.core.dispatch();
    expect(h.host.resolved).toHaveLength(1);
    expect(h.ledger.pendingCards(ownerMain)).toBe(0);
    expect(h.ledger.events(ownerMain).find((event) => event.kind === "card.update")!.body).toMatchObject({ status: "answered" });
    expect(h.ledger.input(answer.id)).toMatchObject({ state: "control" });
  });
  it("records owner work and schedules as work turns with their final message, and schedule notices in the target session", async () => {
    const h = harness(); await h.core.start();
    const sessions = new WorkSessions("agent", "@owner:example.test", "fixture", "instance", h.store, h.work, h.host, h.core);
    const submitted = await sessions.submit({ eventId: "evt-1", input: "整理日程", admission: { kind: "owner", owner: "@owner:example.test", agentId: "agent", reference: "evt-1" } });
    await h.worker().tick(); await h.worker().tick();
    expect(h.ledger.session(submitted.sessionId)).toMatchObject({ kind: "work" });
    expect(h.ledger.events(submitted.sessionId).map((event) => [event.kind, event.body.state ?? event.body.text])).toEqual([
      ["message", "整理日程"], ["turn", "queued"], ["turn", "running"], ["message", "回答"], ["turn", "completed"]]);
    expect(h.ledger.events(submitted.sessionId)[0]).toMatchObject({ senderType: "person", senderId: ownerPerson, body: { origin: "work" } });
    h.core.receive("feishu", message("one")); await complete(h);
    sessions.deliver({ eventId: "remind-1", targetSessionId: ownerMain, text: "该开会了" });
    const notice = h.ledger.eventByKey(ownerMain, "schedule:remind-1")!;
    expect(notice).toMatchObject({ kind: "notice", turnId: null, body: { text: "该开会了", origin: "schedule" } });
    expect(h.ledger.deliveriesFor(notice.eventId)).toMatchObject([{ purpose: "content", status: "queued" }]);
  });
});

describe("person registry", () => {
  it("resolves identities by provider and namespace and never by routing alias", () => {
    const store = new DurableStore(":memory:", "registry"); cleanup.push(() => store.close());
    const persons = new PersonRegistry(store);
    const person = persons.ensurePerson("@owner:example.test", "owner");
    expect(persons.link(person, "feishu", "app-a", "ou_1", "config")).toBe(true);
    expect(persons.link(personId("@other:example.test"), "feishu", "app-a", "ou_1", "config")).toBe(false);
    persons.link(person, "grove-mail", "", "Owner@Example.Test", "config");
    expect(persons.resolve("feishu", "app-a", "ou_1")).toBe(person);
    expect(persons.resolve("feishu", "app-b", "ou_1")).toBeUndefined();
    expect(persons.resolve("grove-mail", "", "owner@example.test")).toBe(person);
    expect(persons.identities(person).map((item) => item.verifiedBy)).toEqual(["config", "config"]);
    new PersonRegistry(store); expect(store.get("meta", "registry_schema_version")).toBe(2);
  });
});

