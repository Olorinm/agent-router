import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Message, SendMessageRequest, TaskState, Task, Artifact, type SendMessageResult } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { ClientFactory, DefaultAgentCardResolver, RestTransportFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { MatrixConnector, type Incoming, type Outgoing } from "../src/matrix/connector.js";
import { MatrixA2AHandler } from "../src/matrix/gateway.js";
import { createConnectorApp } from "../src/matrix/index.js";
import { ConnectorStore } from "../src/matrix/store.js";
import { REQUEST_EVENT, RESPONSE_EVENT, encodeResult, key, newTask, type RoomEvent } from "../src/matrix/protocol.js";
import type { MatrixTransport, SyncBatch } from "../src/matrix/transport.js";
import type { ExecutionBackend } from "../src/matrix/backend.js";

const alice = "@alice:a.example", bob = "@bob:b.example";
const call = new ServerCallContext({ user: { isAuthenticated: true, userName: "owner" }, requestedVersion: "1.0" });
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function request(text = "hello", extra: object = {}): SendMessageRequest {
  return SendMessageRequest.fromJSON({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra }, configuration: { returnImmediately: true } });
}
class Fabric {
  rooms = new Map<string, RoomEvent[]>();
  txns = new Map<string, string>();
  encrypted = false;
  joined = true;
  failAfterSend = false;
  historyFails = false;
  transport(user: string): MatrixTransport {
    return {
      identity: async () => user,
      sync: async () => { await new Promise((r) => setTimeout(r, 10)); return { next_batch: "idle" }; },
      history: async (room, from) => {
        if (this.historyFails) throw new Error("history_temporarily_unavailable");
        return { events: this.rooms.get(room)!.slice(0, Number(from)).reverse() };
      },
      createRoom: async () => { const room = `!${crypto.randomUUID()}:a.example`; this.rooms.set(room, []); return room; },
      join: async () => {}, state: async () => this.encrypted ? [{ type: "m.room.encryption" } as RoomEvent] :
        this.joined ? [alice, bob].map((address) => ({ type: "m.room.member", state_key: address, content: { membership: "join" } } as RoomEvent)) : [],
      send: async (room, type, content, txn) => {
        const txnKey = key(user, room, type, txn);
        let id = this.txns.get(txnKey);
        if (!id) {
          id = `$${crypto.randomUUID()}`; this.txns.set(txnKey, id);
          this.rooms.get(room)!.push({ event_id: id, sender: user, type, content: content as Record<string, unknown> });
        }
        if (this.failAfterSend) { this.failAfterSend = false; throw new Error("lost_send_ack"); }
        return id;
      }, stop: () => {},
    };
  }
  async deliver(connector: MatrixConnector): Promise<void> {
    const rooms = Object.fromEntries([...this.rooms].map(([room, events]) => [room, { timeline: { events } }]));
    await connector.acceptSync({ next_batch: crypto.randomUUID(), rooms: { join: rooms } });
  }
}
class Backend implements ExecutionBackend {
  calls: SendMessageRequest[] = [];
  tasks = new Map<string, Task>();
  state = TaskState.TASK_STATE_COMPLETED;
  fail = false;
  async send(req: SendMessageRequest): Promise<SendMessageResult> {
    this.calls.push(structuredClone(req));
    if (this.fail) throw new Error("lost_backend_acceptance");
    const message = req.message!;
    const task = message.taskId ? this.tasks.get(message.taskId)! : newTask(crypto.randomUUID(), message.contextId || crypto.randomUUID(), message);
    if (message.taskId) task.history.push(message);
    task.status = { state: this.state, timestamp: new Date().toISOString(), message: undefined };
    task.artifacts = [Artifact.fromJSON({ artifactId: "result", parts: [{ text: "RESULT" }] })];
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }
  async get(id: string): Promise<Task> { return structuredClone(this.tasks.get(id)!); }
  async cancel(id: string): Promise<Task> { const t = this.tasks.get(id)!; t.status!.state = TaskState.TASK_STATE_CANCELED; return structuredClone(t); }
}
function setup(path = ":memory:") {
  const fabric = new Fabric(), backend = new Backend();
  const aStore = new ConnectorStore(":memory:", alice), bStore = new ConnectorStore(path, bob);
  cleanup.push(() => aStore.close()); cleanup.push(() => bStore.close());
  const a = new MatrixConnector(alice, aStore, fabric.transport(alice), undefined, 10);
  const b = new MatrixConnector(bob, bStore, fabric.transport(bob), backend, 10);
  b.setContact({ address: alice, note: "", execution: "allow" });
  const gateway = new MatrixA2AHandler(a, bob, "https://gateway.example");
  const cycle = async () => { await a.flush(); await fabric.deliver(b); await b.work(); await b.flush(); await fabric.deliver(a); };
  return { a, b, backend, fabric, gateway, cycle };
}
describe("Matrix delivery and A2A execution", () => {
  it("keeps a blocking official A2A send open until its result arrives", async () => {
    const { a, gateway, cycle } = setup();
    const req = request(); req.configuration!.returnImmediately = false;
    let settled = false;
    const result = gateway.sendMessage(req, call).then((r) => { settled = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(a.tasks()).toHaveLength(1); expect(settled).toBe(false);
    await cycle(); expect((await result).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it("records an accepted oversized result without replaying execution or losing its binding", async () => {
    const { a, b, backend, gateway, cycle } = setup();
    const original = backend.send.bind(backend);
    backend.send = async (req) => {
      const task = await original(req) as Task;
      task.artifacts[0]!.parts[0]!.content = { $case: "text", value: "x".repeat(60_000) };
      return task;
    };
    const task = await gateway.sendMessage(request(), call); await cycle(); await cycle();
    expect(backend.calls).toHaveLength(1); expect(b.pending()).toHaveLength(0);
    expect(b.store.entries("bindings")).toHaveLength(1);
    expect(a.store.entries<Outgoing>("outgoing")[0]?.value.error).toBe("result_too_large");
    expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
  });
  it("does not autojoin based on execution permission alone", async () => {
    const { b } = setup(); let joined = 0;
    b.transport.join = async () => { joined++; };
    const batch: SyncBatch = { next_batch: "invited", rooms: { invite: { "!invite:a.example": { invite_state: {
      events: [{ type: "m.room.member", state_key: bob, sender: alice, content: { membership: "invite" } } as RoomEvent],
    } } } } };
    await b.acceptSync(batch); expect(joined).toBe(0);
    b.setContact({ address: alice, note: "", receive: "allow", execution: "ask" });
    await b.acceptSync(batch); expect(joined).toBe(1);
  });
  it("keeps the first request durable until the destination has joined the room", async () => {
    const { a, backend, fabric, gateway, cycle } = setup(); fabric.joined = false;
    await gateway.sendMessage(request(), call); await cycle(); expect(backend.calls).toHaveLength(0);
    expect(a.store.entries<any>("outbox")[0]?.value.error).toBe("waiting_for_recipient_join");
    fabric.joined = true;
    for (const row of a.store.entries<any>("outbox")) a.store.set("outbox", row.id, { ...row.value, nextAt: 0 });
    await cycle(); expect(backend.calls).toHaveLength(1);
  });
  it("uses destination context across new tasks and preserves artifacts and source Message IDs", async () => {
    const { a, backend, gateway, cycle } = setup();
    const first = request("remember");
    const task = await gateway.sendMessage(first, call); await cycle();
    expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(a.task(task.id)?.history).toHaveLength(1);
    expect(a.task(task.id)?.history[0]?.messageId).toBe(first.message!.messageId);
    await gateway.sendMessage(request("recall", { contextId: task.contextId }), call); await cycle();
    expect(backend.calls[1]?.message?.contextId).toBe([...backend.tasks.values()][0]?.contextId);
    expect(a.task(task.id)?.artifacts[0]?.parts[0]?.content?.value).toBe("RESULT");
  });
  it("continues INPUT_REQUIRED using the same destination task", async () => {
    const { a, backend, gateway, cycle } = setup();
    backend.state = TaskState.TASK_STATE_INPUT_REQUIRED;
    const t = await gateway.sendMessage(request("input"), call); await cycle();
    expect(a.task(t.id)?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    backend.state = TaskState.TASK_STATE_COMPLETED;
    const resumed = await gateway.sendMessage(request("answer", { taskId: t.id, contextId: t.contextId }), call);
    expect(resumed.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    await cycle();
    expect(backend.calls[1]?.message?.taskId).toBe([...backend.tasks.keys()][0]);
    expect(a.task(t.id)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it("deduplicates both SDK retries and different Matrix events carrying the same request", async () => {
    const { a, b, backend, fabric, gateway, cycle } = setup();
    const r = request(); const t = await gateway.sendMessage(r, call);
    expect((await gateway.sendMessage(r, call)).id).toBe(t.id);
    await cycle(); const [room, events] = [...fabric.rooms][0]!;
    b.ingest(room, { ...events[0]!, event_id: "$replayed" }); await b.work();
    expect(backend.calls).toHaveLength(1);
    expect(a.tasks()).toHaveLength(1);
    await expect(gateway.sendMessage({ ...r, metadata: { changed: true } }, call)).rejects.toThrow("messageId");
  });
  it("reuses the Matrix transaction ID after a lost send acknowledgment", async () => {
    const { a, backend, fabric, gateway, cycle } = setup();
    await gateway.sendMessage(request(), call); fabric.failAfterSend = true; await a.flush();
    for (const row of a.store.entries<any>("outbox")) a.store.set("outbox", row.id, { ...row.value, nextAt: 0 });
    await cycle(); expect(backend.calls).toHaveLength(1);
    expect([...fabric.rooms.values()][0]!.filter((e) => e.type === REQUEST_EVENT)).toHaveLength(1);
  });
  it("holds strangers until explicit approval and checks permission again before execution", async () => {
    const { a, b, backend, fabric, gateway } = setup();
    b.store.delete("contacts", alice);
    await gateway.sendMessage(request(), call); await a.flush(); await fabric.deliver(b); await b.work();
    expect(backend.calls).toHaveLength(0); expect(b.pending()).toHaveLength(1);
    b.setContact({ address: alice, note: "A contact is not a grant", execution: "ask" });
    await b.work(); expect(backend.calls).toHaveLength(0);
    b.approve(b.pending()[0]!.id); await b.work(); expect(backend.calls).toHaveLength(1);
    b.setContact({ address: alice, note: "", execution: "allow" });
    await gateway.sendMessage(request(), call); await a.flush(); await fabric.deliver(b);
    b.setContact({ address: alice, note: "", execution: "ask" }); await b.work();
    expect(backend.calls).toHaveLength(1); expect(b.pending()).toHaveLength(1);
  });
  it("never replays uncertain backend acceptance or falsely confirms its cancellation", async () => {
    const { a, b, backend, fabric, gateway, cycle } = setup(); backend.fail = true;
    const task = await gateway.sendMessage(request(), call); await cycle();
    expect(b.pending()[0]?.status).toBe("uncertain");
    await cycle(); expect(backend.calls).toHaveLength(1);
    const outgoing = a.store.entries<Outgoing>("outgoing")[0]!.value;
    b.ingest(outgoing.room, { event_id: "$cancel", sender: alice, type: REQUEST_EVENT,
      content: { ...outgoing.request, requestId: "cancel", operation: "cancel", body: {} } });
    await b.work(); await b.flush();
    const reply = fabric.rooms.get(outgoing.room)!.find((e) => e.content.requestId === "cancel" && e.type === RESPONSE_EVENT);
    expect(reply?.content.error).toMatchObject({ code: "cancellation_acceptance_unknown" });
    expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
  });
  it("cancels work before delivery to the backend, including a later original request", async () => {
    const { a, b, backend, gateway, cycle } = setup();
    const task = await gateway.sendMessage(request(), call);
    const conversation = await a.conversation(bob, task.contextId);
    a.enqueue(bob, conversation, task, request(), "cancel");
    await cycle(); expect(backend.calls).toHaveLength(0);
    expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(b.pending()).toHaveLength(0);
  });
  it("removes a canceled, unapproved request from the inbox without executing it", async () => {
    const { a, b, backend, gateway, cycle } = setup(); b.store.delete("contacts", alice);
    const task = await gateway.sendMessage(request(), call); await cycle(); expect(b.pending()).toHaveLength(1);
    a.enqueue(bob, await a.conversation(bob, task.contextId), task, request(), "cancel"); await cycle();
    expect(b.pending()).toHaveLength(0); expect(backend.calls).toHaveLength(0);
    expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
  it("cancels a running destination task and does not regress a terminal result", async () => {
    const { a, backend, gateway, cycle } = setup(); backend.state = TaskState.TASK_STATE_WORKING;
    const task = await gateway.sendMessage(request(), call); await cycle();
    a.enqueue(bob, await a.conversation(bob, task.contextId), a.task(task.id)!, request(), "cancel");
    await cycle(); expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    await cycle(); expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
  it("rejects forged responses and invalid high sequence numbers without suppressing a valid response", async () => {
    const { a, backend, gateway, cycle } = setup();
    const task = await gateway.sendMessage(request(), call);
    const out = a.store.entries<Outgoing>("outgoing")[0]!.value;
    const content = { version: 1, recipient: alice, requestId: out.id, taskId: task.id, sequence: 999, result: { task: {} } };
    a.ingest(out.room, { event_id: "$forged", sender: "@mallory:b.example", type: RESPONSE_EVENT, content });
    a.ingest(out.room, { event_id: "$invalid", sender: bob, type: RESPONSE_EVENT, content });
    expect(a.store.get("received_sequences", task.id)).toBeUndefined();
    await cycle(); expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it("does not send plaintext or execute in encrypted rooms", async () => {
    const { a, backend, fabric, gateway, cycle } = setup();
    await gateway.sendMessage(request(), call); fabric.encrypted = true; await cycle();
    expect(backend.calls).toHaveLength(0); expect([...fabric.rooms.values()][0]).toHaveLength(0);
    expect(a.store.entries<any>("outbox")[0]?.value.error).toBe("encrypted_room_requires_crypto_connector");
  });
  it("recovers a limited sync gap and commits neither events nor cursor if history fails", async () => {
    const { a, b, backend, fabric, gateway } = setup();
    const t = await gateway.sendMessage(request("one"), call);
    await gateway.sendMessage(request("two", { contextId: t.contextId }), call); await a.flush();
    const [room, events] = [...fabric.rooms][0]!;
    const batch: SyncBatch = { next_batch: "after-gap", rooms: { join: { [room]: { timeline: { events: events.slice(1), limited: true, prev_batch: "1" } } } } };
    fabric.historyFails = true; await expect(b.acceptSync(batch)).rejects.toThrow("history_temporarily");
    expect(b.store.get("meta", "sync")).toBeUndefined(); expect(b.pending()).toHaveLength(0);
    fabric.historyFails = false; await b.acceptSync(batch); await b.work();
    expect(backend.calls).toHaveLength(2); expect(b.store.get("meta", "sync")).toBe("after-gap");
  });
  it("persists receipt, mappings and dedup across a connector restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-test-")); cleanup.push(() => rmSync(dir, { recursive: true }));
    const path = join(dir, "receiver.sqlite");
    const { a, b, backend, fabric, gateway } = setup(path);
    const t = await gateway.sendMessage(request("first"), call); await a.flush(); await fabric.deliver(b); await b.work();
    const reopened = new ConnectorStore(path, bob); cleanup.push(() => reopened.close());
    const restarted = new MatrixConnector(bob, reopened, fabric.transport(bob), backend);
    await fabric.deliver(restarted); await restarted.work(); expect(backend.calls).toHaveLength(1);
    await gateway.sendMessage(request("second", { contextId: t.contextId }), call); await a.flush(); await fabric.deliver(restarted); await restarted.work();
    expect(backend.calls[1]?.message?.contextId).toBe([...backend.tasks.values()][0]?.contextId);
  });
  it("marks an interrupted acceptance uncertain on startup and enforces store identity/lease", async () => {
    const { a, b, backend, gateway, fabric } = setup();
    await gateway.sendMessage(request(), call); await a.flush(); await fabric.deliver(b);
    const row = b.store.entries<Incoming>("incoming")[0]!;
    b.store.set("incoming", row.id, { ...row.value, status: "sending" });
    await b.start(); await b.stop();
    expect(b.pending()[0]?.status).toBe("uncertain"); expect(backend.calls).toHaveLength(0);
    b.store.acquireLease("one"); expect(() => b.store.acquireLease("two")).toThrow("already_in_use");
    b.store.releaseLease("one");
  });
  it.each(["REST", "JSONRPC"])("accepts the official SDK client through %s with authentication and task isolation", async (binding) => {
    const { a, gateway, cycle } = setup();
    const server = createConnectorApp(a, "synthetic-owner-token", "http://127.0.0.1").listen(0, "127.0.0.1");
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("listen_failed");
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/contacts`)).status).toBe(401);
    // Card host is an explicit deployment setting. The test's random port is substituted before discovery.
    const authed: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input)); url.port = String(address.port);
      return fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: "Bearer synthetic-owner-token" } });
    };
    const client = await new ClientFactory({ cardResolver: new DefaultAgentCardResolver({ fetchImpl: authed }),
      transports: binding === "REST" ? [new RestTransportFactory({ fetchImpl: authed })] : [new JsonRpcTransportFactory({ fetchImpl: authed })] })
      .createFromUrl(`${base}/agents/${encodeURIComponent(bob)}/`);
    const t = await client.sendMessage(request()); if ("messageId" in t) throw new Error("task_required");
    await cycle(); const completed = await client.getTask({ id: t.id, tenant: "", historyLength: 20 });
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const listed = await client.listTasks({ contextId: t.contextId, status: TaskState.TASK_STATE_COMPLETED,
      statusTimestampAfter: "", pageSize: 10, pageToken: "", tenant: "", includeArtifacts: true, historyLength: 0 });
    expect(listed.tasks.map((task) => task.id)).toEqual([t.id]); expect(listed.tasks[0]?.history).toEqual([]);
    const stranger = new MatrixA2AHandler(a, "@other:b.example", base);
    await expect(stranger.getTask({ id: t.id, tenant: "", historyLength: 20 })).rejects.toThrow("Task not found");
  });
});
