import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SendMessageRequest, TaskState, type Task } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { CliWork } from "../src/matrix/cli-work.js";
import { ConnectorStore } from "../src/matrix/store.js";
import { MatrixConnector } from "../src/matrix/connector.js";
import { MatrixA2AHandler } from "../src/matrix/gateway.js";
import { createConnectorApp } from "../src/matrix/index.js";
import { ROOM_EVENT, type RoomEvent } from "../src/matrix/protocol.js";
import type { MatrixTransport } from "../src/matrix/transport.js";

const A = "@alice:a.example", B = "@bob:b.example";
const source = { sender: A, room: "!room:a.example", approved: false };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const request = (text = "hello", fields: object = {}) => SendMessageRequest.fromJSON({
  message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...fields }, configuration: { returnImmediately: true },
});
function queue(policy: () => "allow" | "ask" | "deny" = () => "allow") {
  const store = new ConnectorStore(":memory:", B); cleanup.push(() => store.close());
  return new CliWork(store, policy);
}
describe("CLI execution inbox", () => {
  it("claims atomically, returns a lost claim to the same worker, and serializes a conversation", async () => {
    const work = queue();
    const first = await work.send(request(), source);
    const second = await work.send(request("next", { contextId: first.contextId }), source);
    const claim = work.claim("session-a")!;
    expect(claim.id).toBe(first.id); expect(work.claim("session-a")).toEqual(claim);
    expect(work.claim("session-b")).toBeNull();
    expect(() => work.claim("session-a", second.id)).toThrow("worker_already_has_work");
    work.update(claim.claimId!, "reply", "done");
    expect(work.claim("session-b")!.id).toBe(second.id);
  });
  it("persists claims and output events across restart without redelivering them to another worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-work-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let store = new ConnectorStore(join(dir, "work.sqlite"), B);
    let work = new CliWork(store, () => "allow");
    const task = await work.send(request(), source), claim = work.claim("persistent-session")!;
    work.update(claim.claimId!, "progress", "half done"); store.close();
    store = new ConnectorStore(join(dir, "work.sqlite"), B); cleanup.push(() => store.close());
    work = new CliWork(store, () => "allow");
    expect(work.claim("other-session")).toBeNull();
    expect(work.claim("persistent-session")!.claimId).toBe(claim.claimId);
    expect((await work.get(task.id)).status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(work.events()).toHaveLength(2);
    work.update(claim.claimId!, "reply", "recovered");
    expect((await work.get(task.id)).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it("durably orders progress and results, and retries the same reply without duplicate output", async () => {
    const work = queue(), req = request();
    const task = await work.send(req, source); expect((await work.send(req, source)).id).toBe(task.id);
    const claim = work.claim("worker")!;
    work.update(claim.claimId!, "progress", "working");
    const result = work.update(claim.claimId!, "reply", "answer", { count: 3 });
    expect(work.update(claim.claimId!, "reply", "answer", { count: 3 })).toEqual(result);
    expect(work.events().map((e) => e.value.status?.state)).toEqual([2, 2, 3]);
    expect(() => work.update(claim.claimId!, "reply", "different answer")).toThrow("claim_closed");
    expect((await work.get(task.id)).artifacts[0]!.parts).toHaveLength(2);
  });
  it("continues input-required work in the same context with a new claim and rejects stale submissions", async () => {
    const work = queue(), task = await work.send(request(), source);
    const claim = work.claim("worker")!; work.update(claim.claimId!, "need-input", "Which file?");
    expect(work.claim("worker")).toBeNull();
    const continued = await work.send(request("report.txt", { taskId: task.id, contextId: task.contextId }), source);
    expect(continued.id).toBe(task.id); expect(continued.contextId).toBe(task.contextId);
    const next = work.claim("worker")!; expect(next.claimId).not.toBe(claim.claimId);
    expect(() => work.update(claim.claimId!, "reply", "stale")).toThrow("claim_closed");
    work.update(next.claimId!, "reply", "done");
  });
  it("requires acknowledging new input arriving during work before allowing completion", async () => {
    const work = queue(), task = await work.send(request(), source), claim = work.claim("worker")!;
    await work.send(request("additional input", { taskId: task.id }), source);
    expect(work.inspect(claim.claimId!).newInput).toBe(true);
    expect(() => work.update(claim.claimId!, "reply", "old answer")).toThrow("new_input_available_claim_again");
    const next = work.claim("worker")!; expect(next.claimId).not.toBe(claim.claimId);
    expect(next.history).toHaveLength(2);
    work.update(next.claimId!, "reply", "updated answer");
  });
  it("cancels unclaimed work immediately but waits for claimed work to acknowledge stopping", async () => {
    const work = queue(), unclaimed = await work.send(request(), source);
    expect((await work.cancel(unclaimed.id)).status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(work.claim("worker")).toBeNull();
    const task = await work.send(request(), source), claim = work.claim("worker")!;
    expect((await work.cancel(task.id)).status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(work.inspect(claim.claimId!).cancelRequested).toBe(true);
    expect(() => work.update(claim.claimId!, "reply", "too late")).toThrow("cancellation_requested_stop_and_acknowledge");
    work.update(claim.claimId!, "cancelled", "Stopped.");
    expect((await work.get(task.id)).status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
  it("rechecks authorization before claiming and stops work when the sender is blocked", async () => {
    let permission: "allow" | "ask" | "deny" = "allow";
    const work = queue(() => permission), task = await work.send(request(), source);
    permission = "ask"; expect(work.claim("worker")).toBeNull(); expect(work.inspect(task.id).needsApproval).toBe(true);
    work.approve(task.id); const claim = work.claim("worker")!;
    permission = "deny"; work.reconcile(); expect(work.inspect(task.id).cancelRequested).toBe(true);
    expect(() => work.update(claim.claimId!, "progress", "continuing")).toThrow("cancellation_requested");
    work.update(claim.claimId!, "cancelled", "Stopped.");
    const other = await work.send(request(), source); work.reconcile();
    expect((await work.get(other.id)).status?.state).toBe(TaskState.TASK_STATE_REJECTED);
  });
  it("preserves the claim after an oversized result is rejected and accepts a smaller retry", async () => {
    const work = queue(), task = await work.send(request(), source), claim = work.claim("worker")!;
    expect(() => work.update(claim.claimId!, "reply", "x".repeat(50000))).toThrow("result_too_large");
    expect(work.inspect(task.id).claimId).toBe(claim.claimId);
    work.update(claim.claimId!, "reply", "x".repeat(30000));
    expect((await work.get(task.id)).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it("isolates senders and room contexts and rejects changed retries", async () => {
    const work = queue(), req = request(), task = await work.send(req, source);
    req.message!.parts = request("tampered").message!.parts;
    await expect(work.send(req, source)).rejects.toThrow("work_message_id_reused");
    await expect(work.send(request("tampered", { taskId: task.id }), { ...source, sender: B })).rejects.toThrow("work_scope_mismatch");
  });
  it("prevents changing execution adapters once task/context ownership exists", async () => {
    const work = queue(); work.store.bindExecution();
    await work.send(request(), source);
    const claim = work.claim("worker")!; work.update(claim.claimId!, "reply", "done");
    expect(() => work.store.bindExecution("http://agent/card")).toThrow("backend_changed");
    expect(() => work.store.bindExecution()).not.toThrow();
    const empty = queue(); empty.store.bindExecution(); empty.store.bindExecution("http://agent/card");
    expect(() => empty.store.bindExecution("http://agent/card")).not.toThrow();
    expect(() => empty.store.bindExecution()).toThrow("backend_changed");
  });
});

function peers() {
  const rooms = new Map<string, RoomEvent[]>();
  const transport = (user: string): MatrixTransport => ({
    identity: async () => user, sync: async () => ({ next_batch: "unused" }), stop() {},
    data: { get: async () => undefined, put: async () => {}, profile: async () => ({}), search: async () => ({ results: [], limited: false }),
      displayName: async () => {}, leave: async () => {}, read: async () => {} },
    createRoom: async () => { const id = `!${crypto.randomUUID()}:a.example`; rooms.set(id, []); return id; },
    state: async () => [...[A, B].map((id) => ({ event_id: "", type: "m.room.member", sender: id, state_key: id, content: { membership: "join" } })),
      { event_id: "", type: ROOM_EVENT, sender: A, state_key: "", content: { purpose: "a2a" } }],
    join: async () => {}, history: async () => ({ events: [] }),
    send: async (room, type, content, txn) => {
      const events = rooms.get(room)!; const id = `$${user}:${txn}`;
      if (!events.some((e) => e.event_id === id)) events.push({ event_id: id, sender: user, type, content: content as Record<string, unknown> }); return id;
    },
  });
  const connectors = [A, B].map((id) => {
    const store = new ConnectorStore(":memory:", id); cleanup.push(() => store.close()); store.set("meta", "sync", "initialized");
    return new MatrixConnector(id, store, transport(id), undefined);
  });
  const [a, b] = connectors as [MatrixConnector, MatrixConnector];
  const call = new ServerCallContext({ user: { isAuthenticated: true, userName: "owner" }, requestedVersion: "1.0" });
  const ag = new MatrixA2AHandler(a, B, "http://localhost"), bg = new MatrixA2AHandler(b, A, "http://localhost");
  const cycle = async () => {
    for (let n = 0; n < 3; n++) for (const c of connectors) {
      await c.acceptSync({ next_batch: crypto.randomUUID(), rooms: { join: Object.fromEntries([...rooms].map(([room, events]) => [room, { timeline: { events } }])) } });
      await c.work(); await c.flush();
    }
  };
  return { a, b, ag, bg, call, cycle };
}
describe("CLI-only peers through the existing Matrix/A2A adapter", () => {
  it("keeps approval separate from claiming and returns progress/results to the original sender", async () => {
    const { a, b, ag, call, cycle } = peers();
    const task = await ag.sendMessage(request(), call); await cycle();
    expect(b.cli!.claim("worker")).toBeNull(); expect(b.pending()).toHaveLength(1);
    b.approve(b.pending()[0]!.id); await cycle();
    const claimed = b.cli!.claim("worker")!; b.cli!.update(claimed.claimId!, "progress", "halfway"); await cycle();
    expect(a.task(task.id)?.status?.message?.parts[0]?.content?.value).toBe("halfway");
    b.cli!.update(claimed.claimId!, "reply", "RESULT"); await cycle();
    expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(a.task(task.id)?.artifacts[0]?.parts[0]?.content?.value).toBe("RESULT");
    expect(b.cli!.events()).toHaveLength(0);
  });
  it("handles input continuation and lets the receiver initiate new work in the same room", async () => {
    const { a, b, ag, bg, call, cycle } = peers();
    for (const [c, id] of [[a, B], [b, A]] as const) c.setContact({ address: id, note: "", execution: "allow", receive: "allow" });
    const task = await ag.sendMessage(request(), call); await cycle();
    const claim = b.cli!.claim("b-worker")!; b.cli!.update(claim.claimId!, "need-input", "Details?"); await cycle();
    expect(a.task(task.id)?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    await ag.sendMessage(request("details", { taskId: task.id, contextId: task.contextId }), call); await cycle();
    const continued = b.cli!.claim("b-worker")!; expect(continued.contextId).toBe(claim.contextId);
    b.cli!.update(continued.claimId!, "reply", "done"); await cycle();
    const reverse = await bg.sendMessage(request("follow-up", { contextId: claim.conversation }), call); await cycle();
    const received = a.cli!.claim("a-worker")!; expect(received.conversation).toBe(claim.conversation);
    a.cli!.update(received.claimId!, "reply", "reverse answer"); await cycle();
    expect(b.task(reverse.id)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it("reports a known local rejection without marking execution acceptance uncertain", async () => {
    const { b, ag, call, cycle } = peers();
    b.setContact({ address: A, note: "", execution: "allow" });
    const task = await ag.sendMessage(request(), call); await cycle();
    const claim = b.cli!.claim("worker")!; b.cli!.update(claim.claimId!, "reply", "done");
    // A continuation can race the delivery of the final response back to the sender.
    await ag.sendMessage(request("late input", { taskId: task.id, contextId: task.contextId }), call);
    await cycle();
    expect(b.pending()).toHaveLength(0);
    expect(b.store.entries<{ error?: string }>("incoming").some((r) => r.value.error === "work_closed")).toBe(true);
  });
  it("requires local authentication and exposes durable work through the HTTP routes used by the CLI", async () => {
    const { b, ag, call, cycle } = peers();
    b.setContact({ address: A, note: "", execution: "allow" }); await ag.sendMessage(request(), call); await cycle();
    const server = createConnectorApp(b, "synthetic-token", "http://localhost").listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(base + "/api/inbox")).status).toBe(401);
    for (const token of ["short", "synthetic-tokem", "synthetic-token-too-long"]) {
      expect((await fetch(base + "/api/inbox", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    }
    const post = (path: string, body: object) => fetch(base + path, { method: "POST", headers: { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/work/claim", { worker: "w", wait: 90 })).status).toBe(400);
    const claim = await (await post("/api/work/claim", { worker: "w" })).json() as { claimId: string };
    expect((await post(`/api/work/${claim.claimId}/update`, { action: "reply", text: "HTTP result" })).status).toBe(200);
    expect((await post(`/api/work/${claim.claimId}/update`, { action: "reply", text: "different" })).status).toBe(409);
  });
});
