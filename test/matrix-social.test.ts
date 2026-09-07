import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "matrix-js-sdk";
import { SendMessageRequest, TaskState, type Task } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { MatrixConnector, type Conversation } from "../src/matrix/connector.js";
import { MatrixA2AHandler } from "../src/matrix/gateway.js";
import { ConnectorStore } from "../src/matrix/store.js";
import { contactType } from "../src/matrix/social.js";
import { SdkMatrixTransport, type MatrixTransport, type AccountEvent } from "../src/matrix/transport.js";
import { newTask, ROOM_EVENT, type RoomEvent } from "../src/matrix/protocol.js";

const alice = "@alice:a.example", bob = "@bob:b.example", eve = "@eve:e.example";
const stores: ConnectorStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const call = new ServerCallContext({ user: { isAuthenticated: true, userName: "owner" }, requestedVersion: "1.0" });
function request(text: string, contextId?: string) {
  return SendMessageRequest.fromJSON({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], contextId }, configuration: { returnImmediately: true } });
}
class Homeserver {
  accounts = new Map<string, Map<string, Record<string, unknown>>>();
  rooms = new Map<string, { members: string[]; events: RoomEvent[] }>();
  reads: Array<{ user: string; room: string; eventId: string }> = [];
  failWrites = false;
  account(user: string) {
    if (!this.accounts.has(user)) this.accounts.set(user, new Map());
    return this.accounts.get(user)!;
  }
  transport(user: string): MatrixTransport {
    const own = this.account(user);
    return {
      data: {
        get: async (type) => structuredClone(own.get(type)),
        put: async (type, data) => { if (this.failWrites) throw new Error("offline"); own.set(type, structuredClone(data)); },
        profile: async () => ({ displayname: "Synthetic" }), search: async () => ({ results: [], limited: false }), displayName: async () => {},
        leave: async (room) => { this.rooms.get(room)!.members = this.rooms.get(room)!.members.filter((id) => id !== user); },
        read: async (room, eventId) => { this.reads.push({ user, room, eventId }); },
      },
      identity: async () => user, sync: async () => ({ next_batch: "unused" }),
      history: async (room) => ({ events: [...this.rooms.get(room)!.events].reverse() }),
      createRoom: async (peer) => { const id = `!${crypto.randomUUID()}:a.example`; this.rooms.set(id, { members: [user, peer], events: [] }); return id; },
      join: async (room) => { if (!this.rooms.get(room)!.members.includes(user)) this.rooms.get(room)!.members.push(user); },
      state: async (room) => [...this.rooms.get(room)!.members.map((id) => ({ event_id: `$member-${id}`, type: "m.room.member", sender: id, state_key: id, content: { membership: "join" } })),
        { event_id: "$purpose", type: ROOM_EVENT, sender: user, content: { purpose: "a2a" } }],
      send: async (room, type, content, txn) => {
        const events = this.rooms.get(room)!.events, id = `$${user}-${txn}`;
        if (!events.some((e) => e.event_id === id)) events.push({ event_id: id, type, sender: user, content: structuredClone(content) as Record<string, unknown> });
        return id;
      }, stop: () => {},
    };
  }
  device(user: string) {
    const store = new ConnectorStore(":memory:", user); stores.push(store);
    const calls: SendMessageRequest[] = [], tasks = new Map<string, Task>();
    const connector = new MatrixConnector(user, store, this.transport(user), {
      send: async (req) => {
        calls.push(structuredClone(req));
        const task = newTask(crypto.randomUUID(), req.message!.contextId || crypto.randomUUID(), req.message!);
        task.status!.state = TaskState.TASK_STATE_COMPLETED; tasks.set(task.id, task); return task;
      },
      get: async (id) => tasks.get(id)!, cancel: async (id) => tasks.get(id)!,
    });
    return { connector, calls };
  }
  async sync(connector: MatrixConnector, roomData: Record<string, AccountEvent[]> = {}) {
    await connector.acceptSync({ next_batch: crypto.randomUUID(),
      account_data: { events: [...this.account(connector.userId)].map(([type, content]) => ({ type, content: structuredClone(content) })) },
      rooms: { join: Object.fromEntries([...this.rooms].filter(([, r]) => r.members.includes(connector.userId)).map(([id, room]) => [id,
        { timeline: { events: room.events }, account_data: { events: roomData[id] ?? [] } }])) },
    });
  }
}
describe("Matrix native client integration", () => {
  it("stores private contact metadata on the homeserver and restores another device without granting execution", async () => {
    const server = new Homeserver(), a = server.device(alice).connector, other = server.device(alice).connector;
    await a.updateContact({ address: bob, note: "Editor", tags: ["writing"], receive: "allow", execution: "allow" });
    const saved = server.account(alice).get(contactType(bob))!;
    expect(saved).toEqual({ version: 1, address: bob, note: "Editor", tags: ["writing"] });
    expect(server.account(bob).size).toBe(0);
    await server.sync(other);
    expect(other.contact(bob)).toMatchObject({ note: "Editor", tags: ["writing"], receive: "ask", execution: "ask" });
    expect(a.contact(bob)?.execution).toBe("allow");
  });
  it("keeps distinct contact edits from two devices and persists deletions without deleting room history", async () => {
    const server = new Homeserver(), a = server.device(alice).connector, other = server.device(alice).connector;
    await Promise.all([a.updateContact({ address: bob, note: "B", execution: "ask" }), other.updateContact({ address: eve, note: "E", execution: "ask" })]);
    await server.sync(a); expect(a.contacts()).toHaveLength(2);
    const conversation = await a.conversation(bob); await a.say(bob, "hello", conversation.id); await a.flush(); await server.sync(a);
    await other.removeContact(bob); await server.sync(a);
    expect(a.contact(bob)).toBeUndefined(); expect(a.contacts().map((r) => r.address)).toEqual([eve]);
    expect((await a.social!.history(conversation.room)).events).toHaveLength(1);
  });
  it("does not claim a saved change when the homeserver write fails", async () => {
    const server = new Homeserver(), a = server.device(alice).connector; server.failWrites = true;
    await expect(a.updateContact({ address: bob, note: "offline", execution: "allow" })).rejects.toThrow("offline");
    expect(a.contact(bob)).toBeUndefined();
  });
  it("ignores malformed metadata and never accepts execution permissions from account data", async () => {
    const server = new Homeserver(), a = server.device(alice).connector;
    server.account(alice).set(contactType(bob), { version: 1, address: eve, note: "forged", tags: [] });
    await server.sync(a); expect(a.contacts()).toHaveLength(0);
    server.account(alice).set(contactType(bob), { version: 1, address: bob, note: "forged", tags: [], execution: "allow" });
    await server.sync(a); expect(a.contacts()).toHaveLength(0);
  });
  it("uses m.direct, restores received conversations and lets both peers send in the same room", async () => {
    const server = new Homeserver(), a = server.device(alice), b = server.device(bob);
    await server.sync(a.connector); await server.sync(b.connector);
    const first = await a.connector.say(bob, "hello"); await a.connector.flush(); await server.sync(b.connector);
    const incoming = b.connector.social!.conversations()[0]!;
    await b.connector.say(alice, "hello back", incoming.id); await b.connector.flush(); await server.sync(a.connector);
    expect(server.rooms.size).toBe(1);
    expect(a.connector.social!.entries().map((r) => r.event.content.body)).toEqual(["hello", "hello back"]);
    expect(a.calls).toHaveLength(0); expect(b.calls).toHaveLength(0);
    expect(server.account(alice).get("m.direct")).toEqual({ [bob]: [first.room] });
    expect(server.account(bob).get("m.direct")).toEqual({ [alice]: [first.room] });
  });
  it("routes fresh tasks in both directions through one conversation and keeps a room's runtime context", async () => {
    const server = new Homeserver(), a = server.device(alice), b = server.device(bob);
    await server.sync(a.connector); await server.sync(b.connector);
    a.connector.setContact({ address: bob, note: "", execution: "allow" }); b.connector.setContact({ address: alice, note: "", execution: "allow" });
    const ga = new MatrixA2AHandler(a.connector, bob, "http://127.0.0.1");
    const gb = new MatrixA2AHandler(b.connector, alice, "http://127.0.0.1");
    const task = await ga.sendMessage(request("first"), call);
    const cycle = async () => { await a.connector.flush(); await server.sync(b.connector); await b.connector.work(); await b.connector.flush(); await server.sync(a.connector); await a.connector.work(); };
    await cycle();
    const received = b.connector.store.entries<Conversation>("conversations")[0]!.value;
    await gb.sendMessage(request("active reply", received.id), call); await cycle();
    await ga.sendMessage(request("next", task.contextId), call); await cycle();
    expect(server.rooms.size).toBe(1); expect(a.calls).toHaveLength(1); expect(b.calls).toHaveLength(2);
    expect(b.calls[1]?.message?.contextId).toBeTruthy();
  });
  it("does not let m.direct forge membership or send an existing context to a different peer", async () => {
    const server = new Homeserver(), a = server.device(alice).connector;
    const room = await a.conversation(bob);
    server.account(alice).set("m.direct", { [eve]: [room.room] }); await server.sync(a);
    expect(a.social!.conversations().every((r) => r.peer === bob)).toBe(true);
    await expect(a.say(eve, "wrong peer", room.id)).rejects.toThrow("conversation_not_found");
  });
  it("applies native blocking to approved queued work and makes unblocking require new execution permission", async () => {
    const server = new Homeserver(), a = server.device(alice), b = server.device(bob);
    await server.sync(a.connector); await server.sync(b.connector);
    const g = new MatrixA2AHandler(a.connector, bob, "http://127.0.0.1");
    await g.sendMessage(request("pending"), call); await a.connector.flush(); await server.sync(b.connector);
    b.connector.approve(b.connector.pending()[0]!.id);
    await b.connector.social!.block(alice, true); await b.connector.work();
    expect(b.calls).toHaveLength(0);
    expect(server.account(bob).get("m.ignored_user_list")).toEqual({ ignored_users: { [alice]: {} } });
    const other = server.device(bob).connector; await server.sync(other);
    expect(other.contact(alice)?.execution).toBe("deny"); expect(other.social!.entries()).toHaveLength(0);
    await b.connector.social!.block(alice, false);
    expect(b.connector.contact(alice)?.execution ?? "ask").toBe("ask");
  });
  it("restores historical tasks as review-only even when a new device has execution permission", async () => {
    const server = new Homeserver(), a = server.device(alice).connector;
    await new MatrixA2AHandler(a, bob, "http://127.0.0.1").sendMessage(request("old work"), call); await a.flush();
    const b = server.device(bob); b.connector.setContact({ address: alice, note: "", execution: "allow" });
    await server.sync(b.connector); await b.connector.work();
    expect(b.calls).toHaveLength(0);
    expect(b.connector.pending()[0]?.error).toBe("history_restored_without_execution_state");
    await server.sync(b.connector); await b.connector.work(); expect(b.calls).toHaveLength(0);
  });
  it("removes cached invitations and pending requests after a native block", async () => {
    const server = new Homeserver(), a = server.device(alice).connector, b = server.device(bob);
    await server.sync(b.connector);
    await new MatrixA2AHandler(a, bob, "http://127.0.0.1").sendMessage(request("pending"), call); await a.flush(); await server.sync(b.connector);
    b.connector.store.set("invites", "!old:a.example", { sender: alice });
    await b.connector.social!.block(alice, true); await b.connector.work();
    expect(b.connector.store.entries("invites")).toHaveLength(0); expect(b.connector.pending()).toHaveLength(0); expect(b.calls).toHaveLength(0);
  });
  it("applies native redactions to cached text while exposing the redaction event", async () => {
    const server = new Homeserver(), a = server.device(alice).connector;
    const sent = await a.say(bob, "erase this text"); await a.flush(); await server.sync(a);
    const target = a.social!.entries()[0]!.event.event_id;
    server.rooms.get(sent.room)!.events.push({ event_id: "$redact", type: "m.room.redaction", sender: alice, content: { redacts: target } });
    await server.sync(a);
    expect(a.social!.entries()[0]!.event.content).toEqual({});
    expect(a.social!.entries()[1]!.event.type).toBe("m.room.redaction");
  });
  it("deduplicates notifications, persists read markers, and syncs a marker written on another device", async () => {
    const server = new Homeserver(), a = server.device(alice).connector, b = server.device(bob).connector;
    await server.sync(b);
    const sent = await a.say(bob, "a message"); await a.flush(); await server.sync(b); await server.sync(b);
    expect(b.social!.entries()).toHaveLength(1); expect(b.social!.conversations()[0]?.unread).toBe(1);
    await b.social!.read(sent.room); expect(b.social!.conversations()[0]?.unread).toBe(0);
    const read = server.reads[0]!; expect(read.user).toBe(bob);
    const other = server.device(bob).connector;
    await server.sync(other, { [sent.room]: [{ type: "m.fully_read", content: { event_id: read.eventId } }] });
    expect(other.social!.conversations()[0]?.unread).toBe(0);
  });
  it("leaves through the homeserver, removes direct mapping and preserves cached history", async () => {
    const server = new Homeserver(), a = server.device(alice).connector;
    const sent = await a.say(bob, "before leaving"); await a.flush(); await server.sync(a);
    await a.social!.leave(sent.room);
    expect(server.rooms.get(sent.room)?.members).toEqual([bob]);
    expect(server.account(alice).get("m.direct")).toEqual({ [bob]: [] });
    expect(a.social!.entries()).toHaveLength(1);
    await expect(a.say(bob, "after leaving", sent.contextId)).rejects.toThrow("conversation_left");
  });
  it("uses authenticated standard Matrix HTTP endpoints for account data and private read receipts", async () => {
    const calls: Array<{ path: string; body: unknown; auth: string | null }> = [];
    const client = createClient({ baseUrl: "https://a.example", userId: alice, accessToken: "synthetic-token", fetchFn: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ path: decodeURIComponent(url.pathname), body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("Authorization") });
      return new Response(JSON.stringify(url.pathname.endsWith("/versions") ? { versions: ["v1.4", "v1.18"] } : init?.method === "GET" ? { ignored_users: {} } : {}), { status: 200, headers: { "Content-Type": "application/json" } });
    } });
    const transport = new SdkMatrixTransport("https://a.example", "synthetic-token", alice, client);
    await transport.data.get("m.ignored_user_list"); await transport.data.put(contactType(bob), { version: 1, address: bob, note: "B" });
    await transport.data.read("!room:a.example", "$event");
    expect(calls.every((c) => c.auth === "Bearer synthetic-token")).toBe(true);
    expect(calls[0]?.path).toBe(`/_matrix/client/v3/user/${alice}/account_data/m.ignored_user_list`);
    expect(calls.find((c) => c.path.endsWith("/read_markers"))?.body).toEqual({ "m.fully_read": "$event", "m.read.private": "$event" });
    transport.stop();
  });
});
