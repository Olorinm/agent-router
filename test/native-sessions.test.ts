import { afterEach, describe, expect, it } from "vitest";
import { DurableStore } from "../src/communication/store.js";
import { CommunicationCore } from "../src/communication/core.js";
import { CliWork } from "../src/execution/work.js";
import { HostWorker } from "../src/execution/host-worker.js";
import { WorkSessions } from "../src/execution/sessions.js";
import { HttpAgentHost, type HostCall, type HostPort, type HostRun, type HostStartInput, type NativeSessionInput } from "../src/execution/host.js";
import { ChannelHttpError, ServiceHttp } from "../src/channels/http.js";
import type { HostTools } from "../src/execution/tools.js";

const stores: DurableStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
class Host implements HostPort {
  starts: HostStartInput[] = []; runs = new Map<string, HostRun>(); pending: HostCall[] = [];
  resolved: unknown[] = []; native: NativeSessionInput[] = []; methods: unknown[] = [];
  loseStart = false;
  async connect() {}
  async inspectRuntime(runtimeId: string) { return { id: runtimeId, cwd: "/trusted/workspace" }; }
  async start(input: HostStartInput) {
    this.starts.push(input);
    const run: HostRun = { id: `run-${this.starts.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "running", answer: "" };
    this.runs.set(run.id, run);
    if (this.loseStart) throw new Error("lost_response");
    return run;
  }
  async get(id: string) { return this.runs.get(id)!; }
  async findRun(runtimeId: string, requestKey: string) {
    const index = this.starts.findIndex(input => input.runtimeId === runtimeId && input.requestKey === requestKey);
    return index < 0 ? null : this.runs.get(`run-${index + 1}`)!;
  }
  async cancel(id: string) { this.runs.get(id)!.status = "cancelled"; }
  async calls(id: string) { return this.pending.filter(call => call.runId === id); }
  async resolve(id: string, callId: string, result: unknown) { this.resolved.push({ id, callId, result }); this.pending = this.pending.filter(call => call.id !== callId); }
  async nativeSessions(input: NativeSessionInput) {
    this.native.push(input);
    if (input.action === "bindings") return { bindings: this.starts.map((s, i) => ({ sessionId: s.sessionId, nativeSessionId: `native-${i}` })) };
    return { thread: { id: "native", turns: [] }, data: [], nextCursor: null };
  }
  async nativeRequest(runtimeId: string, method: string, params?: Record<string, unknown>) {
    this.methods.push({ runtimeId, method, params });
    return method === "skills/list" ? { data: [{ skills: [{ name: "plan", path: "/trusted/plan/SKILL.md" }] }] } : {};
  }
}
const admission = { kind: "owner" as const, owner: "owner", agentId: "agent", reference: "request" };
function setup(tools?: HostTools, maxConcurrentRuns = 4) {
  const store = new DurableStore(":memory:", "agent"); stores.push(store);
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("agent", store, work), host = new Host();
  const worker = new HostWorker("agent", "instance", store, work, host, "codex", "instructions", () => {}, () => false, tools, core, undefined, { maxConcurrentRuns });
  const sessions = new WorkSessions("agent", "owner", "codex", "instance", store, work, host, core, () => {}, input => worker.dependencyWait(input));
  return { store, work, core, host, sessions, worker };
}
async function ticks(worker: HostWorker, n = 3) { for (let i = 0; i < n; i++) await worker.tick(); }

describe("native session coordination", () => {
  it("admits typed input and product context atomically, deduplicates events and reads results without contacting Host", async () => {
    const h = setup();
    const input = { eventId: "one", sessionId: "work", input: "do work", admission,
      context: { memory: "user-approved preference" }, inputItems: [{ type: "skill", name: "plan", path: "/trusted/plan/SKILL.md" }] };
    const first = await h.sessions.submit(input);
    expect(await h.sessions.submit(input)).toEqual(first);
    await expect(h.sessions.submit({ ...input, input: "different" })).rejects.toThrow("work_event_id_reused");
    expect(h.store.get("work_session_inputs", first.taskId)).toMatchObject({ admission });
    await h.worker.tick();
    expect(h.host.starts).toHaveLength(1); expect(h.host.starts[0]).toMatchObject({ inputItems: input.inputItems, context: input.context, admission });
    Object.assign(h.host.runs.get("run-1")!, { status: "completed", answer: "x".repeat(40_000) });
    await h.worker.tick();
    h.host.get = async () => { throw new Error("must_not_wake"); };
    expect(h.sessions.get("one")).toMatchObject({ status: "completed", answer: "x".repeat(40_000), outcomeUnknown: false });
    expect(h.core.status().outbox).toHaveLength(0);
  });
  it("continues observing and starting sibling sessions while a parent's tool awaits completion", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const tools: HostTools = { instructions: "", definitions: [{ name: "wait", description: "wait", inputSchema: {}, timeoutMs: 1000 }],
      allowed: () => true, execute: async () => { await waiting; return { success: true, contentItems: [] }; } };
    const h = setup(tools);
    await h.sessions.submit({ eventId: "parent", input: "parent", admission }); await h.worker.tick();
    h.host.pending.push({ id: "wait", runId: "run-1", kind: "tool", name: "wait", input: {}, status: "pending", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    await h.worker.tick();
    await h.sessions.submit({ eventId: "child", input: "child", admission }); await h.worker.tick();
    expect(h.host.starts).toHaveLength(2);
    Object.assign(h.host.runs.get("run-2")!, { status: "completed", answer: "child done" });
    await h.worker.tick(); expect(h.sessions.get("child").status).toBe("completed");
    release(); await ticks(h.worker);
    expect(h.host.resolved).toHaveLength(1);
  });
  it("bounds concurrency while serializing each session, including deferred tasks", async () => {
    const h = setup(undefined, 2);
    for (const [eventId, sessionId] of [["a", "same"], ["b", "same"], ["c", "other"], ["d", "third"]])
      await h.sessions.submit({ eventId: eventId!, sessionId: sessionId!, input: eventId!, admission });
    await ticks(h.worker); expect(h.host.starts.map(s => s.input)).toEqual(["a", "c"]);
    h.host.runs.get("run-1")!.status = "completed"; await ticks(h.worker);
    expect(h.host.starts.map(s => s.input)).toEqual(["a", "c", "b"]);
    expect(h.host.starts[0]!.sessionId).toBe(h.host.starts[2]!.sessionId);
  });
  it.each([1, 4])("uses a fixed dependency reserve when %i parent runs fill all regular slots", async limit => {
    const h = setup(undefined, limit), controller = new AbortController(), waits: Promise<unknown>[] = [];
    try {
      for (let i = 0; i < limit; i++) await h.sessions.submit({ eventId: `parent-${i}`, input: "parent", admission });
      await ticks(h.worker); expect(h.host.starts).toHaveLength(limit);
      await h.sessions.submit({ eventId: "unrelated", input: "unrelated", admission });
      for (let i = 0; i < limit; i++) {
        const eventId = `child-${i}`;
        await h.sessions.submit({ eventId, input: eventId, admission: { ...admission, kind: "delegation" } });
        const snapshot = await h.sessions.wait([eventId], { timeoutMs: 0 });
        waits.push(h.sessions.wait([eventId], { ...(i === 0 ? {} : { after: snapshot.cursor }), timeoutMs: 2000, signal: controller.signal,
          waitingRunId: `run-${i + 1}`, waitingReference: admission.reference, waitingCallId: `wait-${i}` }));
      }
      await ticks(h.worker);
      expect(h.host.starts).toHaveLength(limit * 2);
      expect(h.host.starts.every(input => input.input !== "unrelated")).toBe(true);
      for (let i = limit + 1; i <= limit * 2; i++) Object.assign(h.host.runs.get(`run-${i}`)!, { status: "completed", answer: "child done" });
      await ticks(h.worker); await Promise.all(waits);
      expect([...Array(limit)].every((_, i) => h.sessions.get(`child-${i}`).status === "completed")).toBe(true);
      expect(h.sessions.get("unrelated").status).toBe("submitted");
      for (let i = 1; i <= limit; i++) h.host.runs.get(`run-${i}`)!.status = "completed";
      await ticks(h.worker); expect(h.host.starts.at(-1)!.input).toBe("unrelated");
    } finally { controller.abort(); await Promise.allSettled(waits); }
  });
  it("rejects forged dependency contexts, self-waits and deeper waits beyond the fixed live ceiling", async () => {
    const h = setup(undefined, 1), controller = new AbortController();
    await h.sessions.submit({ eventId: "parent", sessionId: "parent-session", input: "parent", admission }); await h.worker.tick();
    await h.sessions.submit({ eventId: "child", input: "child", admission: { ...admission, kind: "delegation", reference: "spawn-child" } });
    const context = { waitingRunId: "run-1", waitingReference: admission.reference, waitingCallId: "wait-child" };
    await expect(h.sessions.wait(["child"], { ...context, waitingRunId: "another-agent-run" })).rejects.toThrow("work_dependency_run_not_active");
    await expect(h.sessions.wait(["child"], { ...context, waitingReference: "forged" })).rejects.toThrow("work_dependency_context_mismatch");
    await expect(h.sessions.wait(["parent"], context)).rejects.toThrow("work_dependency_same_session");
    await h.sessions.submit({ eventId: "same-session", sessionId: "parent-session", input: "later", admission });
    await expect(h.sessions.wait(["same-session"], context)).rejects.toThrow("work_dependency_same_session");
    const first = await h.sessions.wait(["child"], { timeoutMs: 0 });
    const waiting = h.sessions.wait(["child"], { ...context, after: first.cursor, timeoutMs: 2000, signal: controller.signal });
    try {
      await ticks(h.worker); expect(h.host.starts).toHaveLength(2);
      await h.sessions.submit({ eventId: "grandchild", input: "grandchild", admission: { ...admission, kind: "delegation" } });
      const snapshot = await h.sessions.wait(["grandchild"], { timeoutMs: 0 });
      await expect(h.sessions.wait(["grandchild"], { after: snapshot.cursor, waitingRunId: "run-2", waitingReference: "spawn-child", waitingCallId: "wait-grandchild" }))
        .rejects.toThrow("work_dependency_capacity_exhausted");
      await ticks(h.worker); expect(h.host.starts).toHaveLength(2);
      await waiting; // The child started, so the original cursor advanced and its reservation ended.
      await ticks(h.worker); expect(h.host.starts).toHaveLength(2);
    } finally { controller.abort(); await Promise.allSettled([waiting]); }
  });
  it("reconciles a lost submission by its stable key without executing twice", async () => {
    const h = setup(); h.host.loseStart = true;
    await h.sessions.submit({ eventId: "lost", input: "once", admission }); await h.worker.tick();
    expect(h.sessions.get("lost").outcomeUnknown).toBe(true);
    h.host.runs.get("run-1")!.status = "completed";
    await ticks(h.worker);
    expect(h.host.starts).toHaveLength(1); expect(h.sessions.get("lost").status).toBe("completed");
  });
  it("keeps uncertain submissions within the live capacity until reconciliation confirms a terminal result", async () => {
    const h = setup(undefined, 1); h.host.loseStart = true;
    await h.sessions.submit({ eventId: "uncertain", input: "once", admission }); await h.worker.tick();
    h.host.findRun = async () => null;
    await h.sessions.submit({ eventId: "next", input: "next", admission }); await ticks(h.worker);
    expect(h.host.starts).toHaveLength(1); expect(h.sessions.get("next").status).toBe("submitted");
    h.host.findRun = async () => h.host.runs.get("run-1")!;
    h.host.loseStart = false; h.host.runs.get("run-1")!.status = "completed";
    await ticks(h.worker, 5); expect(h.host.starts).toHaveLength(2);
  });
  it("scopes native operations to Router bindings and rejects arbitrary native identifiers and unlisted skill paths", async () => {
    const h = setup(); await h.sessions.submit({ eventId: "one", sessionId: "owned", input: "one", admission }); await h.worker.tick();
    await h.sessions.history("owned", { limit: 2, cursor: "native-cursor", itemsView: "notLoaded" });
    expect(h.host.native.at(-1)).toMatchObject({ sessionId: h.host.starts[0]!.sessionId, limit: 2, cursor: "native-cursor", itemsView: "notLoaded", action: "history" });
    await expect(h.sessions.native("owned", { action: "list" })).rejects.toThrow("use_scoped_session_operation");
    await expect(h.sessions.read("someone-elses-native-id")).rejects.toThrow("session_not_found");
    await expect(h.sessions.configureSkill("/private/unknown", true)).rejects.toThrow("skill_not_in_runtime_catalog");
    await h.sessions.configureSkill("/trusted/plan/SKILL.md", true);
    expect(h.host.methods).toContainEqual({ runtimeId: "codex", method: "skills/list", params: { forceReload: true, cwds: ["/trusted/workspace"] } });
    await h.sessions.memoryMode("owned", "disabled");
    expect(h.host.methods.at(-1)).toMatchObject({ method: "thread/memoryMode/set", params: { threadId: "native-0", mode: "disabled" } });
    h.host.inspectRuntime = async () => ({ id: "someone-elses-runtime", cwd: "/private" });
    await expect(h.sessions.skills()).rejects.toThrow("host_runtime_scope_mismatch");
  });
  it("delivers scheduled/delegated work as native tool output, preserving source and only verified skill references", async () => {
    const h = setup();
    await h.sessions.submit({ eventId: "scheduled", input: "inspect", admission: { ...admission, kind: "schedule", toolGrants: {} },
      inputItems: [{ type: "skill", name: "plan", path: "/trusted/plan/SKILL.md" }] });
    await h.worker.tick();
    expect(h.host.starts[0]).toMatchObject({ input: "", toolOutput: { namespace: "mau", name: "proactive_work", retain: false } });
    expect(h.host.starts[0]).not.toHaveProperty("inputItems");
    expect(JSON.parse(h.host.starts[0]!.toolOutput!.output as string)).toMatchObject({ source: { kind: "schedule" }, message: "inspect", skills: [{ name: "plan", path: "/trusted/plan/SKILL.md" }] });
    expect(h.host.methods).toContainEqual({ runtimeId: "codex", method: "skills/list", params: { forceReload: true, cwds: ["/trusted/workspace"] } });
    await h.sessions.submit({ eventId: "invalid", input: "image", admission: { ...admission, kind: "delegation" }, inputItems: [{ type: "image", imageUrl: "data:irrelevant" }] });
    await h.worker.tick(); expect(h.host.starts).toHaveLength(1);
    expect(h.sessions.get("invalid")).toMatchObject({ status: "failed", outcomeUnknown: false, error: "native_tool_delivery_typed_input_unsupported" });
  });
  it("rejects forged, expired and ungranted admissions before queueing work", async () => {
    const h = setup();
    for (const invalid of [{ ...admission, owner: "other" }, { ...admission, agentId: "other" },
      { ...admission, kind: "schedule" as const }, { ...admission, expiresAt: "2020-01-01T00:00:00Z" }])
      await expect(h.sessions.submit({ eventId: "forged", input: "do it", admission: invalid })).rejects.toThrow();
    expect(h.work.list(true)).toHaveLength(0);
    expect(() => h.sessions.deliver({ eventId: "notice", targetSessionId: "unknown", text: "notify" })).toThrow("session_not_found");
  });
  it("rolls back queued work when its server-authored admission cannot be persisted", async () => {
    const h = setup(), save = h.store.set.bind(h.store);
    h.store.set = (collection, id, value) => { if (collection === "work_session_events") throw new Error("disk_failure"); save(collection, id, value); };
    await expect(h.sessions.submit({ eventId: "atomic", input: "do work", admission })).rejects.toThrow("disk_failure");
    expect(h.work.list(true)).toHaveLength(0); expect(h.store.entries("work_session_inputs")).toHaveLength(0);
    await h.worker.tick(); expect(h.host.starts).toHaveLength(0);
  });
  it("keeps notification intent and outbox atomic and returns stable receipts across retries", async () => {
    const h = setup();
    let sends = 0;
    h.core.register({ id: "chat", ownerAddresses: ["owner"] }, { kind: "telegram", start: async () => {}, stop: async () => {}, send: async () => ({ externalId: `sent-${++sends}` }) });
    await h.core.start();
    const message = h.core.receive("chat", { externalId: "owner-message", sender: "owner", scope: "direct", threadId: "private", text: "hello", reply: { target: "private", messageId: "owner-message", data: {} } });
    await h.core.dispatch(); await h.worker.tick();
    const notify = { eventId: "notice", targetSessionId: message.conversationId, text: "A result" }, save = h.store.set.bind(h.store);
    h.store.set = (collection, id, value) => { if (collection === "work_session_deliveries") throw new Error("disk_failure"); save(collection, id, value); };
    expect(() => h.sessions.deliver(notify)).toThrow("disk_failure"); expect(h.store.entries("communication_outbox")).toHaveLength(0);
    h.store.set = save;
    const first = h.sessions.deliver(notify); expect(h.sessions.deliver(notify)).toEqual(first);
    expect(() => h.sessions.deliver({ ...notify, text: "changed" })).toThrow("delivery_event_id_reused");
    await h.core.flush(); expect(sends).toBe(1);
    expect(h.sessions.lookupDelivery("notice")).toMatchObject({ id: first.id, state: "accepted", externalId: "sent-1" });
    await h.core.stop();
  });
  it("waits for changes in saved results without waking the native runtime", async () => {
    const h = setup(); await h.sessions.submit({ eventId: "one", input: "one", admission });
    const first = await h.sessions.wait(["one"], { timeoutMs: 0 });
    expect(await h.sessions.wait(["one"], { after: first.cursor, timeoutMs: 0 })).toEqual(first);
    await h.worker.tick(); const changed = await h.sessions.wait(["one"], { after: first.cursor, timeoutMs: 0 });
    expect(changed.cursor).not.toBe(first.cursor);
  });
  it("keeps unsupported native methods distinct from transport failures with native error metadata", async () => {
    const h = setup(), nativeError = { method: "memory/status", code: -32601, data: { experimental: true } };
    h.host.nativeRequest = async () => { throw new ChannelHttpError(500, "native_error", nativeError); };
    await expect(h.sessions.memoryStatus()).rejects.toMatchObject({ message: "native_method_unsupported", status: 409, nativeError });
    h.host.nativeRequest = async () => { throw new ChannelHttpError(500, "native_error", { code: -32600 }); };
    await expect(h.sessions.memoryStatus()).rejects.toMatchObject({ message: "native_request_invalid", status: 400, nativeError: { code: -32600 } });
    h.host.nativeRequest = async () => { throw new ChannelHttpError(403, "native_method_not_allowed"); };
    await expect(h.sessions.memoryStatus()).rejects.toMatchObject({ message: "native_method_not_allowed", status: 403 });
    h.host.nativeRequest = async () => { throw new Error("socket_closed"); };
    await expect(h.sessions.memoryStatus()).rejects.toMatchObject({ message: "host_request_failed", status: 502 });
  });
});

describe("public Host protocol forwarding", () => {
  it("preserves native responses/errors and refuses keyed submissions without the required Host capability", async () => {
    const requests: Array<{ url: string; body?: any }> = [];
    let runIdempotency: boolean | undefined;
    const http = new ServiceHttp("http://fixture", "token", (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ url, body });
      if (url.endsWith("health")) return Response.json({ protocolVersion: 1, capabilities: { runIdempotency } });
      if (url.endsWith("/native")) return body.method === "fail" ? Response.json({ error: "native_error", nativeError: { code: -32601, data: { marker: true } } }, { status: 409 }) : Response.json({ result: null });
      if (url.includes("by-request")) return Response.json({ run: null });
      return Response.json({ id: "run", sessionId: "session", runtimeId: "codex", status: "running", answer: "" });
    }) as typeof fetch);
    const host = new HttpAgentHost(http), input = { sessionId: "session", runtimeId: "codex", instructions: "", input: "hello", requestKey: "once", admission };
    await host.connect();
    await expect(host.start(input)).rejects.toMatchObject({ status: 409, code: "host_run_idempotency_unsupported" });
    runIdempotency = false; await host.connect();
    await expect(host.start(input)).rejects.toMatchObject({ status: 409, code: "host_run_idempotency_unsupported" });
    expect(requests.some(request => request.url.endsWith("/v1/runs"))).toBe(false);
    const { requestKey: _key, ...unkeyed } = input;
    await host.start(unkeyed);
    expect(requests.at(-1)!.body).not.toHaveProperty("admission");
    runIdempotency = true; await host.connect(); await host.start(input);
    expect(requests.at(-1)!.body.requestKey).toBe("once"); expect(requests.at(-1)!.body).not.toHaveProperty("admission");
    expect(await host.findRun("codex", "once")).toBeNull(); expect(await host.nativeRequest("codex", "read")).toBeNull();
    await expect(host.nativeRequest("codex", "fail")).rejects.toMatchObject({ nativeError: { code: -32601, data: { marker: true } } });
    await host.nativeEvents("codex", 12, 30, "producer-2");
    const query = new URL(requests.at(-1)!.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({ after: "12", limit: "30", epoch: "producer-2" });
  });
});
