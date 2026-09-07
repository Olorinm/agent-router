import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One durable store per Matrix identity. Network calls never run inside a transaction. */
export class ConnectorStore {
  readonly db: DatabaseSync;
  constructor(path: string, identity: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(collection,id));
      CREATE INDEX IF NOT EXISTS document_status ON documents(collection,json_extract(value,'$.status'));`);
    if (path !== ":memory:") chmodSync(path, 0o600);
    const previous = this.get<string>("meta", "identity");
    if (previous && previous !== identity) { this.db.close(); throw new Error("store_identity_mismatch"); }
    this.set("meta", "identity", identity);
  }
  get<T>(collection: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM documents WHERE collection=? AND id=?").get(collection, id);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }
  set(collection: string, id: string, value: unknown): void {
    this.db.prepare("INSERT INTO documents VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value")
      .run(collection, id, JSON.stringify(value));
  }
  insert(collection: string, id: string, value: unknown): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO documents VALUES(?,?,?)").run(collection, id, JSON.stringify(value)).changes === 1;
  }
  delete(collection: string, id: string): void {
    this.db.prepare("DELETE FROM documents WHERE collection=? AND id=?").run(collection, id);
  }
  entries<T>(collection: string): Array<{ id: string; value: T }> {
    return this.db.prepare("SELECT id,value FROM documents WHERE collection=? ORDER BY rowid").all(collection)
      .map((row) => ({ id: row.id as string, value: JSON.parse(row.value as string) as T }));
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  acquireLease(owner: string, now = Date.now()): void {
    this.transaction(() => {
      const lease = this.get<{ owner: string; expires: number }>("meta", "lease");
      if (lease && lease.owner !== owner && lease.expires > now) throw new Error("connector_store_already_in_use");
      this.set("meta", "lease", { owner, expires: now + 30_000 });
    });
  }
  releaseLease(owner: string): void {
    if (this.get<{ owner: string }>("meta", "lease")?.owner === owner) this.delete("meta", "lease");
  }
  close(): void { this.db.close(); }
}
