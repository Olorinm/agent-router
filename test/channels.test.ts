import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorStore } from "../src/matrix/store.js";
import { CliWork } from "../src/matrix/cli-work.js";
import type { Attachment } from "../src/attachments.js";
import { ChannelRouter } from "../src/channels/router.js";
import { ChannelError, type ChannelEntry, type ChannelMessage } from "../src/channels/types.js";
import { evaluateInvocation } from "../src/channels/policy.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
const entry: ChannelEntry = { id: "mail", agentId: "11111111-1111-4111-8111-111111111111", kind: "agentmail",
  account: "helper@example.test", enabled: true, accessMode: "read-only",
  rules: [{ id: "employees", match: { domains: ["example.test"] }, decision: "allow" }] };
const message = (id: string, subject = "alice@example.test", conversation = "thread-1"): ChannelMessage => ({
  id, subject, subjectDomain: subject.split("@")[1]!, conversation, text: `Question ${id}`,
  authentication: "provider-screened", receivedAt: new Date().toISOString(),
});
function setup(config = entry) {
  const ledger = new ConnectorStore(":memory:", "channels"), tasks = new ConnectorStore(":memory:", "worker");
  cleanup.push(() => ledger.close(), () => tasks.close());
  const work = new CliWork(tasks, () => "ask");
  const adapter = { poll: vi.fn(async () => ({ messages: [], cursor: "", more: false })),
    reply: vi.fn(async (_message: ChannelMessage, _text: string, _id: string, _attachments?: Attachment[]) => "sent-1") };
  const router = new ChannelRouter(ledger, async () => work);
  router.register(structuredClone(config), adapter);
  return { router, ledger, tasks, work, adapter };
}

describe("channel policy and identity", () => {
  it("matches every selector in ordered rules and defaults to confirmation", () => {
    const context = { channelKind: "mail", entryId: "support", visitorId: "v1", subject: "a@example.test",
      domain: "example.test", agentId: entry.agentId, operation: "invoke" as const };
    const rules = [{ id: "blocked", match: { subjects: ["b@example.test"] }, decision: "deny" as const },
      { id: "staff", match: { domains: ["example.test"], agentIds: [entry.agentId], channelKinds: ["mail"], operations: ["invoke" as const] }, decision: "allow" as const }];
    expect(evaluateInvocation(rules, context)).toEqual({ decision: "allow", ruleId: "staff" });
    expect(evaluateInvocation(rules, { ...context, subject: "b@example.test" }).decision).toBe("deny");
    expect(evaluateInvocation(rules, { ...context, channelKind: "im" }).decision).toBe("ask");
    expect(evaluateInvocation(rules, { ...context, domain: "evil-example.test" }).decision).toBe("ask");
  });
  it("queues allowed callers and records unfamiliar and unverified senders without executing them", async () => {
    const { router, work } = setup();
    router.ingest(entry, message("allowed"));
    router.ingest(entry, message("guest", "guest@other.test"));
    router.ingest(entry, { ...message("unverified"), authentication: "unverified" });
    await router.tick("mail");
    expect(work.list()).toHaveLength(1);
    expect(router.events("mail").map(e => e.state)).toEqual(["submitted", "pending", "pending"]);
    expect(router.visitors("mail")).toHaveLength(2);
    expect(work.list()[0]?.from).toMatch(/^visitor:/);
  });
  it("confirms only one immutable request, and a deny rule cannot be bypassed by approval", async () => {
    const { router, work } = setup();
    const first = router.ingest(entry, message("one", "guest@other.test"));
    router.ingest(entry, message("two", "guest@other.test"));
    router.decide("mail", first.id, "allow");
    await router.tick("mail");
    expect(work.list()).toHaveLength(1);
    expect(router.events("mail")[1]?.state).toBe("pending");
    expect(() => router.ingest(entry, { ...first.message, text: "replace approved request" })).toThrow("channel_message_id_reused");
    const blocked = setup({ ...entry, rules: [{ id: "deny-all", match: {}, decision: "deny" }] });
    const event = blocked.router.ingest(entry, message("blocked"));
    blocked.router.decide("mail", event.id, "allow");
    await blocked.router.tick("mail");
    expect(blocked.work.list()).toHaveLength(0);
    expect(blocked.router.events("mail")[0]?.state).toBe("rejected");
  });
  it("keeps explicit per-request confirmation even for a previously allowed visitor", async () => {
    const { router, work } = setup({ ...entry, rules: [{ id: "confirm", match: {}, decision: "ask" }] });
    const event = router.ingest(entry, message("one"));
    router.decideVisitor("mail", event.visitorId, "allow");
    await router.tick("mail"); expect(work.list()).toHaveLength(0);
    router.decide("mail", event.id, "allow");
    await router.tick("mail"); expect(work.list()).toHaveLength(1);
  });
  it("separates people, entries and conversations while retaining a person's own follow-ups", () => {
    const { router } = setup();
    const a = router.ingest(entry, message("a")), next = router.ingest(entry, message("next"));
    const b = router.ingest(entry, message("b", "bob@example.test"));
    const different = { ...entry, id: "im", kind: "matrix" };
    const im = router.ingest(different, message("im"));
    expect(next.contextId).toBe(a.contextId);
    expect(b.contextId).not.toBe(a.contextId); expect(im.contextId).not.toBe(a.contextId);
    expect(im.visitorId).not.toBe(a.visitorId);
  });
  it("rejects cross-entry decisions, binding changes, and duplicate registration", () => {
    const { router, ledger, work, adapter } = setup();
    const event = router.ingest(entry, message("a"));
    expect(() => router.decide("other", event.id, "allow")).toThrow("channel_event_not_found");
    expect(() => router.ownedEntry("mail", "other-agent")).toThrow("channel_not_found");
    expect(() => router.register(entry, adapter)).toThrow("channel_entry_duplicate");
    const restarted = new ChannelRouter(ledger, async () => work);
    expect(() => restarted.register({ ...entry, account: "different@example.test" }, adapter)).toThrow("channel_binding_changed_use_new_entry");
  });
});

describe("channel execution and reliable replies", () => {
  it('retains the email event while deferred and delivers only the eventual result', async () => {
    const { router, work, adapter } = setup();
    const original = router.ingest(entry, { ...message('async'), documents: [{ name: 'story.txt', text: '完整故事'.repeat(10000) }] });
    await router.tick('mail'); const claim = work.claim('worker')!;
    expect(claim.documents?.[0]?.text.length).toBe(40000);
    work.update(claim.claimId!, 'defer', 'Waiting for video'); await router.tick('mail');
    expect(adapter.reply).not.toHaveBeenCalled();
    expect(router.events('mail')[0]?.state).toBe('submitted');
    router.ingest(entry, message('other', 'bob@example.test')); await router.tick('mail');
    expect(work.claim('worker')?.id).not.toBe(claim.id);
    work.update(claim.claimId!, 'reply', 'Video link'); await router.tick('mail');
    expect(adapter.reply).toHaveBeenCalledWith(original.message, 'Video link', `router-${original.id}`);
  });
  it("snapshots binary replies and retries identical attachments after router restart", async () => {
    const { router, ledger, work, adapter } = setup();
    router.ingest(entry, message("picture")); await router.tick("mail");
    const claim = work.claim("worker")!;
    const files = [{ filename: "mockup.png", contentType: "image/png", content: Buffer.alloc(1_660_000, 42).toString("base64") }];
    const result = work.update(claim.claimId!, "reply", "Attached", undefined, "worker", files);
    expect(work.update(claim.claimId!, "reply", "Attached", undefined, "worker", files)).toEqual(result);
    expect(JSON.stringify(result).length).toBeLessThan(44000);
    adapter.reply.mockRejectedValueOnce(new ChannelError("network"));
    await router.tick("mail");
    expect(router.events("mail")[0]?.state).toBe("delivering");
    expect(JSON.stringify(router.events("mail")).length).toBeLessThan(44000);
    const restarted = new ChannelRouter(ledger, async () => work); restarted.register(entry, adapter);
    await restarted.tick("mail");
    expect(adapter.reply.mock.calls[0]?.[3]).toEqual(files);
    expect(adapter.reply.mock.calls[1]).toEqual(adapter.reply.mock.calls[0]);
    expect(router.events("mail")[0]?.state).toBe("replied");
  });
  it("executes through the existing worker contract and sends the result to the original message", async () => {
    const { router, work, adapter } = setup();
    const original = router.ingest(entry, message("one"));
    await router.tick("mail");
    const claimed = work.claim("worker", undefined, true)!;
    expect(claimed.contextId).toBe(original.contextId);
    expect(claimed.execution).toEqual({ accessMode: "read-only" });
    work.update(claimed.claimId!, "reply", "Answer", undefined, "worker");
    await router.tick("mail");
    expect(adapter.reply).toHaveBeenCalledWith(original.message, "Answer", `router-${original.id}`);
    expect(router.events("mail")[0]?.state).toBe("replied");
    router.ingest(entry, original.message); await router.tick("mail");
    expect(adapter.reply).toHaveBeenCalledTimes(1);
  });
  it("serializes follow-ups and reuses the context with a new task after completion", async () => {
    const { router, work } = setup();
    router.ingest(entry, message("one")); router.ingest(entry, message("two"));
    await router.tick("mail"); expect(work.list()).toHaveLength(1);
    const first = work.claim("worker", undefined, true)!;
    work.update(first.claimId!, "reply", "first result");
    await router.tick("mail"); await router.tick("mail");
    const next = work.claim("worker", undefined, true)!;
    expect(next.id).not.toBe(first.id); expect(next.contextId).toBe(first.contextId);
  });
  it("continues the same task when the Agent requests additional input", async () => {
    const { router, work } = setup();
    router.ingest(entry, message("one")); await router.tick("mail");
    const first = work.claim("worker", undefined, true)!;
    work.update(first.claimId!, "need-input", "Which repository?"); await router.tick("mail");
    router.ingest(entry, message("two")); await router.tick("mail");
    const next = work.claim("worker", undefined, true)!;
    expect(next.id).toBe(first.id); expect(next.contextId).toBe(first.contextId);
  });
  it("recovers a lost task submission receipt without a second task", async () => {
    const { router, ledger, work, adapter } = setup();
    router.ingest(entry, message("one"));
    const original = work.send.bind(work); let lost = true;
    vi.spyOn(work, "send").mockImplementation(async (...args) => {
      const result = await original(...args); if (lost) { lost = false; throw new Error("lost receipt"); } return result;
    });
    await router.tick("mail"); expect(work.list()).toHaveLength(1);
    const restarted = new ChannelRouter(ledger, async () => work); restarted.register(entry, adapter);
    await restarted.tick("mail"); expect(work.list()).toHaveLength(1);
    expect(restarted.events("mail")[0]?.taskId).toBe(work.list()[0]?.id);
  });
  it("retries uncertain delivery with the same content and key after restart", async () => {
    const { router, ledger, work, adapter } = setup();
    router.ingest(entry, message("one")); await router.tick("mail");
    const claim = work.claim("worker")!; work.update(claim.claimId!, "reply", "Exactly this answer");
    adapter.reply.mockRejectedValueOnce(new ChannelError("network"));
    await router.tick("mail");
    const restarted = new ChannelRouter(ledger, async () => work); restarted.register(entry, adapter);
    await restarted.tick("mail");
    expect(adapter.reply.mock.calls[1]).toEqual(adapter.reply.mock.calls[0]);
    expect(work.list(true)).toHaveLength(1);
  });
  it("halts on provider permission errors without repeated requests or leaking error contents", async () => {
    const { router, adapter } = setup();
    adapter.poll.mockRejectedValue(new ChannelError("agentmail_http_403", true));
    await router.tick("mail"); await router.tick("mail");
    expect(adapter.poll).toHaveBeenCalledTimes(1);
    expect(router.entries(entry.agentId)[0]?.halted).toBe(true);
    router.resume("mail"); await router.tick("mail"); expect(adapter.poll).toHaveBeenCalledTimes(2);
  });
  it("revokes a visitor during execution and withholds the result", async () => {
    const { router, work, adapter } = setup();
    const event = router.ingest(entry, message("one")); await router.tick("mail");
    const claim = work.claim("worker")!;
    router.decideVisitor("mail", event.visitorId, "deny"); await router.tick("mail");
    expect(work.inspect(claim.id).cancelRequested).toBe(true);
    expect(() => work.update(claim.claimId!, "reply", "secret")).toThrow();
    expect(adapter.reply).not.toHaveBeenCalled();
  });
  it("persists a whole page before advancing its cursor and prevents overlapping polls", async () => {
    const { router, ledger, adapter } = setup();
    let resolve!: (value: { messages: ChannelMessage[]; cursor: string; more: boolean }) => void;
    adapter.poll.mockImplementationOnce(() => new Promise(r => { resolve = r; }) as never);
    const first = router.tick("mail"), overlapping = router.tick("mail");
    expect(first).toBe(overlapping);
    resolve({ messages: [message("one"), message("two", "bob@example.test")], cursor: "page-2", more: true });
    await first;
    expect(router.events("mail")).toHaveLength(2);
    expect(ledger.get<{ cursor: string }>("channel_entries", "mail")?.cursor).toBe("page-2");
  });
  it("preserves an owner rejection arriving during a backend request and suppresses delivery", async () => {
    const { router, work, adapter } = setup();
    const event = router.ingest(entry, message("one")); await router.tick("mail");
    const claim = work.claim("worker")!; work.update(claim.claimId!, "reply", "private result");
    const get = work.get.bind(work);
    vi.spyOn(work, "get").mockImplementationOnce(async id => {
      router.decide("mail", event.id, "deny"); return get(id);
    });
    await router.tick("mail");
    expect(router.events("mail")[0]).toMatchObject({ decision: "deny", state: "rejected" });
    expect(adapter.reply).not.toHaveBeenCalled();
  });
  it("still requests cancellation when a provider permission failure halted intake", async () => {
    const { router, work, adapter } = setup();
    const event = router.ingest(entry, message("one")); await router.tick("mail");
    const claim = work.claim("worker")!;
    router.resume("mail"); adapter.poll.mockRejectedValue(new ChannelError("agentmail_http_403", true));
    await router.tick("mail");
    router.decideVisitor("mail", event.visitorId, "deny"); await router.tick("mail");
    expect(work.inspect(claim.id).cancelRequested).toBe(true);
    expect(adapter.poll).toHaveBeenCalledTimes(2);
  });
  it("does not submit a later request rejected while an earlier request is being checked", async () => {
    const { router, work } = setup();
    router.ingest(entry, message("one"));
    const later = router.ingest(entry, message("two", "bob@example.test"));
    const get = work.get.bind(work);
    vi.spyOn(work, "get").mockImplementationOnce(async id => {
      router.decide("mail", later.id, "deny"); return get(id);
    });
    await router.tick("mail");
    expect(work.list()).toHaveLength(1);
    expect(router.events("mail")[1]).toMatchObject({ decision: "deny", state: "rejected" });
  });
});
