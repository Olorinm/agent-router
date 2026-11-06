import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SendMessageRequest } from "@a2a-js/sdk";
import { ManagedService, type ManagedAgent } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import { digest, key } from "../src/execution/protocol.js";
import type { InboxRecord, OutboxRecord } from "../src/communication/core.js";
import type { RoomEvent } from "../src/matrix/protocol.js";
import { backfill } from "../src/ledger/backfill.js";
import { AgentLedger, legacySession } from "../src/ledger/ledger.js";
import { personId } from "../src/ledger/registry.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", stranger = "@bob:example.test";
function transport(agent: ManagedAgent, inbox: ApplicationInbox): MatrixTransport {
  return { identity: async () => agent.matrixId, sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
    state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!room:example.test", join: async () => {}, send: async () => "$sent", stop: () => {} };
}
const event = (id: string, sender: string, ts: number, content: Record<string, unknown>, type = "m.room.message"): RoomEvent & { origin_server_ts: number } =>
  ({ event_id: id, sender, type, content, origin_server_ts: ts });

/** A stopped service state with one agent's Matrix mirror and legacy records, as a phase 1 cutover finds it. */
async function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-backfill-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const service = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48) }, { authenticate: async () => owner, provision: async () => {}, transport });
  const agent = await service.create(owner, "helper"), sibling = await service.create(owner, "writer");
  await service.close();
  const store = new DurableStore(join(stateDir, "agents", `${agent.id}.sqlite`), agent.matrixId);
  const rooms: Record<string, { members: string[]; group?: boolean }> = {
    "!dm:example.test": { members: [owner, agent.matrixId] }, "!old:example.test": { members: [owner, agent.matrixId] },
    "!peer:example.test": { members: [stranger, agent.matrixId] }, "!team:example.test": { members: [owner, agent.matrixId, sibling.matrixId], group: true },
    "!mixed:example.test": { members: [owner, stranger, agent.matrixId] },
  };
  for (const [room, value] of Object.entries(rooms)) { store.set("rooms", room, value); store.set("room_info", room, { room, members: value.members, name: room === "!team:example.test" ? "Team" : "" }); }
  const timeline: Array<[string, RoomEvent]> = [
    ["!dm:example.test", event("$a", owner, 1000, { msgtype: "m.text", body: "你好" })],
    ["!dm:example.test", event("$b", agent.matrixId, 2000, { msgtype: "m.text", body: "在的", "m.relates_to": { "m.in_reply_to": { event_id: "$a" } } })],
    ["!dm:example.test", event("$c", owner, 2100, { "m.relates_to": { rel_type: "m.annotation", event_id: "$b", key: "👍" } }, "m.reaction")],
    ["!dm:example.test", event("$d", owner, 2200, { msgtype: "m.text", body: "* 你好呀", "m.new_content": { msgtype: "m.text", body: "你好呀" }, "m.relates_to": { rel_type: "m.replace", event_id: "$a" } })],
    ["!old:example.test", event("$e", owner, 500, { msgtype: "m.image", body: "photo.png", url: "mxc://example.test/abc", info: { mimetype: "image/png", size: 3 } })],
    ["!peer:example.test", event("$p", stranger, 1500, { msgtype: "m.text", body: "hello" })],
    ["!team:example.test", event("$g", owner, 1200, { msgtype: "m.text", body: "大家好" })],
    ["!mixed:example.test", event("$m", stranger, 1300, { msgtype: "m.text", body: "mixed" })],
    ["!dm:example.test", event("$x", agent.matrixId, 1100, { body: "request" }, "io.agentrouter.request")],
  ];
  timeline.forEach(([room, value], index) => store.set("timeline", key(room, value.event_id), { cursor: index + 1, room, event: value }));
  const work = new CliWork(store, () => "allow");
  const task = await work.send(SendMessageRequest.fromJSON({ message: { messageId: "channel-x", contextId: legacySession(agent.id, "owner-main"), role: "ROLE_USER", parts: [{ text: "你好" }] } }),
    { sender: "channel", room: "x", approved: true });
  const source = { externalId: "$a", sender: owner, scope: "direct" as const, threadId: "!dm:example.test", text: "你好", reply: { target: "!dm:example.test", messageId: "$a", data: {} } };
  const inbox: InboxRecord = { id: "inbox-a", connectionId: "matrix", source, conversationId: legacySession(agent.id, "owner-main"), hash: digest(source),
    receivedAt: new Date(1000).toISOString(), state: "done", taskId: task.id, replyRoute: { connectionId: "matrix", ...source.reply } };
  store.set("communication_inbox", inbox.id, inbox);
  const outboxId = digest(key(task.id, "final"));
  store.set("communication_outbox", outboxId, { id: outboxId, taskId: task.id, route: inbox.replyRoute, text: "在的", final: true, state: "accepted", attempts: 1, nextAt: 0, externalId: "$b" } satisfies OutboxRecord);
  store.set("communication_outbox", "lost", { id: "lost", taskId: null, route: inbox.replyRoute, text: "x", state: "accepted", attempts: 1, nextAt: 0, externalId: "$missing" } satisfies OutboxRecord);
  store.close();
  const open = () => { const opened = new DurableStore(join(stateDir, "agents", `${agent.id}.sqlite`), agent.matrixId); cleanup.push(() => { try { opened.close(); } catch { /* closed */ } }); return { store: opened, ledger: AgentLedger.open(opened) }; };
  return { stateDir, agent, sibling, task, open };
}

describe("ledger backfill", () => {
  it("dry-runs without writing, then imports the mirror in time order with turns and deliveries, idempotently", async () => {
    const f = await fixture(), session = legacySession(f.agent.id, "owner-main");
    const dry = await backfill({ stateDir: f.stateDir, agentId: f.agent.id, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.agents[0]!.rooms.find((room) => room.room === "!dm:example.test")).toMatchObject({ class: "owner_dm", imported: 4, skipped: { "io.agentrouter.request": 1 } });
    let opened = f.open();
    expect(opened.ledger.counts().events).toBe(0); expect(opened.store.get("meta", "ledger_backfill")).toBeUndefined(); opened.store.close();

    const real = await backfill({ stateDir: f.stateDir, agentId: f.agent.id });
    const report = real.agents[0]!;
    expect(Object.fromEntries(report.rooms.map((room) => [room.room, [room.class, room.imported]]))).toEqual({
      "!dm:example.test": ["owner_dm", 4], "!old:example.test": ["owner_dm", 1], "!peer:example.test": ["peer", 1], "!team:example.test": ["mau_group", 0], "!mixed:example.test": ["group", 1] });
    expect(report.linked).toEqual({ turns: 1, deliveries: 1, cards: 0 }); expect(report.unmatched).toEqual({ inbox: 0, outbox: 1 });
    opened = f.open();
    const events = opened.ledger.events(session);
    expect(events.map((item) => [item.seq, item.kind, item.senderType, item.body.text ?? item.body.key ?? null])).toEqual([
      [1, "message", "person", ""], [2, "message", "person", "你好"], [3, "message", "agent", "在的"], [4, "reaction", "person", "👍"], [5, "edit", "person", "你好呀"]]);
    expect(events[0]!.body.attachments).toMatchObject([{ name: "photo.png", contentType: "image/png", size: 3 }]);
    expect(events[2]!).toMatchObject({ turnId: f.task.id, body: { final: true, replyTo: events[1]!.eventId, source: "backfill" } });
    expect(events[3]!.refEventId).toBe(events[2]!.eventId); expect(events[4]!.refEventId).toBe(events[1]!.eventId);
    expect(events[1]).toMatchObject({ turnId: f.task.id, senderId: personId(owner), idempotencyKey: "matrix:$a" });
    expect(opened.ledger.turn(f.task.id)).toMatchObject({ admission: "owner", state: "queued", finalEventId: events[2]!.eventId });
    expect(opened.ledger.deliveriesFor(events[2]!.eventId)).toMatchObject([{ purpose: "reply", status: "sent" }]);
    expect(opened.ledger.claimFor("matrix", "$a")).toMatchObject({ state: "accepted", eventId: events[1]!.eventId, inputId: "inbox-a" });
    const conversations = opened.store.db.prepare("SELECT role FROM ledger_session_conversations WHERE session_key=?").all(session);
    expect(conversations.map((row) => row.role)).toEqual(["participant", "participant"]);
    expect(opened.ledger.session(legacySession(f.agent.id, key("matrix", "direct", "!peer:example.test", stranger)))).toMatchObject({ kind: "peer", lastSeq: 1 });
    expect(opened.ledger.session(legacySession(f.agent.id, key("matrix", "group", "!mixed:example.test", "group")))).toMatchObject({ kind: "group", lastSeq: 1 });
    expect(opened.store.get("meta", "ledger_backfill")).toMatchObject({ counts: { imported: 7 } });
    opened.store.close();

    const again = await backfill({ stateDir: f.stateDir, agentId: f.agent.id });
    expect(again.agents[0]!.rooms.every((room) => room.imported === 0)).toBe(true);
    expect(again.agents[0]!.rooms.find((room) => room.room === "!dm:example.test")!.duplicate).toBe(4);
    opened = f.open(); expect(opened.ledger.session(session)).toMatchObject({ lastSeq: 5, generation: 1 }); opened.store.close();
    // `ai.mau.room` groups are not migrated: their events are skipped and no hub room is created.
    expect(real.agents[0]!.rooms.find((room) => room.room === "!team:example.test")).toMatchObject({ class: "mau_group", imported: 0, skipped: { mau_group: 1 } });
    const hub = new DurableStore(join(f.stateDir, "owners", `${digest(owner)}.sqlite`), owner); cleanup.push(() => hub.close());
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM hub_rooms").get()!.n).toBe(0);
  });
  it("fills gaps from Synapse history and re-sequences a session that already had live events", async () => {
    const f = await fixture(), session = legacySession(f.agent.id, "owner-main");
    let opened = f.open();
    opened.ledger.ensureSession(session, "owner_main", "owner-main");
    opened.ledger.append(session, { kind: "message", role: "user", senderType: "person", senderId: personId(owner), idempotencyKey: "feishu:om_live", createdAt: 9000, body: { text: "live" } });
    opened.store.close();
    const pages: Array<string | undefined> = [];
    const result = await backfill({ stateDir: f.stateDir, agentId: f.agent.id, history: () => async (room, from) => {
      pages.push(from);
      if (room !== "!dm:example.test") return { events: [] };
      return from ? { events: [event("$a", owner, 1000, { msgtype: "m.text", body: "你好" })] }
        : { events: [event("$z", owner, 100, { msgtype: "m.text", body: "最早" })], end: "t1" };
    } });
    expect(result.agents[0]!.rooms.find((room) => room.room === "!dm:example.test")).toMatchObject({ imported: 5, fromSynapse: 1 });
    expect(result.agents[0]!.resequenced).toEqual([session]);
    opened = f.open();
    expect(opened.ledger.session(session)).toMatchObject({ lastSeq: 7, generation: 2, publishedSeq: 0 });
    expect(opened.ledger.events(session).map((item) => item.body.text ?? item.kind)).toEqual(["最早", "", "你好", "在的", "reaction", "你好呀", "live"]);
    opened.store.close();
  });
  it("pages Synapse history for every room and agent with no transaction open, then writes once (dry run, real, idempotent)", async () => {
    const f = await fixture();
    const agentPath = join(f.stateDir, "agents", `${f.agent.id}.sqlite`), hubPath = join(f.stateDir, "owners", `${digest(owner)}.sqlite`);
    // A write transaction open across the network await would hold the write lock: a second connection could not take it.
    const unlocked = (path: string) => { const db = new DatabaseSync(path); try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK"); return true; } catch { return false; } finally { db.close(); } };
    const calls: string[] = [], locked: string[] = [];
    const history = (agent: ManagedAgent) => async (room: string, from?: string) => {
      await new Promise((r) => setTimeout(r, 1)); await Promise.resolve();
      for (const path of [agentPath, hubPath]) if (existsSync(path) && !unlocked(path)) locked.push(`${agent.id}:${room}:${from ?? ""}`);
      calls.push(`${agent.id}:${room}:${from ?? ""}`);
      const page = Number(from ?? 0);
      if (agent.id !== f.agent.id || room === "!team:example.test" || page >= 3) return { events: [] };
      return { events: [event(`$h${page}${room}`, owner, 10 + page, { msgtype: "m.text", body: `history ${page}` }),
        { event_id: `$j${page}${room}`, sender: owner, type: "m.room.member", state_key: owner, content: { membership: "join" }, origin_server_ts: 5 + page } as RoomEvent],
      end: String(page + 1) };
    };
    const dry = await backfill({ stateDir: f.stateDir, dryRun: true, history });
    expect(dry.agents.find((item) => item.agentId === f.agent.id)!.rooms.find((room) => room.room === "!dm:example.test")).toMatchObject({ imported: 10, fromSynapse: 6 });
    let opened = f.open(); expect(opened.ledger.counts().events).toBe(0); opened.store.close();
    calls.length = 0;
    const real = await backfill({ stateDir: f.stateDir, history });
    expect(locked).toEqual([]);
    // Four pages (three with events, one empty) for each of the agent's five rooms; one empty page per sibling room.
    expect(calls.filter((call) => call.startsWith(`${f.agent.id}:!dm:`))).toEqual(["", "1", "2", "3"].map((page) => `${f.agent.id}:!dm:example.test:${page}`));
    const rooms = real.agents.find((item) => item.agentId === f.agent.id)!.rooms;
    expect(rooms.find((room) => room.room === "!dm:example.test")).toMatchObject({ imported: 10, fromSynapse: 6 });
    expect(rooms.find((room) => room.room === "!peer:example.test")).toMatchObject({ imported: 7, fromSynapse: 6 });
    const again = await backfill({ stateDir: f.stateDir, history });
    expect(again.agents.flatMap((item) => item.rooms).every((room) => room.imported === 0)).toBe(true);
    opened = f.open(); expect(opened.store.get("meta", "ledger_backfill")).toBeDefined(); opened.store.close();
  });
  it("surfaces the SQLite error when SQLite already rolled the transaction back", () => {
    const dir = mkdtempSync(join(tmpdir(), "durable-store-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new DurableStore(join(dir, "s.sqlite"), "id"); cleanup.push(() => store.close());
    // Statement journals and sorts never need a temp file (read-only containers have no writable temp directory).
    expect(store.db.prepare("PRAGMA temp_store").get()).toEqual({ temp_store: 2 });
    // SQLITE_IOERR and SQLITE_FULL end the transaction inside SQLite; the caller must see that error, not the ROLLBACK's.
    expect(() => store.transaction(() => { store.set("x", "1", 1); store.db.exec("ROLLBACK"); throw new Error("disk I/O error"); })).toThrow("disk I/O error");
    expect(store.db.isTransaction).toBe(false); expect(store.get("x", "1")).toBeUndefined();
    const ledger = AgentLedger.open(store);
    // A shadow write that loses the outer transaction fails the legacy write too, rather than continuing in autocommit.
    expect(() => store.transaction(() => { store.set("x", "2", 2); ledger.shadow(() => { store.db.exec("ROLLBACK"); throw new Error("disk I/O error"); }); store.set("x", "3", 3); }))
      .toThrow("disk I/O error");
    expect(store.get("x", "2")).toBeUndefined(); expect(store.get("x", "3")).toBeUndefined();
    expect(store.transaction(() => ledger.shadow(() => { throw new Error("ledger_bad"); }) ?? ledger.lastError)).toBe("ledger_bad");
  });
  it("refuses to run while the service holds the agent store", async () => {
    const f = await fixture();
    const held = new DurableStore(join(f.stateDir, "agents", `${f.agent.id}.sqlite`), f.agent.matrixId); cleanup.push(() => held.close());
    held.acquireLease("service");
    await expect(backfill({ stateDir: f.stateDir, agentId: f.agent.id })).rejects.toThrow("connector_store_already_in_use");
    await expect(backfill({ stateDir: f.stateDir, agentId: "missing" })).rejects.toThrow("agent_not_found");
  });
});
