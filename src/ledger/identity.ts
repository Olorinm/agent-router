import { randomBytes } from "node:crypto";
import type { ChannelMessage } from "../communication/types.js";
import type { DurableStore } from "../communication/store.js";
import { digest, key } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import type { OwnerHubs } from "./hub.js";
import { identityId, personId, subjectOf, type Identity, type IdentityProvider, type PersonRegistry } from "./registry.js";
import { OWNER_HUB_IDENTITY_V1 } from "./schema.js";

/** ADR 0005 sections 9 and 18.4. */
export const PAIRING = { codeLength: 8, ttlMs: 3_600_000, pendingPerPerson: 3, failures: 5, failureWindowMs: 3_600_000, lockoutMs: 3_600_000 };
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const COMMAND = /^\s*(?:\/link|绑定)\s+([0-9A-Za-z]{4})-?([0-9A-Za-z]{4})\s*$/;
export const REPLIES = {
  linked: (name: string) => `已关联到 ${name}。之后在这里发给 Agent 的消息会进入你的主对话。`,
  conflict: "此账号已关联到其他用户。", invalid: "关联码无效或已过期。", locked: "尝试次数过多，请一小时后再试。",
  unverified: "无法验证发件人，未关联。",
};
export interface SenderIdentity { provider: IdentityProvider; namespace: string; subject: string }
export interface IdentityView extends Identity { removable: boolean; fixed?: "identity_from_config" | "identity_in_use" }
export interface PendingCode { id: string; createdAt: string; expiresAt: string }
export type PairingStatus = "linked" | "invalid" | "locked" | "conflict" | "unverified";

/** Input is case-insensitive; hyphens and spaces are ignored; I/L read as 1 and O as 0. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}
/** The code of a `/link <code>` (or `绑定 <code>`) message, or undefined when the whole text is not that command. */
export function pairingCommand(text: string): string | undefined {
  const match = COMMAND.exec(text);
  return match ? normalizeCode(`${match[1]}${match[2]}`) : undefined;
}
/** Mail adapters prefix the subject (`主题：…`); the command may be in the subject or alone in the body. */
export function mailPairingCommand(source: Pick<ChannelMessage, "text" | "native">): string | undefined {
  const subject = typeof source.native?.subject === "string" ? source.native.subject : "";
  const prefix = subject ? `主题：${subject}\n\n` : "";
  const body = prefix && source.text.startsWith(prefix) ? source.text.slice(prefix.length) : source.text;
  return pairingCommand(body) ?? (subject && !body.trim() ? pairingCommand(subject) : undefined);
}
/**
 * The identities a message proves: the sender on its connection, plus `("feishu-union", tenant_key, union_id)` when
 * Feishu supplies them (decision 15.2.11). Feishu's raw event carries both under `sender`.
 */
export function senderIdentities(provider: IdentityProvider, namespace: string, source: Pick<ChannelMessage, "sender" | "native">): SenderIdentity[] {
  const identities: SenderIdentity[] = [{ provider, namespace, subject: source.sender }];
  if (provider === "feishu") {
    const raw = source.native?.raw as { sender?: { sender_id?: { union_id?: unknown; open_id?: unknown }; tenant_key?: unknown }; tenant_key?: unknown; header?: { tenant_key?: unknown } } | undefined;
    const union = raw?.sender?.sender_id?.union_id, tenant = raw?.sender?.tenant_key ?? raw?.tenant_key ?? raw?.header?.tenant_key;
    const openId = raw?.sender?.sender_id?.open_id;
    if (typeof union === "string" && union && typeof tenant === "string" && tenant && (openId === undefined || openId === source.sender))
      identities.push({ provider: "feishu-union", namespace: tenant, subject: union });
  }
  return identities;
}

/** Pairing codes and failure counters in one owner's hub (`hub_pairing_codes`, `hub_pairing_failures`). */
class HubPairing {
  constructor(readonly store: DurableStore, readonly ownerId: string) {
    store.migrate(1, `${OWNER_HUB_IDENTITY_V1}\nALTER TABLE hub_pairing_codes ADD COLUMN code_id TEXT;`, "hub_identity_schema_version");
  }
  private get db() { return this.store.db; }
  hash(normalized: string) { return digest(["pairing", digest(this.ownerId), normalized]); }
  prune(now: number) {
    this.db.prepare("DELETE FROM hub_pairing_codes WHERE expires_at<=? OR consumed_at<=?").run(now - 86_400_000, now - 86_400_000);
  }
  pending(person: string, now: number): PendingCode[] {
    return this.db.prepare("SELECT code_id, created_at, expires_at FROM hub_pairing_codes WHERE person_id=? AND consumed_at IS NULL AND expires_at>? ORDER BY created_at")
      .all(person, now).map((row) => ({ id: String(row.code_id), createdAt: new Date(Number(row.created_at)).toISOString(), expiresAt: new Date(Number(row.expires_at)).toISOString() }));
  }
  create(person: string, now: number) {
    return this.store.transaction(() => {
      this.prune(now);
      if (this.pending(person, now).length >= PAIRING.pendingPerPerson) throw new WorkError("pairing_codes_pending_limit", 429);
      const bytes = randomBytes(PAIRING.codeLength), code = [...bytes].map((byte) => ALPHABET[byte & 31]).join("");
      const id = `pc_${randomBytes(12).toString("hex")}`, expires = now + PAIRING.ttlMs;
      this.db.prepare("INSERT INTO hub_pairing_codes(code_hash,person_id,created_at,expires_at,code_id) VALUES(?,?,?,?,?)").run(this.hash(code), person, now, expires, id);
      return { id, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: new Date(expires).toISOString() };
    });
  }
  cancel(person: string, id: string): boolean {
    return this.db.prepare("DELETE FROM hub_pairing_codes WHERE code_id=? AND person_id=? AND consumed_at IS NULL").run(id, person).changes === 1;
  }
  code(normalized: string) {
    return this.db.prepare("SELECT * FROM hub_pairing_codes WHERE code_hash=?").get(this.hash(normalized));
  }
  consume(normalized: string, identity: string, now: number) {
    this.db.prepare("UPDATE hub_pairing_codes SET consumed_at=?, consumed_identity=? WHERE code_hash=? AND consumed_at IS NULL").run(now, identity, this.hash(normalized));
  }
  /** Active failure state; an elapsed window or lockout starts over. */
  failures(sender: string, now: number): { failures: number; windowStart: number; lockedUntil: number } {
    const row = this.db.prepare("SELECT * FROM hub_pairing_failures WHERE sender_key=?").get(sender);
    const lockedUntil = Number(row?.locked_until ?? 0);
    if (!row || (lockedUntil && lockedUntil <= now) || (!lockedUntil && Number(row.window_start) + PAIRING.failureWindowMs <= now)) return { failures: 0, windowStart: now, lockedUntil: 0 };
    return { failures: Number(row.failures), windowStart: Number(row.window_start), lockedUntil };
  }
  fail(sender: string, now: number): boolean {
    const state = this.failures(sender, now), failures = state.failures + 1, locked = failures >= PAIRING.failures ? now + PAIRING.lockoutMs : null;
    this.db.prepare(`INSERT INTO hub_pairing_failures(sender_key,failures,window_start,locked_until) VALUES(?,?,?,?)
      ON CONFLICT(sender_key) DO UPDATE SET failures=excluded.failures, window_start=excluded.window_start, locked_until=excluded.locked_until`)
      .run(sender, failures, state.windowStart, locked);
    return locked !== null;
  }
  clear(sender: string) { this.db.prepare("DELETE FROM hub_pairing_failures WHERE sender_key=?").run(sender); }
}

/**
 * Persons, owner resolution and pairing (ADR 0005 phase 6, `features.identity`). Owner resolution is
 * `resolve(provider, namespace, sender) === personId(agent.owner)`; configured `ownerAddresses` stay seeded as
 * `config` identities and are still honored directly for one release (section 18.1).
 */
export class Identities {
  private readonly hubPairing = new Map<string, HubPairing>();
  private readonly cache = new Map<string, string | null>();
  private cacheGeneration = -1;
  private readonly lastSeen = new Map<string, number>();
  constructor(readonly persons: PersonRegistry, readonly hubs: OwnerHubs) {}
  private pairing(ownerId: string): HubPairing {
    const hub = this.hubs.hub(ownerId);
    let pairing = this.hubPairing.get(ownerId);
    if (!pairing || pairing.store !== hub.store) { pairing = new HubPairing(hub.store, ownerId); this.hubPairing.set(ownerId, pairing); }
    return pairing;
  }
  /** The person of the first active identity, cached until the next link or revocation. */
  resolve(identities: SenderIdentity[]): string | undefined {
    if (this.cacheGeneration !== this.persons.generation) { this.cache.clear(); this.cacheGeneration = this.persons.generation; }
    for (const item of identities) {
      const cacheKey = key(item.provider, item.namespace, subjectOf(item.provider, item.subject));
      let person = this.cache.get(cacheKey);
      if (person === undefined) {
        person = this.persons.resolve(item.provider, item.namespace, item.subject) ?? null;
        if (this.cache.size > 10_000) this.cache.clear();
        this.cache.set(cacheKey, person);
      }
      if (person) return person;
    }
    return undefined;
  }
  /** Records `last_seen_at` at most once a minute per identity. Never throws. */
  seen(identity: SenderIdentity, now = Date.now()): void {
    const cacheKey = key(identity.provider, identity.namespace, subjectOf(identity.provider, identity.subject));
    if ((this.lastSeen.get(cacheKey) ?? 0) + 60_000 > now) return;
    this.lastSeen.set(cacheKey, now);
    try { this.persons.seen(identity.provider, identity.namespace, identity.subject, now); } catch { /* Shown as stale only. */ }
  }
  list(person: string, current?: { email?: string | undefined }): IdentityView[] {
    return this.persons.identities(person).map((identity) => {
      const fixed = identity.verifiedBy === "config" ? "identity_from_config" as const : inUse(identity, current) ? "identity_in_use" as const : undefined;
      return { ...identity, removable: !fixed, ...(fixed ? { fixed } : {}) };
    });
  }
  revoke(person: string, id: string, current?: { email?: string | undefined }, now = Date.now()): void {
    const identity = this.persons.identity(id);
    if (!identity || identity.personId !== person) throw new WorkError("identity_not_found", 404);
    if (identity.verifiedBy === "config") throw new WorkError("identity_from_config", 409);
    if (inUse(identity, current)) throw new WorkError("identity_in_use", 409);
    this.persons.revoke(id, now);
  }
  createCode(ownerId: string, now = Date.now()) { return this.pairing(ownerId).create(personId(ownerId), now); }
  pendingCodes(ownerId: string, now = Date.now()) { return this.pairing(ownerId).pending(personId(ownerId), now); }
  cancelCode(ownerId: string, id: string) {
    if (!this.pairing(ownerId).cancel(personId(ownerId), id)) throw new WorkError("pairing_code_not_found", 404);
  }
  /**
   * One `/link` attempt from `identities[0]` to an agent of `ownerId`. Only the agent owner's pending codes match, so
   * pairing links a person's own identities and never another person (section 9).
   */
  attempt(ownerId: string, identities: SenderIdentity[], code: string, now = Date.now()): { status: PairingStatus; reply: string } {
    const pairing = this.pairing(ownerId), sender = identities[0]!, person = personId(ownerId);
    const senderKey = digest(key(sender.provider, sender.namespace, subjectOf(sender.provider, sender.subject)));
    const senderId = identityId(sender.provider, sender.namespace, sender.subject);
    if (pairing.failures(senderKey, now).lockedUntil > now) return { status: "locked", reply: REPLIES.locked };
    const row = pairing.code(code);
    const name = () => this.persons.person(person)?.displayName ?? ownerId;
    // A redelivered `/link` whose first attempt already linked (the receipt may not have committed).
    if (row && row.consumed_identity === senderId && row.person_id === person && this.persons.resolve(sender.provider, sender.namespace, sender.subject) === person)
      return { status: "linked", reply: REPLIES.linked(name()) };
    if (!row || row.person_id !== person || row.consumed_at !== null || Number(row.expires_at) <= now) {
      return pairing.fail(senderKey, now) ? { status: "locked", reply: REPLIES.locked } : { status: "invalid", reply: REPLIES.invalid };
    }
    const outcome = this.persons.attach(person, sender.provider, sender.namespace, sender.subject, "pairing", now);
    if (outcome === "conflict") return { status: "conflict", reply: REPLIES.conflict };
    for (const extra of identities.slice(1)) this.persons.attach(person, extra.provider, extra.namespace, extra.subject, "pairing", now);
    pairing.consume(code, senderId, now);
    pairing.clear(senderKey);
    return { status: "linked", reply: REPLIES.linked(name()) };
  }
}
function inUse(identity: Identity, current?: { email?: string | undefined }) {
  return identity.provider === "cloudflare-access" && Boolean(current?.email) && identity.subject === subjectOf("cloudflare-access", current!.email!);
}
