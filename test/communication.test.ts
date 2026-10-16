import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { CommunicationCore, type InboxRecord, type OutboxRecord } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork, WorkError } from "../src/execution/work.js";
import { HostWorker } from "../src/execution/host-worker.js";
import type { HostCall, HostPort, HostRun } from "../src/execution/host.js";
import type { HostTools } from "../src/execution/tools.js";
import { digest, key } from "../src/execution/protocol.js";
import { ChannelSendError, sendChunks, type ChannelAdapter, type ChannelContext, type ChannelKind, type ChannelMessage, type ReplyRoute } from "../src/communication/types.js";
import { ChannelHttpError } from "../src/channels/http.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class Adapter implements ChannelAdapter {
  context!: ChannelContext;
  sent: Array<{ route: ReplyRoute; text: string; key: string }> = [];
  error: Error | undefined;
  constructor(readonly kind: ChannelKind, readonly retrySafe = false) {}
  async start(context: ChannelContext) { this.context = context; }
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
  error: Error | undefined;
  pending: HostCall[] = [];
  resolved: unknown[] = [];
  defaultStatus: HostRun["status"] = "completed";
  answer = "回答";
  async connect() {}
  async start(input: Parameters<HostPort["start"]>[0]): Promise<HostRun> {
    this.starts.push(input);
    const run: HostRun = { id: `run-${this.starts.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId,
      status: this.defaultStatus, answer: this.answer };
    this.runs.set(run.id, run); if (this.error) throw this.error; return run;
  }
  async get(id: string) { const run = this.runs.get(id); if (!run) throw new Error("not_found"); return run; }
  async cancel(id: string) { (await this.get(id)).status = "cancelled"; }
  async calls() { return this.pending; }
  async resolve(id: string, callId: string, result: unknown) { this.resolved.push({ id, callId, result }); }
}
function harness(path = ":memory:") {
  const store = new DurableStore(path, "agent"); cleanup.push(() => store.close());
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("agent", store, work);
  const feishu = new Adapter("feishu"), telegram = new Adapter("telegram"), matrix = new Adapter("matrix", true);
  for (const [id, adapter] of [["feishu", feishu], ["telegram", telegram], ["matrix", matrix]] as const)
    core.register({ id, ownerAddresses: [`owner-${id}`], peerAddresses: ["peer"], groupIds: ["group"] }, adapter);
  const host = new Host();
  const worker = (tools?: HostTools) => new HostWorker("agent", "instance", store, work, host, "fixture", "instructions", () => {}, (id, text) => core.saveResult(id, text), tools);
  return { store, work, core, feishu, telegram, matrix, host, worker };
}
function message(id: string, sender = "owner-feishu", overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return { externalId: id, sender, scope: "direct", threadId: "chat", text: `input-${id}`,
    reply: { target: `chat-${id}`, messageId: id, data: {} }, ...overrides };
}
async function complete(h: ReturnType<typeof harness>) { await h.core.dispatch(); await h.worker().tick(); await h.core.dispatch(); await h.core.flush(); }

describe("communication receipt and routing", () => {
  it("delivers provider IDs for history lookup without including raw credentials or reply data", async () => {
    const h = harness(); await h.core.start();
    const incoming = message("om_current", "owner-feishu", { scope: "group", groupId: "group",
      quoted: { messageId: "om_parent", text: "earlier discussion" },
      reply: { target: "oc_chat", messageId: "om_current", data: { token: "PRIVATE_REPLY_TOKEN" } },
      native: { secret: "PRIVATE_NATIVE_VALUE" } });
    h.core.receive("feishu", incoming); await complete(h);
    const claim = h.work.list(true)[0]!;
    const context = 'Channel context (provider routing IDs): ';
    const part = claim.input.parts!.find((part: any) => part.text?.startsWith(context)) as any;
    expect(JSON.parse(part.text.slice(context.length))).toEqual({ channel: "feishu", connectionId: "feishu", scope: "group",
      conversationId: "oc_chat", messageId: "om_current", senderId: "owner-feishu", quotedMessageId: "om_parent" });
    expect(h.host.starts[0]!.input).toContain('"conversationId":"oc_chat"');
    expect(h.host.starts[0]!.input).toContain("earlier discussion");
    expect(h.host.starts[0]!.input).not.toContain("PRIVATE_");
    expect(claim.contextId).not.toBe("oc_chat");
  });
  it.each(["feishu", "telegram", "matrix"] as const)("records %s reactions without starting work or sending a receipt", async (channel) => {
    const h = harness(); await h.core.start();
    for (const scope of ["direct", "group"] as const) for (const action of ["added", "removed"]) {
      const input = message(`${scope}-${action}`, `owner-${channel}`, { scope, groupId: "group", text: "",
        event: { type: "reaction", data: { messageId: "original", emoji: "Yes", action } } });
      h.core.receive(channel, input); h.core.receive(channel, input);
    }
    await complete(h); await complete(h);
    expect(h.work.list(true)).toHaveLength(0); expect(h.host.starts).toHaveLength(0);
    expect(h.core.status().outbox).toHaveLength(0);
    expect(h.core.status().inbox).toHaveLength(4);
    expect(h.core.status().inbox.every((item) => item.state === "done" && item.taskId === null && item.reason === "reaction_recorded_without_execution")).toBe(true);
    expect(h.store.entries<InboxRecord>("communication_inbox").map(({ value }) => value.source.event!.data.action)).toEqual(["added", "removed", "added", "removed"]);
    h.core.receive(channel, message("next", `owner-${channel}`)); await complete(h);
    expect(h.host.starts).toHaveLength(1); expect(h[channel].sent).toHaveLength(1);
  });
  it("records Matrix redactions without executing their reason as a request", async () => {
    const h = harness(); await h.core.start();
    h.core.receive("matrix", message("redaction", "owner-matrix", { text: "removed message", event: { type: "message-redaction", data: { redacts: "original" } } }));
    await complete(h);
    expect(h.work.list(true)).toHaveLength(0); expect(h.core.status().outbox).toHaveLength(0);
    expect(h.core.status().inbox[0]).toMatchObject({ state: "done", reason: "message-redaction_recorded_without_execution" });
  });
  it.each(["comment", "card-action", "callback", "native-message"])("still dispatches intentional %s inputs", async (type) => {
    const h = harness(); await h.core.start();
    h.core.receive("feishu", message("interaction", "owner-feishu", { text: "", event: { type, data: { value: "request" } } }));
    await complete(h);
    expect(h.host.starts).toHaveLength(1); expect(h.host.starts[0]!.input).toContain(type);
  });
  it("shares an owner's private conversation across channels and freezes each reply route", async () => {
    const h = harness(); await h.core.start();
    const first = h.core.receive("feishu", message("one"));
    const second = h.core.receive("telegram", message("two", "owner-telegram"));
    expect(second.conversationId).toBe(first.conversationId);
    await complete(h); await complete(h);
    expect(h.host.starts).toHaveLength(2);
    expect(h.host.starts[1]!.sessionId).toBe(h.host.starts[0]!.sessionId);
    expect(h.feishu.sent[0]!.route.target).toBe("chat-one");
    expect(h.telegram.sent[0]!.route.target).toBe("chat-two");
    expect(h.core.status().outbox.every((out) => out.state === "accepted")).toBe(true);
  });
  it("isolates groups and peers from the owner's main conversation, ignores unlinked senders", () => {
    const { core } = harness();
    const owner = core.receive("feishu", message("owner"));
    const peer = core.receive("feishu", message("peer", "peer"));
    const group = core.receive("feishu", message("group", "owner-feishu", { scope: "group", groupId: "group" }));
    expect(new Set([owner.conversationId, peer.conversationId, group.conversationId]).size).toBe(3);
    expect(core.receive("feishu", message("unknown", "stranger")).state).toBe("ignored");
    expect(core.receive("feishu", message("other-group", "owner-feishu", { scope: "group", groupId: "other" })).state).toBe("ignored");
  });
  it("deduplicates provider IDs durably and rejects a changed payload", async () => {
    const h = harness(); const input = message("one");
    expect(h.core.receive("feishu", input).id).toBe(h.core.receive("feishu", input).id);
    expect(() => h.core.receive("feishu", { ...input, text: "changed" })).toThrow("different_payload");
    await h.core.dispatch(); await h.core.dispatch(); expect(h.work.list()).toHaveLength(1);
  });
  it("rolls back a receipt with the enclosing provider transaction", () => {
    const h = harness();
    expect(() => h.store.transaction(() => { h.core.receive("feishu", message("one")); throw new Error("crash"); })).toThrow("crash");
    expect(h.core.status().inbox).toHaveLength(0);
    expect(h.core.receive("feishu", message("one")).state).toBe("received");
  });
  it("acknowledges oversized multibyte input without poisoning the work queue", async () => {
    const h = harness();
    expect(h.core.receive("feishu", message("large", "owner-feishu", { text: "中".repeat(9000) }))).toMatchObject({ state: "ignored", reason: "input_too_large" });
    h.core.receive("feishu", message("next")); await h.core.dispatch(); expect(h.work.list()).toHaveLength(1);
    expect(h.core.status().outbox[0]!.taskId).toBeNull();
  });
  it("serializes one conversation even when another instance polls it", async () => {
    const h = harness(); h.core.receive("feishu", message("one")); h.core.receive("telegram", message("two", "owner-telegram"));
    await h.core.dispatch(); expect(h.work.claim("one", undefined, true)).not.toBeNull();
    expect(h.work.claim("two", undefined, true)).toBeNull();
  });
  it("leaves tasks with execution overrides for the existing external worker", async () => {
    const h = harness();
    const task = await h.work.send(SendMessageRequest.fromJSON({ message: {
      messageId: "agentmail-read-only", role: "ROLE_USER", parts: [{ text: "mail input" }],
    } }), { sender: "mail-peer", room: "mail-thread", approved: true, execution: { accessMode: "read-only" } });
    h.core.receive("feishu", message("personal")); await complete(h);
    expect(h.host.starts).toHaveLength(1); expect(h.host.starts[0]!.input).toContain("input-personal");
    expect(h.work.inspect(task.id)).toMatchObject({ status: "submitted", claimId: null, execution: { accessMode: "read-only" } });
    expect(h.work.claim("external-worker")).toMatchObject({ id: task.id, execution: { accessMode: "read-only" } });
  });
  it("does not execute an incompatible task already owned by the Host instance", async () => {
    const h = harness();
    const task = await h.work.send(SendMessageRequest.fromJSON({ message: {
      messageId: "owned-read-only", role: "ROLE_USER", parts: [{ text: "mail input" }],
    } }), { sender: "mail-peer", room: "mail-thread", approved: true, execution: { accessMode: "read-only" } });
    expect(h.work.claim("instance")).toMatchObject({ id: task.id });
    await h.worker().tick(); expect(h.host.starts).toHaveLength(0);
  });
  it("retries idempotent delivery with the same key without executing again", async () => {
    const h = harness(); await h.core.start(); h.core.receive("matrix", message("one", "owner-matrix"));
    h.matrix.error = new Error("network_failed"); await complete(h);
    expect(h.core.status().outbox[0]!.state).toBe("queued"); h.matrix.error = undefined;
    await h.core.flush(Date.now() + 100_000);
    expect(h.matrix.sent).toHaveLength(2); expect(h.matrix.sent[0]!.key).toBe(h.matrix.sent[1]!.key);
    expect(h.host.starts).toHaveLength(1);
  });
  it("holds unknown delivery on non-idempotent channels, but retries explicit rate limits", async () => {
    const h = harness(); await h.core.start(); h.core.receive("feishu", message("one"));
    h.feishu.error = new Error("response_lost"); await complete(h); await h.core.flush(Date.now() + 100_000);
    expect(h.feishu.sent).toHaveLength(1); expect(h.core.status().outbox[0]!.state).toBe("uncertain");
    h.core.receive("telegram", message("two", "owner-telegram"));
    h.telegram.error = new ChannelSendError("retry", "rate_limited", 5000); await complete(h);
    h.telegram.error = undefined; await h.core.flush(Date.now() + 100_000);
    expect(h.telegram.sent).toHaveLength(2);
  });
  it("recovers an interrupted outbox according to provider idempotency", () => {
    const h = harness();
    const row: OutboxRecord = { id: "out", taskId: "task", route: { connectionId: "feishu", target: "chat", messageId: "one", data: {} },
      text: "answer", state: "submitting", attempts: 1, nextAt: 0 };
    h.store.set("communication_outbox", row.id, row);
    const recovered = new CommunicationCore("agent", h.store, h.work);
    recovered.register({ id: "feishu", ownerAddresses: ["owner-feishu"] }, h.feishu);
    expect(h.store.get<OutboxRecord>("communication_outbox", "out")!.state).toBe("uncertain");
    h.store.set("communication_outbox", "out2", { ...row, id: "out2", route: { ...row.route, connectionId: "matrix" } });
    recovered.register({ id: "matrix", ownerAddresses: ["owner-matrix"] }, h.matrix);
    expect(h.store.get<OutboxRecord>("communication_outbox", "out2")!.state).toBe("queued");
  });
  it("resumes acknowledged chunks without resending them", async () => {
    const h = harness(), context = h.core.context("telegram"), sent: string[] = [];
    let limited = true;
    const send = async (text: string, index: number) => { if (index === 1 && limited) throw new ChannelSendError("retry", "rate_limited"); sent.push(text); return `id-${index}`; };
    await expect(sendChunks(context, "key", "abcdefgh", 4, send)).rejects.toThrow("rate_limited");
    limited = false; expect(await sendChunks(context, "key", "abcdefgh", 4, send)).toEqual({ externalId: "id-0,id-1" });
    expect(sent).toEqual(["abcd", "efgh"]);
  });
  it("does not resubmit a chunk after an ambiguous response", async () => {
    const h = harness(), context = h.core.context("telegram"); let attempts = 0;
    const send = async () => { attempts++; throw new ChannelSendError("uncertain", "lost_response"); };
    await expect(sendChunks(context, "key", "text", 4, send)).rejects.toThrow("lost_response");
    await expect(sendChunks(context, "key", "text", 4, send)).rejects.toThrow("chunk_acceptance_unknown"); expect(attempts).toBe(1);
  });
});

describe("Host product tool execution", () => {
  function fixture() {
    const h = harness(); let executions = 0, fail = false;
    const tools: HostTools = { definitions: [{ name: "feishu_personal", description: "fixture", inputSchema: {}, timeoutMs: 180_000 }], instructions: " personal tools",
      allowed: (conversation, task) => h.core.isOwnerTask(conversation, task),
      execute: async () => { executions++; if (fail) throw new Error("secret transport details"); return { success: true, contentItems: [{ type: "inputText", text: "calendar result" }] }; } };
    const call: HostCall = { id: "call", runId: "run-1", kind: "tool", name: "feishu_personal", input: { args: ["calendar", "+agenda"] }, status: "pending", deadlineAt: "2999-01-01T00:00:00Z" };
    return { ...h, tools, call, executions: () => executions, fail: () => { fail = true; } };
  }
  it("executes an owner's tool and reuses its saved result after a worker restart", async () => {
    const h = fixture(); h.host.defaultStatus = "running"; h.host.pending = [h.call];
    h.core.receive("feishu", message("one")); await h.core.dispatch();
    await h.worker(h.tools).tick(); await h.worker(h.tools).tick();
    expect(h.host.starts[0]!.tools).toEqual(h.tools.definitions);
    expect(h.executions()).toBe(1); expect(h.host.starts).toHaveLength(1);
    expect(h.host.resolved).toHaveLength(2); expect(h.host.resolved[0]).toEqual(h.host.resolved[1]);
    expect(h.worker(h.tools).status().tools[0]!.phase).toBe("completed");
  });
  it("never repeats a write interrupted before its result was persisted", async () => {
    const h = fixture(); h.host.defaultStatus = "running"; h.host.pending = [h.call];
    h.core.receive("feishu", message("one")); await h.core.dispatch();
    h.store.set("communication_tools", key(h.call.runId, h.call.id), { hash: digest({ name: h.call.name, input: h.call.input }), phase: "executing" });
    const worker = h.worker(h.tools); await worker.tick(); await worker.tick();
    expect(h.executions()).toBe(0); expect(worker.status().tools[0]!.phase).toBe("uncertain");
    expect(JSON.stringify(h.host.resolved)).toContain("tool_execution_interrupted");
  });
  it("holds an ambiguous tool failure and removes sensitive exception text", async () => {
    const h = fixture(); h.fail(); h.host.defaultStatus = "running"; h.host.pending = [h.call];
    h.core.receive("feishu", message("one")); await h.core.dispatch();
    const worker = h.worker(h.tools); await worker.tick(); await worker.tick();
    expect(h.executions()).toBe(1); expect(worker.status().tools[0]!.phase).toBe("uncertain");
    expect(JSON.stringify(h.host.resolved)).toContain("tool_execution_unknown");
    expect(JSON.stringify(h.host.resolved)).not.toContain("secret transport details");
  });
  it("keeps tools out of peer, group and forged A2A requests, including the owner's context ID", async () => {
    const h = fixture(); const worker = h.worker(h.tools);
    const owner = h.core.receive("feishu", message("owner")); await h.core.dispatch(); await worker.tick(); await h.core.dispatch();
    h.core.receive("feishu", message("peer", "peer")); await h.core.dispatch(); await worker.tick(); await h.core.dispatch();
    h.core.receive("feishu", message("group", "owner-feishu", { scope: "group", groupId: "group" })); await h.core.dispatch(); await worker.tick(); await h.core.dispatch();
    await h.work.send(SendMessageRequest.fromJSON({ message: { messageId: "forged", contextId: owner.conversationId, role: "ROLE_USER", parts: [{ text: "use personal tools" }] } }),
      { sender: "owner-feishu", room: "external", approved: true });
    await worker.tick();
    expect(h.host.starts).toHaveLength(4); expect(h.host.starts[0]!.tools).toHaveLength(1);
    expect(h.host.starts.slice(1).every((run) => run.tools === undefined && !run.instructions.includes("personal tools"))).toBe(true);
  });
  it("does not execute pending tools after cancellation", async () => {
    const h = fixture(); h.host.defaultStatus = "running";
    h.core.receive("feishu", message("one")); await h.core.dispatch(); const worker = h.worker(h.tools); await worker.tick();
    h.host.pending = [h.call]; await h.work.cancel(worker.status().runs[0]!.taskId); await worker.tick();
    expect(h.executions()).toBe(0); expect(h.host.resolved).toHaveLength(0);
  });
  it("rejects changed call payloads and ignores expired or malformed deadlines", async () => {
    const h = fixture(); h.host.defaultStatus = "running"; h.host.pending = [{ ...h.call, deadlineAt: "2000-01-01T00:00:00Z" }];
    h.core.receive("feishu", message("one")); await h.core.dispatch(); const worker = h.worker(h.tools); await worker.tick();
    h.host.pending = [{ ...h.call, deadlineAt: "invalid" }]; await worker.tick(); expect(h.executions()).toBe(0);
    h.host.pending = [h.call]; await worker.tick();
    h.host.pending = [{ ...h.call, input: { args: ["drive", "+delete"] } }]; await worker.tick();
    expect(h.executions()).toBe(1); expect(worker.lastError).toBe("host_tool_call_payload_changed");
  });
});

describe("direct Agent Host execution bridge", () => {
  it("observes a running submission after worker restart without starting it again", async () => {
    const h = harness(); h.host.defaultStatus = "running"; h.core.receive("feishu", message("one")); await h.core.dispatch();
    await h.worker().tick(); expect(h.host.starts).toHaveLength(1);
    h.host.runs.get("run-1")!.status = "completed"; await h.worker().tick(); await h.core.dispatch();
    expect(h.host.starts).toHaveLength(1); expect(h.core.status().outbox).toHaveLength(1);
  });
  it("keeps native pending-call replies intact and respects instance revocation", async () => {
    const h = harness(); h.host.defaultStatus = "running"; h.core.receive("feishu", message("one")); await h.core.dispatch();
    h.host.pending = [{ id: "call", runId: "run-1", kind: "interaction", name: "native/question", input: { questions: [] }, status: "pending", deadlineAt: "later" }];
    const worker = h.worker(); await worker.tick(); const result = { answers: { question: { answers: ["selected"] } } };
    await worker.resolve("call", result); expect(h.host.resolved[0]).toEqual({ id: "run-1", callId: "call", result });
    const revoked = new HostWorker("agent", "instance", h.store, h.work, h.host, "fixture", "instructions", () => { throw new Error("instance_revoked"); });
    await revoked.tick(); expect(revoked.lastError).toBe("instance_revoked"); expect(h.host.starts).toHaveLength(1);
  });
  it("wakes an unavailable Host only for deliverable work and never submits while it sleeps", async () => {
    const h = harness(); let ready = false, wakes = 0;
    const worker = new HostWorker("agent", "instance", h.store, h.work, h.host, "fixture", "instructions",
      () => { if (!ready) throw new WorkError("environment_sleeping", 409); }, (id, text) => h.core.saveResult(id, text),
      undefined, h.core, () => { wakes++; });
    await worker.tick(); expect(wakes).toBe(0);
    h.core.receive("feishu", message("one")); await h.core.dispatch();
    await worker.tick(); await worker.tick();
    expect(wakes).toBe(2); expect(h.host.starts).toHaveLength(0); expect(worker.lastError).toBe("environment_sleeping");
    ready = true; await worker.tick();
    expect(h.host.starts).toHaveLength(1); expect(wakes).toBe(2);
  });
  it("holds a lost POST response until the owner reconciles the observed run", async () => {
    const h = harness(); h.host.error = new Error("response_lost"); h.core.receive("feishu", message("one")); await h.core.dispatch();
    const worker = h.worker(); await worker.tick(); await worker.tick();
    const claim = worker.status().runs[0]!.claimId; expect(worker.status().runs[0]!.phase).toBe("unknown"); expect(h.host.starts).toHaveLength(1);
    await worker.reconcile(claim, "run-1"); await worker.tick(); await h.core.dispatch();
    expect(h.host.starts).toHaveLength(1); expect((await h.work.get(worker.status().runs[0]!.taskId)).status!.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it("keeps an uncertain conversation blocked while other conversations can reply and reconciliation remains possible", async () => {
    const h = harness(); await h.core.start();
    h.host.error = new Error("response_lost");
    h.core.receive("feishu", message("uncertain", "owner-feishu", { scope: "group", groupId: "group" })); await h.core.dispatch();
    await h.worker().tick();
    const worker = h.worker(); // The same isolation must survive worker restart.
    const original = worker.status().runs[0]!;
    h.host.error = undefined;
    h.core.receive("feishu", message("same-conversation", "owner-feishu", { scope: "group", groupId: "group" }));
    h.core.receive("matrix", message("web-chat", "owner-matrix", { threadId: "web-room" }));
    await h.core.dispatch(); await worker.tick(); await h.core.dispatch(); await h.core.flush();
    expect(h.host.starts).toHaveLength(2);
    expect(h.host.starts[1]!.input).toContain("input-web-chat");
    expect(h.matrix.sent.some(item => item.text === h.host.answer)).toBe(true);
    expect(worker.status().runs.find(run => run.claimId === original.claimId)?.phase).toBe("unknown");
    await worker.tick(); expect(h.host.starts).toHaveLength(2);
    await worker.reconcile(original.claimId, "run-1");
    await worker.tick(); await h.core.dispatch(); await worker.tick(); await h.core.dispatch();
    expect(h.host.starts).toHaveLength(3);
    expect(h.host.starts[2]!.input).toContain("input-same-conversation");
    expect(h.host.starts[2]!.sessionId).toBe(h.host.starts[0]!.sessionId);
    expect(h.host.starts.filter(input => input.input.includes("input-uncertain"))).toHaveLength(1);
  });
  it("never replays a submission interrupted before its run ID was persisted", async () => {
    const h = harness(); h.core.receive("feishu", message("one")); await h.core.dispatch(); const claim = h.work.claim("instance", undefined, true)!;
    h.store.set("communication_runs", claim.claimId!, { claimId: claim.claimId, taskId: claim.id, contextId: claim.contextId,
      sessionId: "lost", input: "one", phase: "submitting" });
    const worker = h.worker(); await worker.tick(); expect(h.host.starts).toHaveLength(0); expect(worker.status().runs[0]!.phase).toBe("unknown");
    await worker.closeUnknown(claim.claimId!); expect(h.work.list()).toHaveLength(0);
  });
  it("closes known rejections even after the work-finalization crash window", async () => {
    const h = harness(); h.core.receive("feishu", message("one")); await h.core.dispatch(); const claim = h.work.claim("instance", undefined, true)!;
    h.store.set("communication_runs", claim.claimId!, { claimId: claim.claimId, taskId: claim.id, contextId: claim.contextId, sessionId: "session", input: "one", phase: "finished" });
    await h.worker().tick(); expect(h.work.list()).toHaveLength(0); expect(h.host.starts).toHaveLength(0);
  });
  it("keeps long Unicode answers complete outside the bounded A2A task projection", async () => {
    const h = harness(); await h.core.start(); h.host.answer = "中文🙂".repeat(15_000); h.core.receive("feishu", message("one")); await complete(h);
    expect(h.feishu.sent[0]!.text).toBe(h.host.answer); expect(h.core.status().outbox[0]!.state).toBe("accepted");
  });
  it("continues the same native session across a SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "router-communication-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "router.sqlite"), first = harness(path);
    first.core.receive("feishu", message("one")); await complete(first); const session = first.host.starts[0]!.sessionId;
    first.store.close(); cleanup.pop(); // The reopened handle owns cleanup from here.
    const second = harness(path); second.core.receive("telegram", message("two", "owner-telegram")); await complete(second);
    expect(second.host.starts[0]!.sessionId).toBe(session);
    expect(second.core.status().inbox).toHaveLength(2);
  });
  it("does not invoke the Host for work canceled before submission", async () => {
    const h = harness(); h.core.receive("feishu", message("one")); await h.core.dispatch(); const claim = h.work.claim("instance", undefined, true)!;
    await h.work.cancel(claim.id); await h.worker().tick(); expect(h.host.starts).toHaveLength(0);
    expect((await h.work.get(claim.id)).status!.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
  it("retains an imported native runtime and session across a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "router-import-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "router.sqlite"), first = harness(path);
    first.core.receive("feishu", message("one")); await first.core.dispatch();
    const contextId = first.work.list()[0]!.contextId;
    const binding = { sessionId: "existing-native-session", runtimeId: "workspace-specific-runtime", tools: false as const };
    first.store.set("execution_sessions", contextId, binding);
    const tools: HostTools = { definitions: [{ name: "channel", description: "channel", inputSchema: {} }], instructions: "extra tools", allowed: () => true, execute: async () => ({ success: true, contentItems: [] }) };
    await first.worker(tools).tick(); await first.core.dispatch();
    expect(first.host.starts[0]).toMatchObject({ sessionId: binding.sessionId, runtimeId: binding.runtimeId, instructions: "instructions" });
    expect(first.host.starts[0]!.tools).toBeUndefined();
    first.store.close(); cleanup.pop();
    const second = harness(path); second.core.receive("telegram", message("two", "owner-telegram")); await second.core.dispatch(); await second.worker(tools).tick();
    expect(second.host.starts[0]).toMatchObject({ sessionId: binding.sessionId, runtimeId: binding.runtimeId });
    expect(second.store.get("execution_sessions", contextId)).toEqual(binding);
  });
  it("treats explicit Host conflicts as rejected, rather than uncertain", async () => {
    const h = harness(); h.host.error = new ChannelHttpError(409, "session_active"); h.core.receive("feishu", message("one")); await h.core.dispatch();
    const worker = h.worker(); await worker.tick(); expect(worker.status().runs[0]!.phase).toBe("finished"); expect(h.work.list()).toHaveLength(0);
  });
  it("cancels a known native run when its Router instance is revoked", async () => {
    const h = harness(); h.host.defaultStatus = "running"; h.core.receive("feishu", message("one")); await h.core.dispatch();
    let revoked = false;
    const worker = new HostWorker("agent", "instance", h.store, h.work, h.host, "fixture", "instructions", () => { if (revoked) throw new WorkError("instance_unauthorized", 401); });
    await worker.tick(); const run = worker.status().runs[0]!; await h.work.cancel(run.taskId); revoked = true; await worker.tick();
    expect(h.host.runs.get("run-1")!.status).toBe("cancelled"); expect((await h.work.get(run.taskId)).status!.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(h.host.starts).toHaveLength(1);
  });
});

describe("public run observation", () => {
  it("preserves native events, cursor gaps, calls and routing identity across observer recreation", async () => {
    const { RunObservation } = await import("../src/execution/observation.js");
    const h = harness(); await h.core.start(); h.host.defaultStatus = "running";
    h.core.receive("matrix", message("matrix-message", "owner-matrix", { reply: { target: "room", messageId: "matrix-message", data: { privateToken: "not-public" } } }));
    await h.core.dispatch(); await h.worker().tick();
    const observation = () => new RunObservation(h.store, h.work, h.host);
    const task = observation().tasks({ connectionId: "matrix", target: "room" }).data[0]!;
    expect(task.source).toEqual({ connectionId: "matrix", target: "room", messageId: "matrix-message", sender: "owner-matrix", scope: "direct" });
    expect(JSON.stringify(task)).not.toContain("not-public");
    expect(observation().tasks({ target: "another-room" }).data).toEqual([]);
    const claim = task.runs[0]!.claimId;
    const native = { type: "native.tool", runId: "run-1", phase: "finished", callId: "command-1", native: { command: "pwd", aggregatedOutput: "/workspace", exitCode: 0 } };
    (h.host as HostPort).events = async (_id, after, limit) => {
      expect(after).toBe(4); expect(limit).toBe(1);
      return { events: [{ sequence: 10, event: native }], cursor: 10, hasMore: true, historyTruncated: true };
    };
    expect(await observation().events(claim, 4, 1)).toEqual({ events: [{ sequence: 10, event: native }], cursor: 10, hasMore: true, historyTruncated: true });
    h.host.pending = [{ id: "approval", runId: "run-1", kind: "interaction", name: "item/commandExecution/requestApproval", input: { command: "pwd" }, status: "pending", deadlineAt: new Date(Date.now() + 60000).toISOString() }];
    expect((await observation().run(claim)).calls).toEqual(h.host.pending);
    await observation().resolve(claim, "approval", { decision: "accept" });
    expect(h.host.resolved).toEqual([{ id: "run-1", callId: "approval", result: { decision: "accept" } }]);
    await expect(observation().resolve(claim, "foreign-call", {})).rejects.toThrow("interaction_not_found");
    await observation().cancel(task.id); expect(h.work.inspect(task.id).cancelRequested).toBe(true);
    await h.core.dispatch(); await h.core.flush();
    const cancellation = h.matrix.sent.find((item) => item.text.includes("Cancellation requested"))!;
    expect(cancellation).toBeDefined();
    expect(observation().tasks().data[0]!.replyMessageIds).toContain(`accepted-${cancellation.key}`);
    await h.worker().tick(); expect((await observation().run(claim)).run.status).toBe("cancelled");
  });
  it("rejects mismatched Host scope and paginates tasks without exposing another target", async () => {
    const { RunObservation } = await import("../src/execution/observation.js");
    const h = harness(); await h.core.start();
    h.core.receive("matrix", message("one", "owner-matrix")); await complete(h);
    h.core.receive("matrix", message("two", "owner-matrix")); await complete(h);
    const observation = new RunObservation(h.store, h.work, h.host);
    const first = observation.tasks({ limit: 1 }); expect(first.next).toBe(first.data[0]!.id);
    const second = observation.tasks({ limit: 1, before: first.next! });
    expect(second.data[0]!.source.messageId).toBe("one"); expect(second.next).toBeNull();
    const claim = first.data[0]!.runs[0]!.claimId;
    h.host.runs.get("run-2")!.sessionId = "other-session";
    await expect(observation.run(claim)).rejects.toThrow("host_run_scope_mismatch");
    await expect(observation.events("foreign-claim")).rejects.toThrow("run_not_found");
  });
});
