import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableStore } from "../src/communication/store.js";
import { CommunicationCore } from "../src/communication/core.js";
import type { ChannelMessage } from "../src/communication/types.js";
import { CliWork } from "../src/execution/work.js";
import { HostWorker } from "../src/execution/host-worker.js";
import { WorkSessions } from "../src/execution/sessions.js";
import type { HostPort, HostRun, HostStartInput, NativeSessionInput } from "../src/execution/host.js";
import { AgentLedger } from "../src/ledger/ledger.js";

const stores: DurableStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));

function setup(authoritative = false) {
  const store = new DurableStore(":memory:", "agent"); stores.push(store);
  const ledger = AgentLedger.open(store); ledger.authoritative = authoritative;
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("agent", store, work);
  const starts: HostStartInput[] = [], runs = new Map<string, HostRun>(), transcripts = new Map<string, string[]>();
  const fork = vi.fn(async (input: NativeSessionInput) => {
    expect(input.action).toBe("fork");
    transcripts.set(input.targetSessionId!, [...transcripts.get(input.sessionId!)!]);
    return { sessionId: input.targetSessionId, nativeSessionId: "native-branch" };
  });
  const host: HostPort = { connect: async () => {}, nativeSessions: fork,
    start: async input => {
      starts.push(input); transcripts.set(input.sessionId, [...(transcripts.get(input.sessionId) ?? []), input.input]);
      const run: HostRun = { id: `run-${starts.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "completed", answer: "done" };
      runs.set(run.id, run); return run;
    }, get: async id => runs.get(id)!, cancel: async () => {}, calls: async () => [], resolve: async () => {} };
  const worker = new HostWorker("agent", "worker", store, work, host, "codex", "", () => {}, (id, text) => core.saveResult(id, text), undefined, core);
  const sessions = new WorkSessions("agent", "owner", "codex", "worker", store, work, host, core);
  worker.prepareSession = (id, task) => sessions.prepareChannelSession(id, task);
  core.register({ id: "chat", ownerAddresses: ["owner"] }, { kind: "fixture", retrySafe: true, groupPolicy: () => "open",
    start: async () => {}, stop: async () => {}, send: async () => ({ externalId: "sent" }) });
  const receive = (id: string, text: string, topic?: string, extra: Partial<ChannelMessage> = {}) => core.receive("chat", {
    externalId: id, sender: "member", scope: "group", groupId: "group", threadId: topic ? `group:${topic}` : "group",
    ...(topic ? { forkFromThreadId: "group" } : {}), text, reply: { target: "group", messageId: id, data: {} }, ...extra,
  });
  const tick = async () => { await core.dispatch(); await worker.tick(); await core.dispatch(); };
  return { store, ledger, core, work, worker, sessions, starts, transcripts, fork, receive, tick };
}

describe("provider topic native forks", () => {
  it.each([false, true])("forks once, inherits hidden group context and continues independently (ledger=%s)", async authoritative => {
    const h = setup(authoritative); const main = h.receive("main", "group context"); await h.tick();
    await h.sessions.submit({ eventId: "background", sessionId: main.conversationId, input: "private background delivered to this group",
      admission: { kind: "owner", owner: "owner", agentId: "agent", reference: "background" } });
    await h.worker.tick();
    const first = h.receive("topic-1", "topic question", "topic"); await h.tick();
    expect(h.fork).toHaveBeenCalledTimes(1);
    const source = h.starts[0]!.sessionId, target = h.starts[2]!.sessionId;
    expect(target).not.toBe(source);
    expect(h.transcripts.get(target)).toEqual([...h.transcripts.get(source)!, h.starts[2]!.input]);
    expect(h.sessions.getSession(first.conversationId)).toMatchObject({ parentSessionId: main.conversationId, ownerConversation: false });
    expect(h.starts[2]!.admission).toBeUndefined();
    h.receive("main-later", "only main learns this"); await h.tick();
    h.receive("topic-2", "topic follow-up", "topic"); await h.tick();
    expect(h.fork).toHaveBeenCalledTimes(1);
    expect(h.starts.at(-1)!.sessionId).toBe(target);
    expect(h.transcripts.get(target)!.join("\n")).not.toContain("only main learns this");
    h.receive("other-topic", "other topic", "another"); await h.tick();
    expect(h.fork).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary quote replies in the group session and never forks from a quote alone", async () => {
    const h = setup(); const main = h.receive("main", "group context"); await h.tick();
    const reply = h.receive("reply", "normal reply", undefined, { quoted: { messageId: "main" } }); await h.tick();
    expect(reply.conversationId).toBe(main.conversationId);
    expect(h.starts[1]!.sessionId).toBe(h.starts[0]!.sessionId);
    expect(h.fork).not.toHaveBeenCalled();
  });

  it("does not fork another group or owner private context", async () => {
    const h = setup(); h.receive("main", "group context"); await h.tick();
    const foreign = h.receive("foreign", "question", "topic", { groupId: "other-group" });
    expect(foreign.forkFromContextId).toBeUndefined();
    const direct = h.receive("dm", "private", "topic", { scope: "direct", sender: "owner" });
    expect(direct.forkFromContextId).toBeUndefined();
    await h.tick(); expect(h.fork).not.toHaveBeenCalled();
  });

  it("starts a first-ever group topic normally when no parent native conversation exists", async () => {
    const h = setup(); h.receive("topic-first", "hello", "topic"); await h.tick();
    expect(h.starts).toHaveLength(1); expect(h.fork).not.toHaveBeenCalled();
  });

  it("fails closed after an uncertain fork, including later messages, without creating empty or duplicate sessions", async () => {
    const h = setup(); h.receive("main", "group context"); await h.tick();
    h.fork.mockRejectedValue(new Error("response_lost"));
    const topic = h.receive("topic", "question", "topic"); await h.tick();
    expect(h.starts).toHaveLength(1);
    expect(h.store.get("execution_sessions", topic.conversationId)).toBeUndefined();
    expect(h.store.get("channel_session_forks", topic.conversationId)).toMatchObject({ state: "unconfirmed" });
    expect(h.work.list(true).filter(t => t.contextId === topic.conversationId)).toMatchObject([{ status: "failed" }]);
    h.receive("topic-again", "follow-up", "topic"); await h.tick();
    expect(h.starts).toHaveLength(1); expect(h.fork).toHaveBeenCalledTimes(1);
  });

  it("resumes a committed fork after restart bookkeeping was interrupted", async () => {
    const h = setup(); h.receive("main", "context"); await h.tick();
    const topic = h.receive("topic", "question", "topic"); await h.tick();
    h.store.set("channel_session_forks", topic.conversationId, { state: "submitting" });
    h.receive("topic-next", "follow-up", "topic"); await h.tick();
    expect(h.fork).toHaveBeenCalledTimes(1); expect(h.starts[2]!.sessionId).toBe(h.starts[1]!.sessionId);
  });

  it("forks the group's current reset window and keeps a topic reset empty", async () => {
    const h = setup(true); const main = h.receive("main", "old context"); await h.tick();
    h.ledger.reset(main.conversationId);
    h.receive("after-reset", "new context"); await h.tick();
    const topic = h.receive("topic", "question", "topic"); await h.tick();
    expect(topic.forkFromContextId).toBe(h.ledger.contextFor(main.conversationId));
    expect(h.fork.mock.calls[0]![0].sessionId).toBe(h.starts[1]!.sessionId);
    expect(h.transcripts.get(h.starts[2]!.sessionId)!.join("\n")).not.toContain("old context");
    h.ledger.reset(topic.conversationId);
    h.receive("topic-reset", "start over", "topic"); await h.tick();
    expect(h.fork).toHaveBeenCalledTimes(1);
    expect(h.transcripts.get(h.starts[3]!.sessionId)).toEqual([h.starts[3]!.input]);
  });

  it("serializes sibling topic forks through the Host's source management lock", async () => {
    const h = setup(); h.receive("main", "context"); await h.tick();
    let busy = false;
    const original = h.fork.getMockImplementation()!;
    h.fork.mockImplementation(async input => {
      if (busy) throw new Error("session_busy");
      busy = true;
      try { await new Promise<void>(resolve => setImmediate(resolve)); return await original(input); }
      finally { busy = false; }
    });
    h.receive("one", "first", "one"); h.receive("two", "second", "two");
    for (let i = 0; i < 10 && h.starts.length < 3; i++) await h.tick();
    expect(h.starts).toHaveLength(3); expect(h.fork).toHaveBeenCalledTimes(2);
  });
});
