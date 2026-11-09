import type { DurableStore } from "../communication/store.js";
import { digest, key } from "../execution/protocol.js";
import { REGISTRY_V1, REGISTRY_V2 } from "./schema.js";

export type IdentityProvider = "matrix" | "web" | "oidc" | "feishu" | "feishu-union" | "grove-mail" | "agentmail" | "telegram" | "weixin" | "bark" | "cloudflare-access";
export type VerifiedBy = "login" | "config" | "pairing" | "admin";
export interface Identity { identityId: string; personId: string; provider: string; namespace: string; subject: string; verifiedBy: string; createdAt: string; lastSeenAt: string | null }
/** Today an owner is identified by the owner's Matrix id; the person id is derived from it (ADR 0005 15.2.4). */
export const personId = (ownerId: string) => `prs_${digest(key("person", ownerId)).slice(0, 24)}`;
const MAIL = new Set(["grove-mail", "agentmail", "cloudflare-access"]);
/** Mail and login subjects are addresses: NFC and lowercase. Other subjects are provider ids and kept as given. */
export const subjectOf = (provider: string, subject: string) => MAIL.has(provider) ? subject.normalize("NFC").toLowerCase() : subject;
export const identityId = (provider: string, namespace: string, subject: string) => `idn_${digest(key(provider, namespace, subjectOf(provider, subject))).slice(0, 24)}`;
const iso = (value: unknown) => value === null || value === undefined ? null : new Date(Number(value)).toISOString();
const view = (row: Record<string, unknown>): Identity => ({ identityId: row.identity_id as string, personId: row.person_id as string, provider: row.provider as string,
  namespace: row.namespace as string, subject: row.subject as string, verifiedBy: row.verified_by as string,
  createdAt: iso(row.created_at)!, lastSeenAt: iso(row.last_seen_at) });

/** Persons and their verified identities (ADR 0005 section 4.3). Routing aliases never live here. */
export class PersonRegistry {
  /** Bumped by every link and revocation, so callers can cache resolutions. */
  generation = 0;
  constructor(readonly store: DurableStore) {
    store.migrate(1, REGISTRY_V1, "registry_schema_version");
    // Additive and idempotent: another branch may ship the same column under the same step.
    const columns = store.db.prepare("PRAGMA table_info(reg_person_identities)").all().map((row) => row.name);
    store.migrate(2, columns.includes("last_seen_at") ? "SELECT 1;" : REGISTRY_V2, "registry_schema_version");
  }
  ensurePerson(ownerId: string, displayName: string, at = Date.now()): string {
    const id = personId(ownerId);
    this.store.db.prepare("INSERT OR IGNORE INTO reg_persons(person_id,display_name,created_at) VALUES(?,?,?)").run(id, displayName, at);
    return id;
  }
  person(id: string): { personId: string; displayName: string } | undefined {
    const row = this.store.db.prepare("SELECT person_id, display_name FROM reg_persons WHERE person_id=?").get(id);
    return row ? { personId: row.person_id as string, displayName: row.display_name as string } : undefined;
  }
  /**
   * Link an identity. An identity already linked to another person is left unchanged (first verified link wins);
   * a revoked identity may be linked again. Returns true when the identity now belongs to `person` and was not active before.
   */
  link(person: string, provider: IdentityProvider, namespace: string, subject: string, verifiedBy: VerifiedBy, at = Date.now()): boolean {
    return this.attach(person, provider, namespace, subject, verifiedBy, at) === "linked";
  }
  /** `link` with the outcome: `linked`, `unchanged` (already this person's) or `conflict` (another person's). */
  attach(person: string, provider: IdentityProvider, namespace: string, subject: string, verifiedBy: VerifiedBy, at = Date.now()): "linked" | "unchanged" | "conflict" {
    const normalized = subjectOf(provider, subject), id = identityId(provider, namespace, normalized);
    const existing = this.store.db.prepare("SELECT person_id, revoked_at FROM reg_person_identities WHERE provider=? AND namespace=? AND subject=?")
      .get(provider, namespace, normalized);
    if (existing && existing.revoked_at === null) return existing.person_id === person ? "unchanged" : "conflict";
    if (existing) this.store.db.prepare(`UPDATE reg_person_identities SET person_id=?, verified_by=?, created_at=?, revoked_at=NULL, last_seen_at=NULL
      WHERE provider=? AND namespace=? AND subject=?`).run(person, verifiedBy, at, provider, namespace, normalized);
    else this.store.db.prepare(`INSERT INTO reg_person_identities(identity_id,person_id,provider,namespace,subject,verified_by,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, person, provider, namespace, normalized, verifiedBy, at);
    this.generation++;
    return "linked";
  }
  resolve(provider: string, namespace: string, subject: string): string | undefined {
    return this.store.db.prepare("SELECT person_id FROM reg_person_identities WHERE provider=? AND namespace=? AND subject=? AND revoked_at IS NULL")
      .get(provider, namespace, subjectOf(provider, subject))?.person_id as string | undefined;
  }
  identity(id: string): Identity | undefined {
    const row = this.store.db.prepare("SELECT * FROM reg_person_identities WHERE identity_id=? AND revoked_at IS NULL").get(id);
    return row ? view(row) : undefined;
  }
  identities(person: string): Identity[] {
    return this.store.db.prepare("SELECT * FROM reg_person_identities WHERE person_id=? AND revoked_at IS NULL ORDER BY created_at, identity_id").all(person).map(view);
  }
  /** The active subjects of one person for one provider and namespace: a connection's derived owner addresses (section 4.3). */
  subjects(person: string, provider: string, namespace: string): string[] {
    return this.store.db.prepare("SELECT subject FROM reg_person_identities WHERE person_id=? AND provider=? AND namespace=? AND revoked_at IS NULL ORDER BY created_at")
      .all(person, provider, namespace).map((row) => row.subject as string);
  }
  revoke(id: string, at = Date.now()): boolean {
    const changed = this.store.db.prepare("UPDATE reg_person_identities SET revoked_at=? WHERE identity_id=? AND revoked_at IS NULL").run(at, id).changes === 1;
    if (changed) this.generation++;
    return changed;
  }
  seen(provider: string, namespace: string, subject: string, at = Date.now()): void {
    this.store.db.prepare("UPDATE reg_person_identities SET last_seen_at=? WHERE provider=? AND namespace=? AND subject=? AND revoked_at IS NULL")
      .run(at, provider, namespace, subjectOf(provider, subject));
  }
}
