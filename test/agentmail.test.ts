import { describe, expect, it, vi } from "vitest";
import { AgentMailAdapter, mailbox } from "../src/channels/agentmail.js";

const inbox = "helper@example.test", createdAt = "2026-09-18T01:00:00.000Z", start = "2026-09-18T00:00:00.000Z";
const mail = (extra: Record<string, unknown> = {}) => ({ inbox_id: inbox, message_id: "<one@test>", thread_id: "thread-1",
  from: "Alice <alice@example.test>", labels: ["received", "unread"], to: [inbox], created_at: createdAt,
  text: "Old quoted text", extracted_text: "Only the new question", authentication_results: { dmarc: "pass", spf: "pass" },
  headers: {}, ...extra });
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function setup(items: ReturnType<typeof mail>[], next: string | undefined = undefined) {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const value = String(url);
    if (value.includes("messages?")) return json({ messages: items, next_page_token: next });
    if (value.endsWith("/reply")) return json({ message_id: "sent", thread_id: "thread-1" });
    return json(items.find(item => value.endsWith(encodeURIComponent(item.message_id))));
  });
  const adapter = new AgentMailAdapter({ inbox, apiKey: "test-token", fetch: fetcher });
  return { adapter, fetcher };
}
describe("AgentMail adapter", () => {
  it("canonicalizes a single mailbox without trusting its display name", () => {
    expect(mailbox('"Alice" <ALICE@example.test>')).toBe("alice@example.test");
    expect(mailbox("alice@example.test, evil@other.test")).toBeUndefined();
    expect(mailbox("Alice <alice@example.test> <evil@other.test>")).toBeUndefined();
    expect(mailbox("Alice\r\nBcc: evil@other.test <alice@example.test>")).toBeUndefined();
    expect(mailbox("alice@example.test.evil.test")).toBe("alice@example.test.evil.test");
  });
  it("uses the scoped API, extracts fresh text, and trusts only structured receiver authentication", async () => {
    const { adapter, fetcher } = setup([mail()]);
    const result = await adapter.poll(undefined, start);
    expect(result.messages[0]).toMatchObject({ subject: "alice@example.test", subjectDomain: "example.test", authentication: "provider-screened" });
    expect(result.messages[0]?.text).toContain("Only the new question");
    expect(result.messages[0]?.text).not.toContain("Old quoted text");
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api.agentmail.to\/v0\/inboxes\/helper%40example.test\/messages/);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
      expect(init?.redirect).toBe("error");
    }
    const unverified = setup([mail({ authentication_results: undefined, headers: { "Authentication-Results": "dmarc=pass" } })]);
    expect((await unverified.adapter.poll(undefined, start)).messages[0]?.authentication).toBe("unverified");
  });
  it.each(["spam", "blocked", "unauthenticated", "trash", "sent", "draft"])("does not execute messages labeled %s", async label => {
    expect((await setup([mail({ labels: ["received", label] })]).adapter.poll(undefined, start)).messages).toEqual([]);
  });
  it("ignores own mail, automatic replies, historical messages and mailing lists", async () => {
    for (const override of [{ from: inbox }, { headers: { "Auto-Submitted": "auto-replied" } },
      { headers: { Precedence: "list" } }, { created_at: "2020-01-01T00:00:00Z" }]) {
      expect((await setup([mail(override)]).adapter.poll(undefined, start)).messages).toEqual([]);
    }
  });
  it("uses provider creation time even if the sender backdates a message", async () => {
    const result = await setup([mail({ timestamp: "2000-01-01T00:00:00Z" })]).adapter.poll(undefined, start);
    expect(result.messages).toHaveLength(1);
  });
  it("supports pagination without truncating a busy mailbox", async () => {
    const { adapter, fetcher } = setup([mail()], "page-2");
    expect(await adapter.poll(undefined, start)).toMatchObject({ cursor: "page-2", more: true });
    fetcher.mockResolvedValueOnce(json({ messages: [], next_page_token: "page-3" }));
    await adapter.poll("page-2", start);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("page_token=page-2");
    fetcher.mockResolvedValueOnce(json({ messages: [], next_page_token: "page-3" }));
    await expect(adapter.poll("page-3", start)).rejects.toMatchObject({ code: "agentmail_repeated_page_cursor", permanent: true });
  });
  it("replies only to the original sender, not Reply-To or CC, with stable delivery identity", async () => {
    const { adapter, fetcher } = setup([mail({ reply_to: ["steal@other.test"], cc: ["group@other.test"] })]);
    const incoming = (await adapter.poll(undefined, start)).messages[0]!;
    await adapter.reply(incoming, "Private answer", "stable-delivery");
    const [url, init] = fetcher.mock.calls.at(-1)!;
    expect(String(url)).toContain(encodeURIComponent("<one@test>"));
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("stable-delivery");
    expect(JSON.parse(String(init?.body))).toMatchObject({ to: ["alice@example.test"], cc: [], bcc: [], reply_all: false,
      headers: { "Auto-Submitted": "auto-replied" } });
  });
  it.each([401, 403, 404, 409])("classifies %s as permanent without exposing provider error data", async status => {
    const { adapter, fetcher } = setup([]);
    fetcher.mockResolvedValueOnce(json({ secret: "never-log-this" }, status));
    await expect(adapter.poll(undefined, start)).rejects.toMatchObject({ message: `agentmail_http_${status}`, permanent: true });
  });
  it("honors rate limit retry delay and treats server failures as temporary", async () => {
    const { adapter, fetcher } = setup([]);
    fetcher.mockResolvedValueOnce(json({}, 429, { "retry-after": "120" }));
    await expect(adapter.poll(undefined, start)).rejects.toMatchObject({ permanent: false, retryAfterMs: 120000 });
    fetcher.mockResolvedValueOnce(json({}, 503));
    await expect(adapter.poll(undefined, start)).rejects.toMatchObject({ permanent: false });
  });
  it("rejects an inbox mismatch instead of crossing the entry's account boundary", async () => {
    await expect(setup([mail({ inbox_id: "other@example.test" })]).adapter.poll(undefined, start))
      .rejects.toMatchObject({ code: "agentmail_inbox_mismatch", permanent: true });
  });
});
