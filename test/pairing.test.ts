import { afterEach, describe, expect, it } from "vitest";
import { CommunicationCore, type InboxRecord, type OutboxRecord } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import { AgentLedger, legacySession } from "../src/ledger/ledger.js";
import { OwnerHubs } from "../src/ledger/hub.js";
import { Identities, PAIRING, REPLIES, normalizeCode, pairingCommand } from "../src/ledger/identity.js";
import { PersonRegistry, personId, type IdentityProvider } from "../src/ledger/registry.js";
import { identityHooks } from "../src/service/channels.js";
import { WebChannel } from "../src/channels/web/index.js";
import { WEB_CONNECTION } from "../src/ledger/surfaces.js";
import type { ChannelAdapter, ChannelContext, ChannelKind, ChannelMessage, ReplyRoute } from "../src/communication/types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class Adapter implements ChannelAdapter {
  context!: ChannelContext;
  sent: Array<{ route: ReplyRoute; text: string }> = [];
  constructor(readonly kind: ChannelKind) {}
  readonly retrySafe = true;
  async start(context: ChannelContext) { this.context = context; context.checkpoint("account", `${this.kind}-bot`); }
  async stop() {}
  async send(route: ReplyRoute, text: string, key: string) { this.sent.push({ route, text }); return { externalId: `accepted-${key}` }; }
}
const owner = "@alice:example.test", person = personId(owner), ownerMain = legacySession("agent", "owner-main");
const bob = personId("@bob:example.test");

function registry() {
  const store = new DurableStore(":memory:", "registry"); cleanup.push(() => store.close());
  const persons = new PersonRegistry(store);
  const hubs = new OwnerHubs(":memory:", { owns: () => true, agentName: (id) => id, ledger: () => undefined, personName: (id) => persons.person(id)?.displayName });
  cleanup.push(() => hubs.close());
  persons.ensurePerson(owner, "alice");
  persons.link(person, "matrix", "example.test", owner, "config");
  return { persons, hubs, identity: new Identities(persons, hubs) };
}
async function harness(options: { identity?: boolean; mailPairing?: boolean } = {}) {
  const r = registry();
  const store = new DurableStore(":memory:", "agent"); cleanup.push(() => store.close());
  const ledger = AgentLedger.open(store); ledger.authoritative = true;
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("agent", store, work);
  core.ownerPersonId = person;
  const namespaces = new Map<string, { provider: IdentityProvider; namespace: string }>([
    ["feishu", { provider: "feishu", namespace: "cli_one" }], ["feishu-two", { provider: "feishu", namespace: "cli_two" }],
    ["matrix", { provider: "matrix", namespace: "example.test" }], ["mail", { provider: "grove-mail", namespace: "" }],
    ["feishu-peers", { provider: "feishu", namespace: "cli_peers" }]]);
  if (options.identity !== false) core.identity = identityHooks(r.identity, owner, namespaces, new Set(options.mailPairing ? ["mail"] : []));
  const adapters = { feishu: new Adapter("feishu"), "feishu-two": new Adapter("feishu"), matrix: new Adapter("matrix"), mail: new Adapter("grove-mail"), "feishu-peers": new Adapter("feishu") };
  core.register({ id: "feishu", ownerAddresses: ["ou_owner"] }, adapters.feishu);
  core.register({ id: "feishu-two", ownerAddresses: [] }, adapters["feishu-two"]);
  core.register({ id: "matrix", ownerAddresses: [] }, adapters.matrix);
  core.register({ id: "mail", ownerAddresses: [] }, adapters.mail);
  core.register({ id: "feishu-peers", ownerAddresses: [], peerAddresses: ["ou_peer"] }, adapters["feishu-peers"]);
  const web = new WebChannel(core, owner);
  core.register({ id: WEB_CONNECTION, ownerAddresses: [person] }, web);
  await core.start();
  const inbox = (connectionId: string, externalId: string) => store.get<InboxRecord>("communication_inbox", ledger.claimFor(connectionId, externalId)!.inputId)!;
  const outbox = () => store.entries<OutboxRecord>("communication_outbox").map(({ value }) => value);
  return { ...r, store, ledger, core, web, adapters, inbox, outbox };
}
let counter = 0;
const dm = (sender: string, text: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({ externalId: `m${++counter}`, sender, scope: "direct",
  threadId: `chat-${sender}`, text, reply: { target: `chat-${sender}`, messageId: `m${counter}`, data: {} }, ...extra });
const feishuRaw = (openId: string, unionId: string) => ({ raw: { sender: { sender_id: { open_id: openId, union_id: unionId }, tenant_key: "tenant-1" } } });

describe("pairing codes", () => {
  it("normalizes input: case-insensitive, hyphen optional, I/L read as 1 and O as 0", () => {
    expect(pairingCommand("/link 7kq4-m2xd")).toBe("7KQ4M2XD");
    expect(pairingCommand("  绑定 7KQ4M2XD ")).toBe("7KQ4M2XD");
    expect(normalizeCode("io1l-oooo")).toBe("10110000");
    expect(pairingCommand("/link 7KQ4-M2XD please")).toBeUndefined();
    expect(pairingCommand("请 /link 7KQ4-M2XD")).toBeUndefined();
  });
  it("issues 8-character Crockford codes for one hour, at most three pending per person, and lists and cancels them", () => {
    const { identity } = registry(), now = Date.parse("2026-11-06T08:00:00.000Z");
    const codes = [0, 1, 2].map(() => identity.createCode(owner, now));
    for (const code of codes) expect(code).toMatchObject({ id: expect.stringMatching(/^pc_/), code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
      expiresAt: "2026-11-06T09:00:00.000Z" });
    expect(() => identity.createCode(owner, now)).toThrow("pairing_codes_pending_limit");
    expect(identity.pendingCodes(owner, now).map((item) => item.id)).toEqual(codes.map((code) => code.id));
    identity.cancelCode(owner, codes[0]!.id);
    expect(() => identity.cancelCode(owner, codes[0]!.id)).toThrow("pairing_code_not_found");
    expect(identity.createCode(owner, now)).toMatchObject({ code: expect.any(String) });
    // Expired codes no longer count.
    expect(identity.pendingCodes(owner, now + PAIRING.ttlMs)).toEqual([]);
    expect(identity.createCode(owner, now + PAIRING.ttlMs)).toMatchObject({ code: expect.any(String) });
  });
  it("rejects expired, reused and foreign codes, and locks a sender out after five failures for one hour", () => {
    const { identity, persons } = registry(), now = Date.parse("2026-11-06T08:00:00.000Z");
    const sender = [{ provider: "feishu" as const, namespace: "cli_one", subject: "ou_new" }];
    const expired = identity.createCode(owner, now);
    expect(identity.attempt(owner, sender, normalizeCode(expired.code), now + PAIRING.ttlMs)).toMatchObject({ status: "invalid", reply: REPLIES.invalid });
    const code = identity.createCode(owner, now + PAIRING.ttlMs);
    expect(identity.attempt(owner, sender, normalizeCode(code.code), now + PAIRING.ttlMs)).toMatchObject({ status: "linked", reply: REPLIES.linked("alice") });
    // Redelivery of the same message is recognised; another sender cannot reuse the code.
    expect(identity.attempt(owner, sender, normalizeCode(code.code), now + PAIRING.ttlMs)).toMatchObject({ status: "linked" });
    expect(identity.attempt(owner, [{ provider: "feishu", namespace: "cli_one", subject: "ou_other" }], normalizeCode(code.code), now + PAIRING.ttlMs)).toMatchObject({ status: "invalid" });
    // A code of another owner never links to this owner.
    persons.ensurePerson("@bob:example.test", "bob");
    const foreign = identity.createCode("@bob:example.test", now);
    expect(identity.attempt(owner, [{ provider: "matrix", namespace: "example.test", subject: "@eve:example.test" }], normalizeCode(foreign.code), now)).toMatchObject({ status: "invalid" });

    const attacker = [{ provider: "matrix" as const, namespace: "example.test", subject: "@mallory:example.test" }];
    const valid = identity.createCode(owner, now + PAIRING.ttlMs);
    for (let attempt = 1; attempt <= 4; attempt++) expect(identity.attempt(owner, attacker, "00000000", now + PAIRING.ttlMs + attempt).status).toBe("invalid");
    expect(identity.attempt(owner, attacker, "00000001", now + PAIRING.ttlMs + 5)).toMatchObject({ status: "locked", reply: REPLIES.locked });
    expect(identity.attempt(owner, attacker, normalizeCode(valid.code), now + PAIRING.ttlMs + 6)).toMatchObject({ status: "locked" });
    expect(persons.resolve("matrix", "example.test", "@mallory:example.test")).toBeUndefined();
    // The lockout ends after one hour; the code is still pending (it expires later still).
    const later = now + PAIRING.ttlMs + 5 + PAIRING.lockoutMs;
    const fresh = identity.createCode(owner, later);
    expect(identity.attempt(owner, attacker, normalizeCode(fresh.code), later)).toMatchObject({ status: "linked" });
  });
  it("leaves an identity linked to another person unchanged and keeps the code pending", () => {
    const { identity, persons } = registry(), now = Date.now();
    persons.ensurePerson("@bob:example.test", "bob");
    persons.link(bob, "feishu", "cli_one", "ou_bob", "pairing");
    const code = identity.createCode(owner, now);
    expect(identity.attempt(owner, [{ provider: "feishu", namespace: "cli_one", subject: "ou_bob" }], normalizeCode(code.code), now)).toMatchObject({ status: "conflict", reply: REPLIES.conflict });
    expect(persons.resolve("feishu", "cli_one", "ou_bob")).toBe(bob);
    expect(identity.pendingCodes(owner, now)).toHaveLength(1);
  });
});

describe("pairing at channel ingress", () => {
  it("links a Feishu DM sender (with union_id) before the sender check, writes no transcript, and the sender is the owner from the next message", async () => {
    const h = await harness();
    const code = h.identity.createCode(owner);
    const message = dm("ou_new", `/link ${code.code.toLowerCase()}`, { native: feishuRaw("ou_new", "on_union") });
    h.core.receive("feishu", message);
    const record = h.inbox("feishu", message.externalId);
    expect(record).toMatchObject({ state: "ignored", reason: "pairing", source: { text: "/link ********" } });
    expect(JSON.stringify(record)).not.toContain(code.code.toLowerCase());
    expect(h.ledger.claimFor("feishu", message.externalId)).toMatchObject({ state: "ignored", reason: "pairing", eventId: null });
    expect(h.ledger.counts()).toMatchObject({ events: 0, sessions: 0, conversations: 0, turns: 0, deliveries: 0 });
    await h.core.dispatch(); await h.core.flush();
    expect(h.adapters.feishu.sent).toEqual([{ route: expect.objectContaining({ target: "chat-ou_new" }), text: REPLIES.linked("alice") }]);
    expect(h.ledger.counts()).toMatchObject({ events: 0, turns: 0 });
    expect(h.persons.resolve("feishu", "cli_one", "ou_new")).toBe(person);
    expect(h.persons.resolve("feishu-union", "tenant-1", "on_union")).toBe(person);
    expect(h.identity.list(person).find((item) => item.subject === "ou_new")).toMatchObject({ verifiedBy: "pairing", removable: true });

    const next = dm("ou_new", "你好");
    const accepted = h.core.receive("feishu", next);
    expect(accepted).toMatchObject({ state: "received", conversationId: ownerMain });
    expect(h.core.isOwnerInput(accepted)).toBe(true);
    // The union id recognises the same person through another Feishu app of the deployment.
    const viaOtherApp = h.core.receive("feishu-two", dm("ou_other_app", "另一个应用", { native: feishuRaw("ou_other_app", "on_union") }));
    expect(viaOtherApp).toMatchObject({ state: "received", conversationId: ownerMain });
    expect(h.persons.identities(person).find((item) => item.subject === "ou_new")!.lastSeenAt).not.toBeNull();
  });
  it("links a Matrix DM sender, and owner resolution across Matrix, Feishu and web shares one owner-main session", async () => {
    const h = await harness();
    // The configured Matrix owner resolves by person without `ownerAddresses`.
    expect(h.core.receive("matrix", dm(owner, "矩阵"))).toMatchObject({ state: "received", conversationId: ownerMain });
    const code = h.identity.createCode(owner);
    h.core.receive("matrix", dm("@alice:other.test", `绑定 ${code.code.replace("-", "")}`));
    await h.core.flush();
    expect(h.adapters.matrix.sent.map((item) => item.text)).toEqual([REPLIES.linked("alice")]);
    expect(h.core.receive("matrix", dm("@alice:other.test", "第二账号"))).toMatchObject({ state: "received", conversationId: ownerMain });
    expect(h.core.receive("feishu", dm("ou_owner", "飞书"))).toMatchObject({ state: "received", conversationId: ownerMain });
    h.web.submit({ personId: person, idempotencyKey: "key-0000000000000001", text: "网页" });
    const events = h.ledger.events(ownerMain).filter((event) => event.kind === "message");
    expect(events.map((event) => [event.body.channel, event.senderType, event.senderId])).toEqual([
      ["matrix", "person", person], ["matrix", "person", person], ["feishu", "person", person], ["web", "person", person]]);
  });
  it("ignores /link in groups without a reply and keeps the code pending", async () => {
    const h = await harness();
    const code = h.identity.createCode(owner);
    const message: ChannelMessage = { ...dm("ou_new", `/link ${code.code}`), scope: "group", groupId: "oc_group", threadId: "oc_group" };
    h.core.receive("feishu", message);
    expect(h.inbox("feishu", message.externalId)).toMatchObject({ state: "ignored", reason: "pairing" });
    await h.core.flush();
    expect(h.adapters.feishu.sent).toEqual([]);
    expect(h.identity.pendingCodes(owner)).toHaveLength(1);
    expect(h.ledger.counts()).toMatchObject({ events: 0, sessions: 0 });
  });
  it("replies to wrong codes and locks the sender out after five failures", async () => {
    const h = await harness();
    for (let attempt = 0; attempt < 5; attempt++) h.core.receive("feishu", dm("ou_guess", "/link 0000-0000"));
    await h.core.flush();
    expect(h.adapters.feishu.sent.map((item) => item.text)).toEqual([REPLIES.invalid, REPLIES.invalid, REPLIES.invalid, REPLIES.invalid, REPLIES.locked]);
    const code = h.identity.createCode(owner);
    h.core.receive("feishu", dm("ou_guess", `/link ${code.code}`));
    await h.core.flush();
    expect(h.adapters.feishu.sent.at(-1)!.text).toBe(REPLIES.locked);
    expect(h.persons.resolve("feishu", "cli_one", "ou_guess")).toBeUndefined();
  });
  it("pairs over mail only when the connection enables it and the provider marks the sender verified", async () => {
    const off = await harness();
    const code = off.identity.createCode(owner);
    off.core.receive("mail", dm("Owner@Example.test", `主题：/link ${code.code}\n\n`, { native: { subject: `/link ${code.code}`, senderVerified: true } }));
    await off.core.flush();
    expect(off.adapters.mail.sent.map((item) => item.text)).toEqual([REPLIES.unverified]);
    expect(off.persons.resolve("grove-mail", "", "owner@example.test")).toBeUndefined();

    const on = await harness({ mailPairing: true });
    const second = on.identity.createCode(owner);
    on.core.receive("mail", dm("owner@example.test", `主题：hi\n\n/link ${second.code}`, { native: { subject: "hi" } }));
    on.core.receive("mail", dm("Owner@Example.test", `主题：hi\n\n/link ${second.code}`, { native: { subject: "hi", senderVerified: true } }));
    await on.core.flush();
    expect(on.adapters.mail.sent.map((item) => item.text)).toEqual([REPLIES.unverified, REPLIES.linked("alice")]);
    expect(on.persons.resolve("grove-mail", "", "OWNER@example.test")).toBe(person);
  });
  it("revoking a paired identity takes owner rights away again; config identities cannot be revoked", async () => {
    const h = await harness();
    const code = h.identity.createCode(owner);
    h.core.receive("feishu", dm("ou_new", `/link ${code.code}`));
    const paired = h.identity.list(person).find((item) => item.subject === "ou_new")!;
    h.identity.revoke(person, paired.identityId);
    expect(h.core.receive("feishu", dm("ou_new", "还是我"))).toMatchObject({ state: "ignored" });
    const matrix = h.identity.list(person).find((item) => item.provider === "matrix")!;
    expect(matrix).toMatchObject({ verifiedBy: "config", removable: false, fixed: "identity_from_config" });
    expect(() => h.identity.revoke(person, matrix.identityId)).toThrow("identity_from_config");
    expect(() => h.identity.revoke(bob, paired.identityId)).toThrow("identity_not_found");
    // An edge login identity in use by the request cannot be removed.
    h.persons.link(person, "cloudflare-access", "team.example.test", "alice@example.test", "login");
    const login = h.identity.list(person, { email: "Alice@example.test" }).find((item) => item.provider === "cloudflare-access")!;
    expect(login).toMatchObject({ removable: false, fixed: "identity_in_use" });
    expect(() => h.identity.revoke(person, login.identityId, { email: "alice@example.test" })).toThrow("identity_in_use");
    // A revoked identity may be paired again.
    const again = h.identity.createCode(owner);
    h.core.receive("feishu", dm("ou_new", `/link ${again.code}`));
    expect(h.persons.resolve("feishu", "cli_one", "ou_new")).toBe(person);
  });
  it("a peer that becomes the owner keeps its peer conversation and enters owner-main through a new conversation", async () => {
    const h = await harness();
    const peer = h.core.receive("feishu-peers", dm("ou_peer", "之前"));
    expect(peer.conversationId).not.toBe(ownerMain);
    const code = h.identity.createCode(owner);
    h.core.receive("feishu-peers", dm("ou_peer", `/link ${code.code}`));
    const next = h.core.receive("feishu-peers", dm("ou_peer", "之后"));
    expect(next.conversationId).toBe(ownerMain);
    expect(h.core.isOwnerInput(next)).toBe(true);
    // Earlier peer inputs keep peer rights.
    expect(h.core.isOwnerInput(peer)).toBe(false);
    const before = h.ledger.claimFor("feishu-peers", peer.source.externalId)!.conversationId!, after = h.ledger.claimFor("feishu-peers", next.source.externalId)!.conversationId!;
    expect(after).not.toBe(before);
    expect(h.ledger.conversationSession(before)).toBe(peer.conversationId);
    expect(h.ledger.conversationSession(after)).toBe(ownerMain);
  });
});

describe("config compatibility", () => {
  it("without the identity feature, configured ownerAddresses decide and /link from an unknown sender is ignored without reply", async () => {
    const h = await harness({ identity: false });
    h.identity.createCode(owner);
    const message = dm("ou_new", "/link 0000-0000");
    h.core.receive("feishu", message);
    expect(h.inbox("feishu", message.externalId)).toMatchObject({ state: "ignored", source: { text: "/link 0000-0000" } });
    expect(h.ledger.claimFor("feishu", message.externalId)).toMatchObject({ reason: "sender_not_allowed" });
    await h.core.flush();
    expect(h.adapters.feishu.sent).toEqual([]);
    expect(h.core.receive("feishu", dm("ou_owner", "主人"))).toMatchObject({ state: "received", conversationId: ownerMain });
    // Matrix owner resolution by person is off: an empty ownerAddresses list admits nobody.
    expect(h.core.receive("matrix", dm(owner, "矩阵"))).toMatchObject({ state: "ignored" });
  });
  it("with the feature, configured ownerAddresses still decide even when the registry has no identity for them", async () => {
    const h = await harness();
    expect(h.persons.resolve("feishu", "cli_one", "ou_owner")).toBeUndefined();
    expect(h.core.receive("feishu", dm("ou_owner", "主人"))).toMatchObject({ state: "received", conversationId: ownerMain });
    // A registry failure falls back to the configured addresses and never fails the receipt.
    h.persons.resolve = () => { throw new Error("registry_unavailable"); };
    expect(h.core.receive("feishu", dm("ou_owner", "仍然是主人"))).toMatchObject({ state: "received" });
    expect(h.core.receive("matrix", dm("@stranger:example.test", "hi"))).toMatchObject({ state: "ignored" });
  });
});
