import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceConfig, type ServiceExtension } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import { channelConfigSchema, createChannelRuntime } from "../src/service/channels.js";
import type { HostPort, HostRun } from "../src/execution/host.js";
import { AgentLedger, legacySession } from "../src/ledger/ledger.js";
import { personId } from "../src/ledger/registry.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", other = "@bob:example.test", root = "/_agent-router/v1", enc = encodeURIComponent;
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
async function setup(overrides: Partial<ServiceConfig> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-send-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const host = new Host(), extensions = new Map<string, ServiceExtension>();
  const service: ManagedService = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48), ledgerRead: true, ledgerSend: true, ...overrides }, {
    authenticate: async (token) => { if (token === "alice") return owner; if (token === "bob") return other; throw new Error("bad_credentials"); },
    provision: async () => {}, transport,
    configure: async (agent, connector) => {
      const config = channelConfigSchema.parse({ agents: [{ agentId: agent.id, connections: [{ id: "matrix", kind: "matrix" }],
        host: { binding: "fixture", runtimeId: "fixture" } }] }).agents[0]!;
      const extension = await createChannelRuntime(agent, connector, config, stateDir, (name) => {
        const issued = service.issue(agent.id, name);
        return { id: issued.instance.id, validate: () => { service.instance(issued.token, agent.id); } };
      }, host, { persons: service.persons });
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
  const agent = await service.create(owner, "helper");
  const ledger = AgentLedger.attached((await service.runtime(agent.id)).connector.store)!;
  const chatId = `dm:${agent.id}`;
  const send = (body: Record<string, unknown>, token = "alice") => api(`${root}/web/chats/${enc(chatId)}/messages`, token, "POST", body);
  const events = async () => (await api(`${root}/web/chats/${enc(chatId)}/events?limit=200`)).data.events as any[];
  return { service, api, agent, ledger, host, port, chatId, send, events, extension: () => extensions.get(agent.id)! };
}
async function connect(t: Awaited<ReturnType<typeof setup>>) {
  const { ticket } = (await t.api(`${root}/web/socket-tickets`, "alice", "POST", {})).data;
  const socket = new WebSocket(`ws://127.0.0.1:${t.port}${root}/web/socket?ticket=${ticket}`);
  const frames: any[] = [];
  socket.addEventListener("message", (event) => frames.push(event.data === "pong" ? "pong" : JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  cleanup.push(() => socket.close());
  return { frames, socket, wait: (predicate: (frame: any) => boolean) => until(() => frames.find(predicate), Boolean) };
}
const key = "01JC9Z7Q4M0000000000000001";

describe("owner send via Router (web channel)", () => {
  it("creates the DM chat, sends with an idempotency key, runs a turn and pushes the reply over the socket", async () => {
    const t = await setup();
    expect((await t.api(`${root}/web/me`)).data.limits.features).toMatchObject({ history: true, send: true, attachments: false });
    expect((await t.api(`${root}/web/chats`)).data.data).toEqual([]);
    const dm = await t.api(`${root}/web/chats/dm`, "alice", "POST", { agentId: t.agent.id });
    expect(dm.data).toMatchObject({ chatId: t.chatId, kind: "dm", readOnly: false, lastSeq: 0 });
    expect((await t.api(`${root}/web/chats`)).data.data.map((chat: any) => chat.chatId)).toEqual([t.chatId]);
    const s = await connect(t);
    s.socket.send(JSON.stringify({ type: "req", id: "1", method: "subscribe", params: { chats: [{ chatId: t.chatId }] } }));
    await s.wait((frame) => frame.id === "1");
    const sent = await t.send({ idempotencyKey: key, text: "你好" });
    expect(sent).toEqual({ status: 200, data: { status: "accepted", addressed: [{ agentId: t.agent.id, state: "queued" }], event: {
      chatId: t.chatId, seq: 1, generation: 1, eventId: expect.stringMatching(/^ev_/), at: expect.any(String), kind: "message", role: "user", text: "你好",
      sender: { type: "person", id: personId(owner), name: "alice" }, channel: { kind: "web" }, idempotencyKey: key } } });
    const reply = await s.wait((frame) => frame.event === "chat.event" && frame.data.kind === "message" && frame.data.role === "assistant");
    expect(reply.data).toMatchObject({ chatId: t.chatId, text: "回答-1", final: true, channel: { kind: "web" }, sender: { type: "agent", id: t.agent.id } });
    expect(t.host.starts[0]!.input).toContain("你好");
    const kinds = (await t.events()).map((event) => [event.kind, event.state ?? event.text ?? null]);
    expect(kinds).toEqual([["message", "你好"], ["turn", "queued"], ["turn", "running"], ["message", "回答-1"], ["turn", "completed"]]);
    expect((await t.events())[1].turnId).toBe(reply.data.turnId);
    expect((await t.api(`${root}/web/chats/${enc(t.chatId)}/turns/${reply.data.turnId}`)).data).toMatchObject({ state: "completed", admission: "owner",
      inputEventIds: [sent.data.event.eventId], finalEventId: reply.data.eventId });
    // The legacy task API still sees the turn, keyed by the web connection.
    const tasks = (await t.api(`${root}/agents/${t.agent.id}/communication/tasks`)).data.data;
    expect(tasks).toMatchObject([{ id: reply.data.turnId, conversationId: legacySession(t.agent.id, "owner-main"), source: { connectionId: "web", scope: "direct" },
      replyMessageIds: [reply.data.eventId] }]);
  }, 20_000);
  it("returns the original event for a retry, 409 for a reused key and validates the request", async () => {
    const t = await setup();
    const first = await t.send({ idempotencyKey: key, text: "一次" });
    const retry = await t.send({ idempotencyKey: key, text: "一次" });
    expect(retry.data).toMatchObject({ status: "duplicate", event: { eventId: first.data.event.eventId, seq: 1 } });
    expect(await t.send({ idempotencyKey: key, text: "改了" })).toEqual({ status: 409, data: { error: "idempotency_key_reused" } });
    expect((await t.send({ idempotencyKey: "short", text: "x" })).status).toBe(400);
    expect(await t.send({ idempotencyKey: `${key}2`, text: "  " })).toEqual({ status: 422, data: { error: "message_empty" } });
    expect(await t.send({ idempotencyKey: `${key}3`, text: "中".repeat(8001) })).toEqual({ status: 413, data: { error: "message_too_large" } });
    expect(await t.send({ idempotencyKey: `${key}4`, text: "图", attachments: ["at_1"] })).toEqual({ status: 422, data: { error: "attachments_unsupported" } });
    expect(await t.send({ idempotencyKey: `${key}5`, text: "x", mentions: { agentIds: ["someone"] } })).toEqual({ status: 422, data: { error: "mention_not_member" } });
    expect(await t.send({ idempotencyKey: `${key}6`, text: "x", replyTo: "ev_missing" })).toEqual({ status: 422, data: { error: "reply_target_not_found" } });
    const replied = await t.send({ idempotencyKey: `${key}7`, text: "接着说", replyTo: first.data.event.eventId });
    expect(replied.data.event).toMatchObject({ seq: 2, replyTo: first.data.event.eventId });
    await until(() => t.host.starts.length, (n) => n >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.host.starts.filter((start) => start.input.includes("一次"))).toHaveLength(1);
  }, 20_000);
  it("isolates owners: a foreign chat, send and redaction are not found", async () => {
    const t = await setup();
    const sent = await t.send({ idempotencyKey: key, text: "私密" });
    expect(await t.send({ idempotencyKey: key, text: "私密" }, "bob")).toEqual({ status: 404, data: { error: "chat_not_found" } });
    expect(await t.api(`${root}/web/chats/${enc(t.chatId)}/events/${sent.data.event.eventId}/redact`, "bob", "POST", { idempotencyKey: key })).toEqual({ status: 404, data: { error: "chat_not_found" } });
    expect(await t.api(`${root}/web/chats/dm`, "bob", "POST", { agentId: t.agent.id })).toEqual({ status: 404, data: { error: "chat_not_found" } });
    // Observed chats (other sessions of the agent) are read-only.
    t.extension().communication!.receive("matrix", { externalId: "$g1", sender: owner, scope: "group", groupId: "!group:example.test", mentions: { self: true, all: false },
      threadId: "!group:example.test", text: "群消息", reply: { target: "!group:example.test", messageId: "$g1", data: {} } });
    const observed = (await until(async () => (await t.api(`${root}/web/chats`)).data.data as any[], (chats) => chats.some((chat) => chat.kind === "observed")))
      .find((chat) => chat.kind === "observed").chatId;
    expect(await t.api(`${root}/web/chats/${enc(observed)}/messages`, "alice", "POST", { idempotencyKey: key, text: "x" })).toEqual({ status: 403, data: { error: "chat_read_only" } });
  });
  it("merges a Matrix owner DM into the same chat and session, with channel badges and unchanged Matrix delivery", async () => {
    const t = await setup();
    await t.send({ idempotencyKey: key, text: "从网页" });
    await until(t.events, (events) => events.some((event) => event.text === "回答-1"));
    t.extension().communication!.receive("matrix", { externalId: "$m1", sender: owner, scope: "direct", threadId: "!dm:example.test", text: "从 Matrix",
      reply: { target: "!dm:example.test", messageId: "$m1", data: { sender: owner, thread: "" } } });
    const events = await until(t.events, (items) => items.some((event) => event.text === "回答-2"));
    expect(events.filter((event) => event.kind === "message").map((event) => [event.role, event.text, event.channel.kind]))
      .toEqual([["user", "从网页", "web"], ["assistant", "回答-1", "web"], ["user", "从 Matrix", "matrix"], ["assistant", "回答-2", "matrix"]]);
    const matrixReply = events.find((event) => event.text === "回答-2");
    expect(t.ledger.deliveriesFor(matrixReply.eventId)).toMatchObject([{ purpose: "reply", connectionId: "matrix" }]);
    expect(t.ledger.deliveriesFor(events.find((event) => event.text === "回答-1").eventId)).toEqual([]);
    // Both turns ran in the one owner-main execution context.
    expect(new Set(t.host.starts.map((start) => start.sessionId)).size).toBe(1);
  }, 20_000);
  it("lets the owner redact own web messages only, idempotently", async () => {
    const t = await setup();
    const sent = await t.send({ idempotencyKey: key, text: "撤回我" });
    const events = await until(t.events, (items) => items.some((event) => event.text === "回答-1"));
    const redact = (eventId: string, idempotencyKey = `${key}r`) => t.api(`${root}/web/chats/${enc(t.chatId)}/events/${enc(eventId)}/redact`, "alice", "POST", { idempotencyKey });
    const first = await redact(sent.data.event.eventId);
    expect(first.data).toMatchObject({ status: "accepted", dropped: false, event: { kind: "redaction", targetEventId: sent.data.event.eventId, sender: { type: "person" }, channel: { kind: "web" } } });
    expect((await redact(sent.data.event.eventId)).data).toMatchObject({ status: "duplicate", event: { eventId: first.data.event.eventId } });
    const history = await t.events();
    expect(history.find((event) => event.eventId === sent.data.event.eventId)).toMatchObject({ text: "", redacted: true });
    expect(await redact(events.find((event) => event.text === "回答-1").eventId, `${key}s`)).toEqual({ status: 403, data: { error: "redaction_not_allowed" } });
    expect((await t.api(`${root}/web/chats/${enc(t.chatId)}/events/${sent.data.event.eventId}/redact`, "alice", "POST", {})).status).toBe(400);
    expect(await redact("ev_missing", `${key}t`)).toEqual({ status: 404, data: { error: "event_not_found" } });
    expect(t.host.starts).toHaveLength(1);
  }, 20_000);
  it("stays off without the send flag: feature false, routes not found, dispatch on the legacy path", async () => {
    const t = await setup({ ledgerSend: false });
    expect((await t.api(`${root}/web/me`)).data.limits.features.send).toBe(false);
    expect((await t.send({ idempotencyKey: key, text: "x" })).status).toBe(404);
    expect((await t.api(`${root}/web/chats/${enc(t.chatId)}/events/ev_x/redact`, "alice", "POST", { idempotencyKey: key })).status).toBe(404);
    expect(t.ledger.authoritative).toBe(false);
    // No web connection without the flag: channel status and dispatch are exactly the phase 2 ones.
    expect(t.extension().web).toBeUndefined();
    expect((t.extension().status() as { connections: Array<{ id: string }> }).connections.map((item) => item.id)).toEqual(["matrix"]);
    expect((await t.api(`${root}/web/chats/dm`, "alice", "POST", { agentId: t.agent.id })).data).toMatchObject({ chatId: t.chatId });
  });
});
