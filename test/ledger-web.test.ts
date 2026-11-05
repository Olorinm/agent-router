import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceConfig } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import { CommunicationCore } from "../src/communication/core.js";
import type { ChannelAdapter, ChannelContext, ChannelMessage, ReplyRoute } from "../src/communication/types.js";
import { AgentLedger, legacySession } from "../src/ledger/ledger.js";
import { personId } from "../src/ledger/registry.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", other = "@bob:example.test", root = "/_agent-router/v1";
class Adapter implements ChannelAdapter {
  readonly kind = "feishu"; readonly retrySafe = true; context!: ChannelContext;
  async start(context: ChannelContext) { this.context = context; }
  async stop() {}
  async send(_route: ReplyRoute, _text: string, key: string) { return { externalId: `sent-${key}` }; }
}
function transport(agent: ManagedAgent, inbox: ApplicationInbox): MatrixTransport {
  return { identity: async () => agent.matrixId,
    sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
    state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!room:example.test",
    join: async () => {}, send: async () => "$sent", stop: () => {} };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup(overrides: Partial<ServiceConfig> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-web-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const cores = new Map<string, CommunicationCore>();
  let whoami = 0;
  const service = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48), ledgerRead: true, ...overrides }, {
    authenticate: async (token) => { whoami++; if (token === "alice") return owner; if (token === "bob") return other; throw new Error("bad_credentials"); },
    provision: async () => {}, transport,
    configure: async (agent, connector) => {
      const core = new CommunicationCore(agent.id, connector.store, connector.cli!);
      core.ownerPersonId = personId(agent.owner);
      core.register({ id: "feishu", ownerAddresses: ["ou_owner"] }, new Adapter());
      cores.set(agent.id, core);
      return { start: () => core.start(), stop: () => core.stop(), status: () => ({}), resolve: async () => {}, reconcile: async () => {}, closeUnknown: async () => {} };
    } });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  server.on("upgrade", (req, socket, head) => { if (!service.web?.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  async function api(path: string, token = "alice", method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
  }
  const agent = await service.create(owner, "helper");
  const core = cores.get(agent.id)!, ledger = AgentLedger.attached((await service.runtime(agent.id)).connector.store)!;
  const message = (id: string, text = `text-${id}`): ChannelMessage => ({ externalId: id, sender: "ou_owner", scope: "direct", threadId: "oc_chat", text,
    reply: { target: "oc_chat", messageId: id, data: {} } });
  return { service, api, agent, core, ledger, message, port, whoami: () => whoami };
}
const enc = encodeURIComponent;

describe("owner history API", () => {
  it("serves the merged owner DM from the ledger with paging, catch-up and reset", async () => {
    const t = await setup(), chatId = `dm:${t.agent.id}`, session = legacySession(t.agent.id, "owner-main");
    for (const id of ["m1", "m2", "m3"]) t.core.receive("feishu", t.message(id));
    t.ledger.shadow(() => t.ledger.append(session, { kind: "message", role: "assistant", senderType: "agent", senderId: t.agent.id, body: { text: "回复", final: true, channel: "feishu" } }));
    await tick();
    const me = await t.api(`${root}/web/me`);
    expect(me.data).toMatchObject({ person: { id: personId(owner), name: "alice" }, ownerId: owner, limits: { features: { history: true, send: false } } });
    expect(me.data.identities.map((item: any) => [item.provider, item.subject])).toContainEqual(["matrix", owner]);
    const chats = await t.api(`${root}/web/chats`);
    expect(chats.data.data).toMatchObject([{ chatId, kind: "dm", title: "helper", agentIds: [t.agent.id], readOnly: false, lastSeq: 4, generation: 1,
      readSeq: 0, unread: 1, lastEvent: { preview: "回复", sender: { type: "agent", name: "helper" } } }]);
    const latest = await t.api(`${root}/web/chats/${enc(chatId)}/events?limit=2`);
    expect(latest.data).toMatchObject({ mode: "page", lastSeq: 4, generation: 1, olderCursor: 3, newerCursor: null, inflight: [] });
    expect(latest.data.events.map((event: any) => [event.seq, event.kind, event.role, event.text, event.sender.type, event.channel.kind]))
      .toEqual([[3, "message", "user", "text-m3", "person", "feishu"], [4, "message", "assistant", "回复", "agent", "feishu"]]);
    const older = await t.api(`${root}/web/chats/${enc(chatId)}/events?before=3&limit=2`);
    expect(older.data).toMatchObject({ mode: "page", olderCursor: null, newerCursor: 2 });
    expect(older.data.events.map((event: any) => event.seq)).toEqual([1, 2]);
    const delta = await t.api(`${root}/web/chats/${enc(chatId)}/events?after=1&generation=1&limit=2`);
    expect(delta.data).toMatchObject({ mode: "delta", newerCursor: 3 });
    expect(delta.data.events.map((event: any) => event.seq)).toEqual([2, 3]);
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/events?after=3&generation=1`)).data).toMatchObject({ mode: "delta", newerCursor: null });
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/events?after=1&generation=2`)).data).toMatchObject({ mode: "reset", reset: { reason: "generation_changed" }, events: [] });
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/events?after=9&generation=1`)).data).toMatchObject({ mode: "reset", reset: { reason: "not_found" } });
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/events?after=1&before=3`)).status).toBe(400);
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/events?limit=201`)).status).toBe(400);
    const read = await t.api(`${root}/web/chats/${enc(chatId)}/read`, "alice", "POST", { seq: 4 });
    expect(read.data).toEqual({ readSeq: 4, unread: 0 });
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/read`, "alice", "POST", { seq: 1 })).data).toEqual({ readSeq: 4, unread: 0 });
    expect((await t.api(`${root}/web/chats/${enc(chatId)}`)).data).toMatchObject({ chatId, readSeq: 4, members: [{ type: "person", id: personId(owner) }, { type: "agent", id: t.agent.id, name: "helper" }] });
    const before = t.whoami(); await t.api(`${root}/web/chats`); expect(t.whoami()).toBe(before);
  });
  it("is owner scoped, reports turn detail, observed chats and an oversized gap as reset", async () => {
    const t = await setup(), chatId = `dm:${t.agent.id}`, session = legacySession(t.agent.id, "owner-main");
    t.core.receive("feishu", t.message("m1"));
    t.core.receive("feishu", { ...t.message("g1"), scope: "group", groupId: "oc_group", sender: "ou_owner", mentions: { self: true, all: false } });
    await tick();
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/events`, "bob")).data).toEqual({ error: "chat_not_found" });
    expect((await t.api(`${root}/web/chats`, "bob")).data.data).toEqual([]);
    const chats = (await t.api(`${root}/web/chats`)).data.data;
    const observed = chats.find((chat: any) => chat.kind === "observed");
    expect(observed).toMatchObject({ readOnly: true, lastSeq: 1, title: "feishu:group:oc_chat" });
    t.ledger.shadow(() => {
      t.ledger.ensureTurn({ turnId: "task-1", sessionKey: session, admission: "owner" });
      for (let index = 0; index < 1100; index++) t.ledger.append(session, { kind: "notice", role: "system", senderType: "system", senderId: "router", body: { text: `n${index}`, level: "info" } });
    });
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/turns/task-1`)).data).toMatchObject({ turnId: "task-1", chatId, agentId: t.agent.id, state: "queued", runs: [] });
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/turns/missing`)).status).toBe(404);
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/events?after=1&generation=1`)).data).toMatchObject({ mode: "reset", reset: { reason: "gap_too_large" } });
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/events?limit=200`)).data.events).toHaveLength(200);
    const debug = (await t.api(`${root}/web/debug/ledger`)).data.data[0];
    expect(debug).toMatchObject({ agentId: t.agent.id, ledger: { sessions: 2, events: 1102 }, inbox: 2, timeline: 0 });
  });
  it("stays off unless ledger_read is enabled", async () => {
    const t = await setup({ ledgerRead: false });
    expect(t.service.web).toBeUndefined();
    expect((await t.api(`${root}/web/me`)).status).toBe(404);
  });
});

describe("owner event socket", () => {
  async function connect(t: Awaited<ReturnType<typeof setup>>) {
    const { ticket } = (await t.api(`${root}/web/socket-tickets`, "alice", "POST", {})).data;
    const socket = new WebSocket(`ws://127.0.0.1:${t.port}${root}/web/socket?ticket=${ticket}`);
    const frames: any[] = [];
    socket.addEventListener("message", (event) => frames.push(event.data === "pong" ? "pong" : JSON.parse(String(event.data))));
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
    cleanup.push(() => socket.close());
    const wait = async (predicate: (frame: any) => boolean) => {
      for (let index = 0; index < 100 && !frames.some(predicate); index++) await new Promise((r) => setTimeout(r, 10));
      const found = frames.find(predicate); if (!found) throw new Error(`frame_not_received ${JSON.stringify(frames)}`); return found;
    };
    return { socket, frames, wait, ticket };
  }
  it("replays after a seq, goes live in order, streams, relays read markers and asks for a snapshot on a new generation", async () => {
    const t = await setup(), chatId = `dm:${t.agent.id}`, session = legacySession(t.agent.id, "owner-main");
    for (const id of ["m1", "m2", "m3"]) t.core.receive("feishu", t.message(id));
    await tick();
    const s = await connect(t);
    expect((await s.wait((frame) => frame.event === "hello")).data).toMatchObject({ heartbeatMs: 30000, limits: { maxReplayEvents: 500 } });
    s.socket.send(JSON.stringify({ type: "req", id: "1", method: "subscribe", params: { chats: [{ chatId, afterSeq: 1, generation: 1 }], index: true } }));
    expect(await s.wait((frame) => frame.type === "res")).toEqual({ type: "res", id: "1", ok: true, result: { chats: [{ chatId, mode: "delta", lastSeq: 3, generation: 1 }] } });
    await s.wait((frame) => frame.event === "chat.event" && frame.data.seq === 3);
    t.core.receive("feishu", t.message("m4", "live"));
    const live = await s.wait((frame) => frame.event === "chat.event" && frame.data.seq === 4);
    expect(live.data).toMatchObject({ chatId, generation: 1, kind: "message", text: "live", sender: { type: "person" } });
    expect((await s.wait((frame) => frame.event === "chats.updated")).data).toMatchObject({ chatId, lastSeq: 4 });
    expect(s.frames.filter((frame) => frame.event === "chat.event").map((frame) => frame.data.seq)).toEqual([2, 3, 4]);
    t.ledger.stream(session, "task-1", "正在");
    expect((await s.wait((frame) => frame.event === "chat.stream")).data).toEqual({ chatId, turnId: "task-1", agentId: t.agent.id, state: "delta", text: "正在", afterSeq: 4 });
    s.socket.send("ping"); await s.wait((frame) => frame === "pong");
    await t.api(`${root}/web/chats/${enc(chatId)}/read`, "alice", "POST", { seq: 4 });
    expect((await s.wait((frame) => frame.event === "chat.read")).data).toEqual({ chatId, readSeq: 4 });
    t.ledger.shadow(() => t.ledger.resequence(session));
    expect((await s.wait((frame) => frame.event === "snapshot_required")).data).toEqual({ chatId, reason: "generation_changed" });
    expect((await t.api(`${root}/web/chats/${enc(chatId)}/events?after=4&generation=1`)).data).toMatchObject({ mode: "reset", reset: { reason: "generation_changed" } });
  });
  it("rejects reused tickets and foreign chats, and resets subscriptions that are too far behind", async () => {
    const t = await setup(), chatId = `dm:${t.agent.id}`;
    t.core.receive("feishu", t.message("m1")); await tick();
    const s = await connect(t);
    await expect(new Promise((resolve, reject) => {
      const reused = new WebSocket(`ws://127.0.0.1:${t.port}${root}/web/socket?ticket=${s.ticket}`);
      reused.addEventListener("open", () => resolve("open")); reused.addEventListener("error", () => reject(new Error("rejected")));
    })).rejects.toThrow("rejected");
    s.socket.send(JSON.stringify({ type: "req", id: "1", method: "subscribe", params: { chats: [{ chatId: "dm:00000000-0000-4000-8000-000000000000" }] } }));
    expect(await s.wait((frame) => frame.id === "1")).toEqual({ type: "res", id: "1", ok: false, error: { code: "chat_not_found" } });
    s.socket.send(JSON.stringify({ type: "req", id: "2", method: "subscribe", params: { chats: [{ chatId, afterSeq: 0, generation: 7 }] } }));
    expect((await s.wait((frame) => frame.id === "2")).result.chats[0].mode).toBe("reset");
    expect((await s.wait((frame) => frame.event === "snapshot_required")).data).toEqual({ chatId, reason: "generation_changed" });
    s.socket.send("{not json"); expect(await s.wait((frame) => frame.ok === false && frame.id === "")).toMatchObject({ error: { code: "invalid_request" } });
  });
});
