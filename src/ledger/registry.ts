import type { DurableStore } from "../communication/store.js";
import { digest, key } from "../execution/protocol.js";
import { REGISTRY_V1 } from "./schema.js";

export type IdentityProvider = "matrix" | "web" | "oidc" | "feishu" | "grove-mail" | "agentmail" | "telegram" | "weixin";
export interface Identity { identityId: string; personId: string; provider: string; namespace: string; subject: string; verifiedBy: string; createdAt: string }
/** Today an owner is identified by the owner's Matrix id; the person id is derived from it until phase 6. */
export const personId = (ownerId: string) => `prs_${digest(key("person", ownerId)).slice(0, 24)}`;
const subjectOf = (provider: string, subject: string) => ["grove-mail", "agentmail"].includes(provider) ? subject.toLowerCase() : subject;

/** Persons and their verified identities (ADR 0005 section 4.3). Routing aliases never live here. */
export class PersonRegistry {
  constructor(readonly store: DurableStore) { store.migrate(1, REGISTRY_V1, "registry_schema_version"); }
  ensurePerson(ownerId: string, displayName: string, at = Date.now()): string {
    const id = personId(ownerId);
    this.store.db.prepare("INSERT OR IGNORE INTO reg_persons(person_id,display_name,created_at) VALUES(?,?,?)").run(id, displayName, at);
    return id;
  }
  person(id: string): { personId: string; displayName: string } | undefined {
    const row = this.store.db.prepare("SELECT person_id, display_name FROM reg_persons WHERE person_id=?").get(id);
    return row ? { personId: row.person_id as string, displayName: row.display_name as string } : undefined;
  }
  /** Link an identity. An identity already linked to another person is left unchanged (first verified link wins). */
  link(person: string, provider: IdentityProvider, namespace: string, subject: string, verifiedBy: "login" | "config" | "pairing" | "admin", at = Date.now()): boolean {
    const normalized = subjectOf(provider, subject);
    return this.store.db.prepare(`INSERT OR IGNORE INTO reg_person_identities(identity_id,person_id,provider,namespace,subject,verified_by,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(`idn_${digest(key(provider, namespace, normalized)).slice(0, 24)}`, person, provider, namespace, normalized, verifiedBy, at).changes === 1;
  }
  resolve(provider: string, namespace: string, subject: string): string | undefined {
    return this.store.db.prepare("SELECT person_id FROM reg_person_identities WHERE provider=? AND namespace=? AND subject=? AND revoked_at IS NULL")
      .get(provider, namespace, subjectOf(provider, subject))?.person_id as string | undefined;
  }
  identities(person: string): Identity[] {
    return this.store.db.prepare("SELECT * FROM reg_person_identities WHERE person_id=? AND revoked_at IS NULL ORDER BY created_at").all(person)
      .map((row) => ({ identityId: row.identity_id as string, personId: row.person_id as string, provider: row.provider as string,
        namespace: row.namespace as string, subject: row.subject as string, verifiedBy: row.verified_by as string,
        createdAt: new Date(Number(row.created_at)).toISOString() }));
  }
}
