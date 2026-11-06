import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceConfig, type ServiceExtension } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import type { RoomEvent } from "../src/matrix/protocol.js";
import { channelConfigSchema, createChannelRuntime } from "../src/service/channels.js";
import type { HostPort, HostRun } from "../src/execution/host.js";
import { DurableStore } from "../src/communication/store.js";
import { digest, key as joinKey } from "../src/execution/protocol.js";
import { AgentLedger, legacySession } from "../src/ledger/ledger.js";
import { personId } from "../src/ledger/registry.js";
import { MIGRATED_NOTICE, importRooms } from "../src/ledger/rooms-import.js";
import { ROOM_LIMITS } from "../src/ledger/rooms.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", other = "@bob:example.test", root = "/_agent-router/v1", enc = encodeURIComponent;
const key = (n: number | string) => `01JC9Z7Q4M00000000000000${String(n).padStart(2, "0")}`;
class Host implements HostPort {
  identity = "fixture-host";
  starts: Parameters<HostPort["start"]>[0][] = [];
  runs = new Map<string, HostRun>();
  answer: (input: string, n: number) => string = (_input, n) => `回答-${n}`;
  async connect() {}
  async start(input: Parameters<HostPort["start"]>[0]): Promise<HostRun> {
    this.starts.push(input);
    const run: HostRun = { id: `run-${this.starts.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "completed", answer: this.answer(input.input, this.starts.length) };
    this.runs.set(run.id, run); return run;
  }
  async get(id: string) { return this.runs.get(id)!; }
  async cancel() {}
  async calls() { return []; }
  async resolve() {}
}
function transport(agent: ManagedAgent, inbox: ApplicationInbox): MatrixTransport {
  return { identity: async () => agent.matrixId,
    sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
    state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!room:example.test",
    join: async () => {}, send: async () => "$sent", stop: () => {} };
}
async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value)}`); await new Promise((r) => setTimeout(r, 25)); }
}
async function setup(overrides: Partial<ServiceConfig> = {}, existingState?: string) {
  const stateDir = existingState ?? mkdtempSync(join(tmpdir(), "ledger-rooms-"));
  if (!existingState) cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const hosts = new Map<string, Host>(), extensions = new Map<string, ServiceExtension>();
  const host = (agentId: string) => { let item = hosts.get(agentId); if (!item) { item = new Host(); hosts.set(agentId, item); } return item; };
  const service: ManagedService = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48), ledgerRead: true, ledgerSend: true, ledgerGroups: true, ...overrides }, {
    authenticate: async (token) => { if (token === "alice") return owner; if (token === "bob") return other; throw new Error("bad_credentials"); },
    provision: async () => {}, deprovision: async () => {}, transport,
    configure: async (agent, connector) => {
      const config = channelConfigSchema.parse({ agents: [{ agentId: agent.id, connections: [{ id: "matrix", kind: "matrix" }],
        host: { binding: "fixture", runtimeId: "fixture" } }] }).agents[0]!;
      const extension = await createChannelRuntime(agent, connector, config, stateDir, (name) => {
        const issued = service.issue(agent.id, name);
        return { id: issued.instance.id, validate: () => { service.instance(issued.token, agent.id); } };
      }, host(agent.id), { persons: service.persons, ownedAgent: (matrixId) => service.agents(agent.owner).some((item) => item.matrixId === matrixId),
        ...service.roomOptions(agent) });
      extensions.set(agent.id, extension);
      return extension;
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
  const agents = existingState ? service.agents(owner) : [await service.create(owner, "helper"), await service.create(owner, "writer")];
  for (const agent of agents) await service.runtime(agent.id);
  const create = (body: Record<string, unknown>, token = "alice") => api(`${root}/web/groups`, token, "POST", body);
  const send = (chatId: string, body: Record<string, unknown>, token = "alice") => api(`${root}/web/chats/${enc(chatId)}/messages`, token, "POST", body);
  const events = async (chatId: string) => (await api(`${root}/web/chats/${enc(chatId)}/events?limit=200`)).data.events as any[];
  const rooms = () => service.hubs.hub(owner).rooms;
  return { service, api, agents, host, hosts, port, stateDir, create, send, events, rooms, extension: (id: string) => extensions.get(id)!,
    ledger: (id: string) => AgentLedger.attached(extensions.get(id)!.communication!.store)! };
}
type Setup = Awaited<ReturnType<typeof setup>>;
/** Stop a setup's service and server but keep its state directory (the first cleanup entry). */
async function stop() {
  const [remove, ...rest] = cleanup.splice(0);
  for (const close of rest.reverse()) await close();
  cleanup.push(remove!);
}
async function group(t: Setup, agentIds = t.agents.map((agent) => agent.id), title = "周报小组") {
  const created = await t.create({ idempotencyKey: key("g1"), title, agentIds });
  expect(created.status).toBe(201);
  return created.data.chatId as string;
}
async function connect(t: Setup) {
  const { ticket } = (await t.api(`${root}/web/socket-tickets`, "alice", "POST", {})).data;
  const socket = new WebSocket(`ws://127.0.0.1:${t.port}${root}/web/socket?ticket=${ticket}`);
  const frames: any[] = [];
  socket.addEventListener("message", (event) => frames.push(event.data === "pong" ? "pong" : JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  cleanup.push(() => socket.close());
  return { frames, socket, wait: (predicate: (frame: any) => boolean) => until(() => frames.find(predicate), Boolean) };
}

describe("native groups (ADR 0005 phase 5)", () => {
  it("creates a group idempotently with membership events, lists it and manages members", async () => {
    const t = await setup(), [helper, writer] = t.agents;
    expect((await t.api(`${root}/web/me`)).data.limits.features).toMatchObject({ send: true, groups: true });
    const body = { idempotencyKey: key(1), title: "周报小组", agentIds: [helper!.id] };
    const first = await t.create(body);
    expect(first).toMatchObject({ status: 201, data: { chatId: expect.stringMatching(/^room:rm_/), kind: "group", title: "周报小组", agentIds: [helper!.id], readOnly: false,
      members: [{ type: "person", id: personId(owner), name: "alice" }, { type: "agent", id: helper!.id, name: "helper" }] } });
    expect((await t.create(body)).data.chatId).toBe(first.data.chatId);
    expect(await t.create({ ...body, title: "别的" })).toEqual({ status: 409, data: { error: "idempotency_key_reused" } });
    const chatId = first.data.chatId as string, roomId = chatId.slice(5);
    expect((await t.api(`${root}/web/chats`)).data.data.map((chat: any) => [chat.chatId, chat.kind])).toEqual([[chatId, "group"]]);
    expect((await t.api(`${root}/web/chats/${enc(chatId)}`)).data.members).toHaveLength(2);
    expect((await t.api(`${root}/web/groups/${roomId}/members`, "alice", "POST", { agentId: writer!.id })).data.members.map((m: any) => m.id))
      .toEqual([personId(owner), helper!.id, writer!.id]);
    expect((await t.api(`${root}/web/groups/${roomId}`, "alice", "PATCH", { title: "周报" })).data).toMatchObject({ title: "周报", agentIds: [helper!.id, writer!.id] });
    expect((await t.api(`${root}/web/groups/${roomId}/members/${helper!.id}`, "alice", "DELETE")).data.members.map((m: any) => m.id)).toEqual([personId(owner), writer!.id]);
    const members = (await t.events(chatId)).filter((event) => event.kind === "member").map((event) => [event.action, event.member?.name ?? event.title]);
    expect(members).toEqual([["add", "helper"], ["add", "writer"], ["rename", "周报"], ["remove", "helper"]]);
    // Refusals: foreign and unknown agents, limits, another owner.
    const bob = await t.service.create(other, "stranger");
    expect(await t.create({ idempotencyKey: key(2), title: "x", agentIds: [bob.id] })).toEqual({ status: 422, data: { error: "agent_not_found" } });
    expect(await t.create({ idempotencyKey: key(3), title: "x", agentIds: ["missing"] })).toEqual({ status: 422, data: { error: "agent_not_found" } });
    expect((await t.create({ idempotencyKey: key(4), title: "x".repeat(65), agentIds: [helper!.id] })).status).toBe(400);
    expect((await t.create({ idempotencyKey: key(5), title: "x", agentIds: Array.from({ length: 21 }, (_, i) => `a${i}`) })).status).toBe(400);
    expect((await t.api(`${root}/web/chats/${enc(chatId)}`, "bob")).status).toBe(404);
    expect((await t.api(`${root}/web/groups/${roomId}/members`, "bob", "POST", { agentId: bob.id })).status).toBe(404);
    const rooms = t.rooms(), active = new Map([[helper!.id, "helper"]]);
    for (let i = 1; i < ROOM_LIMITS.roomsPerOwner; i++) rooms.create(personId(owner), { idempotencyKey: `bulk-${i}`, title: `g${i}`, agentIds: [helper!.id] }, active);
    expect(await t.create({ idempotencyKey: key(6), title: "x", agentIds: [helper!.id] })).toEqual({ status: 429, data: { error: "room_limit_reached" } });
  }, 30_000);

  it("fans out only the owner's addressed messages; agent replies land in the room and trigger nobody", async () => {
    const t = await setup(), [helper, writer] = t.agents, chatId = await group(t);
    t.host(helper!.id).answer = () => "@writer 你来写初稿";
    const s = await connect(t);
    s.socket.send(JSON.stringify({ type: "req", id: "1", method: "subscribe", params: { chats: [{ chatId }] } }));
    await s.wait((frame) => frame.id === "1");
    expect(await t.send(chatId, { idempotencyKey: key(1), text: "x", mentions: { agentIds: ["someone"] } })).toEqual({ status: 422, data: { error: "mention_not_member" } });
    const sent = await t.send(chatId, { idempotencyKey: key(2), text: "@helper 帮我查一下", mentions: { agentIds: [helper!.id], all: false } });
    expect(sent.data).toMatchObject({ status: "accepted", event: { chatId, kind: "message", role: "user", text: "@helper 帮我查一下",
      mentions: { agentIds: [helper!.id], all: false }, idempotencyKey: key(2) },
      addressed: [{ agentId: helper!.id, state: "queued" }, { agentId: writer!.id, state: "not_addressed" }] });
    const reply = await s.wait((frame) => frame.event === "chat.event" && frame.data.kind === "message" && frame.data.role === "assistant");
    expect(reply.data).toMatchObject({ chatId, text: "@writer 你来写初稿", final: true, replyTo: sent.data.event.eventId, agentId: helper!.id,
      sender: { type: "agent", id: helper!.id, name: "helper" }, turnId: expect.any(String) });
    // The admission is the owner's (private group), and the turn ran in the helper's room session.
    expect(t.hosts.get(helper!.id)!.starts[0]!.input).toContain("帮我查一下");
    const turn = (await t.api(`${root}/web/chats/${enc(chatId)}/turns/${reply.data.turnId}`)).data;
    expect(turn).toMatchObject({ agentId: helper!.id, state: "completed", admission: "group", inputEventIds: [sent.data.event.eventId], finalEventId: reply.data.eventId });
    const session = t.ledger(helper!.id).sessions().find((item) => item.kind === "room")!;
    expect(session).toMatchObject({ roomId: chatId.slice(5), label: `room:${chatId.slice(5)}` });
    await until(() => t.events(chatId), (events) => events.some((event) => event.kind === "turn" && event.state === "completed"));
    // The agent's "@writer" reached nobody, a message without a mention is only recorded.
    const silent = await t.send(chatId, { idempotencyKey: key(3), text: "只是记一下" });
    expect(silent.data.addressed).toEqual([{ agentId: helper!.id, state: "not_addressed" }, { agentId: writer!.id, state: "not_addressed" }]);
    await new Promise((r) => setTimeout(r, 600));
    expect(t.hosts.get(writer!.id)?.starts ?? []).toHaveLength(0);
    // @all addresses every member; the writer's context carries the room since its last turn (none: the cursor is 0).
    t.host(writer!.id).answer = () => "收到";
    t.host(helper!.id).answer = () => "第二轮";
    const all = await t.send(chatId, { idempotencyKey: key(4), text: "大家看看", mentions: { agentIds: [], all: true } });
    expect(all.data.addressed.map((item: any) => item.state)).toEqual(["queued", "queued"]);
    await until(() => t.hosts.get(writer!.id)?.starts.length ?? 0, (n) => n === 1);
    const input = t.hosts.get(writer!.id)!.starts[0]!.input;
    expect(input).toMatch(/^群聊上下文（自你上次参与以来 3 条）：\n\[\d\d:\d\d\] 主人: @helper 帮我查一下\n\[\d\d:\d\d\] helper: @writer 你来写初稿\n\[\d\d:\d\d\] 主人: 只是记一下\n大家看看/);
    // The helper saw its own input and reply already: only the unaddressed message.
    await until(() => t.hosts.get(helper!.id)!.starts.length, (n) => n === 2);
    expect(t.hosts.get(helper!.id)!.starts[1]!.input).toMatch(/^群聊上下文（自你上次参与以来 1 条）：\n\[\d\d:\d\d\] 主人: 只是记一下\n大家看看/);
    const kinds = (await until(() => t.events(chatId), (events) => events.filter((event) => event.kind === "turn" && event.state === "completed").length === 3))
      .filter((event) => event.kind === "message").map((event) => [event.sender.name, event.text]);
    expect(kinds).toEqual(expect.arrayContaining([["alice", "大家看看"], ["writer", "收到"], ["helper", "第二轮"]]));
    expect((await t.api(`${root}/web/chats`)).data.data[0]).toMatchObject({ chatId, kind: "group", activeTurns: 0, lastEvent: { preview: expect.any(String) } });
    // Retry after a crash: delivering the same row again is deduplicated by the claim.
    const rooms = t.rooms(), roomId = chatId.slice(5);
    t.service.hubs.hub(owner).store.db.prepare("UPDATE hub_fanout SET status='queued' WHERE room_id=?").run(roomId);
    await rooms.deliver(async (agentId) => t.extension(agentId).room);
    await new Promise((r) => setTimeout(r, 500));
    expect(t.hosts.get(helper!.id)!.starts).toHaveLength(2);
    expect(t.hosts.get(writer!.id)!.starts).toHaveLength(1);
  }, 30_000);

  it("delivers one agent's rows in order, blocks after a failure and posts a notice after 24 h", async () => {
    const t = await setup({ ledgerGroups: true }), [helper] = t.agents, chatId = await group(t, [helper!.id]), roomId = chatId.slice(5), rooms = t.rooms();
    await t.service.fanout!.stop();
    const at = Date.now();
    for (const n of [1, 2, 3]) rooms.send(roomId, personId(owner), { idempotencyKey: key(n), text: `第${n}条`, mentions: { agentIds: [helper!.id] } }, at);
    const order: string[] = [];
    let fail = true;
    const channel = async () => ({ deliver: (message: { externalId: string }) => { if (fail && message.externalId.endsWith(":3")) throw new Error("ingress_down"); order.push(message.externalId); } });
    await rooms.deliver(channel, at);
    const status = () => t.service.hubs.hub(owner).store.db.prepare("SELECT seq, status, attempts, next_at, error FROM hub_fanout ORDER BY seq").all() as any[];
    // Seq 1 is a member event; the three messages are 2, 3, 4. The second fails and blocks the third.
    expect(order).toEqual([`${roomId}:2`]);
    expect(status().map((row) => [row.seq, row.status, row.error])).toEqual([[2, "delivered", null], [3, "queued", "ingress_down"], [4, "queued", null]]);
    expect(status()[1].next_at).toBe(at + 1000);
    await rooms.deliver(channel, at + 500);
    expect(order).toHaveLength(1);
    await rooms.deliver(channel, at + ROOM_LIMITS.failAfterMs);
    expect(status()[1]).toMatchObject({ status: "failed" });
    const notice = (await t.events(chatId)).find((event) => event.kind === "notice");
    expect(notice).toMatchObject({ level: "warning", text: "未能送达 helper：ingress_down", agentId: helper!.id });
    fail = false;
    await rooms.deliver(channel, at + ROOM_LIMITS.failAfterMs + 1);
    expect(order).toEqual([`${roomId}:2`, `${roomId}:4`]);
  }, 20_000);

  it("builds group context with caps, the cursor and exclusions", async () => {
    const t = await setup(), [helper, writer] = t.agents, chatId = await group(t), roomId = chatId.slice(5), rooms = t.rooms();
    await t.service.fanout!.stop();
    const person = personId(owner);
    for (let n = 1; n <= 35; n++) rooms.send(roomId, person, { idempotencyKey: `ctx-${String(n).padStart(20, "0")}`, text: `消息${n}` });
    rooms.reply(writer!.id, roomId, "d1", { kind: "message", text: "写作助理的话" });
    rooms.reply(helper!.id, roomId, "d2", { kind: "message", text: "我自己的话" });
    const addressed = rooms.send(roomId, person, { idempotencyKey: `ctx-${"a".repeat(20)}`, text: "给我的输入", mentions: { agentIds: [helper!.id] } });
    const redacted = rooms.send(roomId, person, { idempotencyKey: `ctx-${"b".repeat(20)}`, text: "撤回的" });
    t.service.hubs.hub(owner).store.db.prepare("UPDATE hub_room_events SET body=? WHERE event_id=?").run(JSON.stringify({ text: "", redacted: true }), redacted.event.eventId);
    rooms.send(roomId, person, { idempotencyKey: `ctx-${"c".repeat(20)}`, text: "长".repeat(2000) });
    const origin = rooms.send(roomId, person, { idempotencyKey: `ctx-${"d".repeat(20)}`, text: "现在问你", mentions: { agentIds: [helper!.id] } });
    const context = rooms.context(roomId, helper!.id, origin.event.seq)!;
    const lines = context.text.split("\n");
    // 35 owner messages + the writer's + the long one = 37 candidates; own, addressed and redacted ones are excluded.
    expect(lines[0]).toBe("群聊上下文（自你上次参与以来 37 条，省略 7 条）：");
    expect(lines).toHaveLength(31);
    expect(lines.at(-1)).toMatch(/^\[\d\d:\d\d\] 主人: 长+…$/);
    expect(Buffer.byteLength(lines.at(-1)!)).toBeLessThanOrEqual(ROOM_LIMITS.contextMessageBytes + 20);
    expect(context.text).toContain("写作助理的话");
    expect(context.text).not.toContain("我自己的话");
    expect(context.text).not.toContain("给我的输入");
    expect(context.text).not.toContain("撤回的");
    expect(Buffer.byteLength(lines.slice(1).join("\n"))).toBeLessThanOrEqual(ROOM_LIMITS.contextBytes);
    void addressed;
    context.commit();
    expect(rooms.cursor(roomId, helper!.id)).toBe(origin.event.seq);
    expect(rooms.context(roomId, helper!.id, origin.event.seq)!.text).toBe("");
    const next = rooms.send(roomId, person, { idempotencyKey: `ctx-${"e".repeat(20)}`, text: "再问", mentions: { agentIds: [helper!.id] } });
    expect(rooms.context(roomId, helper!.id, next.event.seq)!.text).toBe("");
  }, 20_000);

  it("mirrors cards of room turns and removes a deleted agent from its rooms", async () => {
    const t = await setup(), [helper, writer] = t.agents, chatId = await group(t), roomId = chatId.slice(5);
    await t.send(chatId, { idempotencyKey: key(1), text: "开始", mentions: { agentIds: [helper!.id] } });
    await until(() => t.events(chatId), (events) => events.some((event) => event.kind === "turn" && event.state === "completed"));
    const ledger = t.ledger(helper!.id), session = ledger.sessions().find((item) => item.kind === "room")!;
    const turnId = ledger.turns(session.sessionKey)[0]!.turnId;
    ledger.append(session.sessionKey, { kind: "card", role: "assistant", senderType: "agent", senderId: helper!.id, turnId, idempotencyKey: "card-1",
      body: { card: { cardId: "cd_1", kind: "question", text: "选哪个？" } } });
    ledger.append(session.sessionKey, { kind: "card.update", role: "system", senderType: "system", senderId: "router", turnId, idempotencyKey: "card-1-u",
      body: { cardId: "cd_1", status: "answered" } });
    const events = await until(() => t.events(chatId), (items) => items.some((event) => event.kind === "card.update"));
    expect(events.find((event) => event.kind === "card")).toMatchObject({ agentId: helper!.id, card: { cardId: "cd_1", status: "answered" }, turnId });
    // The same events are mirrored once, whatever the number of publications.
    t.service.hubs.hub(owner).sync(helper!.id);
    expect((await t.events(chatId)).filter((event) => event.kind === "card")).toHaveLength(1);
    await t.service.delete(owner, writer!.id);
    expect((await t.api(`${root}/web/chats/${enc(chatId)}`)).data.agentIds).toEqual([helper!.id]);
    expect((await t.events(chatId)).at(-1)).toMatchObject({ kind: "member", action: "remove", sender: { type: "system" } });
    expect(t.rooms().agentIds(roomId)).toEqual([helper!.id]);
  }, 20_000);

  it("keeps room chats readable with the flag off and refuses commands with 403", async () => {
    const t = await setup(), chatId = await group(t);
    await t.send(chatId, { idempotencyKey: key(1), text: "记录" });
    await stop();
    const off = await setup({ ledgerGroups: false }, t.stateDir);
    expect((await off.api(`${root}/web/me`)).data.limits.features.groups).toBe(false);
    expect((await off.api(`${root}/web/chats`)).data.data[0]).toMatchObject({ chatId, kind: "group", readOnly: true });
    expect((await off.events(chatId)).map((event) => event.kind)).toContain("message");
    expect(await off.create({ idempotencyKey: key(2), title: "x", agentIds: [off.agents[0]!.id] })).toEqual({ status: 403, data: { error: "feature_disabled" } });
    expect(await off.send(chatId, { idempotencyKey: key(3), text: "x" })).toEqual({ status: 403, data: { error: "feature_disabled" } });
    expect((await off.api(`${root}/web/groups/${chatId.slice(5)}/members/${off.agents[0]!.id}`, "alice", "DELETE")).status).toBe(403);
    expect(off.service.fanout).toBeUndefined();
    // Without the flag the room connection is not registered: channel status and dispatch are unchanged.
    const ids = (off.extension(off.agents[0]!.id).status() as { connections: Array<{ id: string }> }).connections.map((item) => item.id);
    expect(ids).not.toContain("room");
    expect(off.extension(off.agents[0]!.id).room).toBeUndefined();
  }, 20_000);
});

describe("importing ai.mau.room Matrix groups (17.6)", () => {
  const event = (id: string, sender: string, ts: number, body: string): RoomEvent & { origin_server_ts: number } =>
    ({ event_id: id, sender, type: "m.room.message", content: { msgtype: "m.text", body }, origin_server_ts: ts });
  it("imports a private group with its history gap, keeps sessions, freezes the room and notices once", async () => {
    const t = await setup(), [helper, writer] = t.agents;
    // The helper's existing Matrix group session (live ingress before the import).
    t.extension(helper!.id).communication!.receive("matrix", { externalId: "$live1", sender: owner, scope: "group", groupId: "!team:example.test",
      mentions: { self: true, all: false }, privateGroup: true, threadId: "!team:example.test", text: "旧群里的问题", reply: { target: "!team:example.test", messageId: "$live1", data: {} } });
    const sessionKey = legacySession(helper!.id, joinKey("matrix", "group", "!team:example.test", "group"));
    await until(() => t.ledger(helper!.id).session(sessionKey)?.kind, (kind) => kind === "group");
    await until(() => t.hosts.get(helper!.id)?.starts.length ?? 0, (n) => n === 1);
    const matrixSession = t.hosts.get(helper!.id)!.starts[0]!.sessionId;
    await stop();
    for (const agent of [helper!, writer!]) {
      const store = new DurableStore(join(t.stateDir, "agents", `${agent.id}.sqlite`), agent.matrixId);
      store.set("rooms", "!team:example.test", { members: [owner, helper!.matrixId, writer!.matrixId], group: true });
      store.set("room_info", "!team:example.test", { name: "老团队" });
      store.set("rooms", "!mixed:example.test", { members: [owner, other, agent.matrixId], group: true });
      if (agent === helper) store.set("timeline", joinKey("!team:example.test", "$t1"), { cursor: 1, room: "!team:example.test", event: event("$t1", owner, 1000, "第一条") });
      store.close();
    }
    const synapse = [event("$s3", writer!.matrixId, 3000, "第三条"), event("$s2", owner, 2000, "第二条"), event("$t1", owner, 1000, "第一条")];
    const sent: Array<{ room: string; body: unknown; txnId: string; agent: string }> = [];
    const options = { stateDir: t.stateDir, ownerId: owner, history: () => async () => ({ events: synapse }),
      notice: (agent: ManagedAgent) => async (room: string, _type: string, content: Record<string, unknown>, txnId: string) => { sent.push({ room, body: content.body, txnId, agent: agent.id }); return "$notice"; } };
    const dry = await importRooms({ ...options, dryRun: true });
    expect(dry.owners[0]!.rooms.map((room) => [room.matrixRoomId, room.decision])).toEqual(expect.arrayContaining([["!team:example.test", "import"], ["!mixed:example.test", "skip:has_outsiders"]]));
    expect(sent).toEqual([]);
    const report = await importRooms(options);
    const team = report.owners[0]!.rooms.find((room) => room.matrixRoomId === "!team:example.test")!;
    expect(team).toMatchObject({ decision: "import", title: "老团队", imported: 3, fromSynapse: 2, notice: "sent" });
    expect(team.sessions!.find((item) => item.agentId === helper!.id)).toEqual({ agentId: helper!.id, sessionKey, existed: true });
    const lowest = [helper!.id, writer!.id].sort()[0];
    expect(sent).toEqual([{ room: "!team:example.test", body: MIGRATED_NOTICE, txnId: digest(["room-migrated", "!team:example.test"]), agent: lowest }]);
    // A rerun imports nothing new and never sends the notice twice.
    const again = await importRooms(options);
    expect(again.owners[0]!.rooms.find((room) => room.matrixRoomId === "!team:example.test")).toMatchObject({ imported: 0, notice: "already_sent" });
    expect(sent).toHaveLength(1);

    const u = await setup({}, t.stateDir), chatId = `room:${team.roomId}`;
    const history = await u.events(chatId);
    expect(history.filter((item) => item.kind === "message").map((item) => [item.sender.type, item.text, item.channel.kind]))
      .toEqual([["person", "第一条", "matrix"], ["person", "第二条", "matrix"], ["agent", "第三条", "matrix"]]);
    expect((await u.api(`${root}/web/chats`)).data.data.find((chat: any) => chat.chatId === chatId)).toMatchObject({ title: "老团队", kind: "group" });
    // The helper's room session is its old Matrix group session: same key, now a room session; the model session continues.
    expect(u.ledger(helper!.id).session(sessionKey)).toMatchObject({ kind: "room", roomId: team.roomId });
    await u.send(chatId, { idempotencyKey: key(1), text: "网页端继续", mentions: { agentIds: [helper!.id] } });
    await until(() => u.hosts.get(helper!.id)?.starts.length ?? 0, (n) => n === 1);
    expect(u.hosts.get(helper!.id)!.starts[0]!.sessionId).toBe(matrixSession);
    expect(u.hosts.get(helper!.id)!.starts[0]!.input).toMatch(/^网页端继续/);
    // A later Matrix message in the frozen room is claimed as ignored: no transcript event and no turn.
    const record = u.extension(helper!.id).communication!.receive("matrix", { externalId: "$late", sender: owner, scope: "group", groupId: "!team:example.test",
      mentions: { self: true, all: false }, privateGroup: true, threadId: "!team:example.test", text: "Element 里的新消息", reply: { target: "!team:example.test", messageId: "$late", data: {} } });
    expect(record).toMatchObject({ state: "ignored", reason: "room_migrated" });
    expect(u.ledger(helper!.id).claimFor("matrix", "$late")).toMatchObject({ state: "ignored", reason: "room_migrated", eventId: null });
    // Groups with outsiders stay Matrix groups.
    expect((await u.api(`${root}/web/chats`)).data.data.filter((chat: any) => chat.kind === "group")).toHaveLength(1);
  }, 30_000);
});
