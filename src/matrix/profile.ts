import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { mxid } from "./protocol.js";

const profileSchema = z.object({
  version: z.literal(1), homeserver: z.string().url(), userId: mxid, deviceId: z.string().min(1),
  accessToken: z.string().min(1).optional(), refreshToken: z.string().min(1).optional(),
  gatewayToken: z.string().min(16), connectorUrl: z.string().url(),
  backend: z.object({ cardUrl: z.string().url(), token: z.string(), allowLocal: z.boolean() }).optional(),
}).strict();
export type MatrixProfile = z.infer<typeof profileSchema>;

/** This directory belongs to this CLI; existing deployment env files are not modified. */
export class ProfileStore {
  readonly directory: string;
  readonly path: string;
  readonly databasePath: string;
  constructor(readonly name = process.env.MATRIX_PROFILE ?? "default", base = process.env.MATRIX_CONFIG_DIR ?? join(homedir(), ".config", "agent-router", "matrix")) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid profile name; use letters, numbers, _ or -.");
    this.directory = resolve(base, name); this.path = join(this.directory, "session.json");
    this.databasePath = join(this.directory, "connector.sqlite");
  }
  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const path of [dirname(this.directory), this.directory]) {
      const s = lstatSync(path);
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())) {
        throw new Error("Matrix profile directories must be owned by this user with mode 0700.");
      }
    }
  }
  load(): MatrixProfile | undefined {
    if (!existsSync(this.path)) return undefined;
    this.ensureDirectory();
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || (s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())) throw new Error("Matrix session file must be owned by this user with mode 0600.");
      return profileSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally { closeSync(fd); }
  }
  require(): MatrixProfile {
    const profile = this.load();
    if (!profile?.accessToken) throw new Error("Not logged in. Run: matrix login @name:server (or matrix register SERVER NAME).");
    return profile;
  }
  save(value: MatrixProfile): void {
    this.ensureDirectory();
    const profile = profileSchema.parse(value);
    const path = join(this.directory, `.session-${randomBytes(12).toString("hex")}`);
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(profile, null, 2) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(path, this.path); }
    finally { if (existsSync(path)) unlinkSync(path); }
    const directory = openSync(this.directory, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  /** Held for the connector lifetime, and for commands which alter credentials or bindings. */
  lock(): () => void {
    this.ensureDirectory();
    const path = join(this.directory, "profile-lock.sqlite");
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Profile lock must not be a symbolic link.");
    const db = new DatabaseSync(path); chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); BEGIN IMMEDIATE");
    const owner = { pid: process.pid, host: hostname(), nonce: randomBytes(16).toString("hex") };
    try {
      const row = db.prepare("SELECT value FROM owner WHERE id=1").get();
      if (row) {
        const previous = JSON.parse(row.value as string) as typeof owner;
        if (previous.host !== hostname() || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("Profile is locked on another host.");
        let alive = true;
        try { process.kill(previous.pid, 0); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive) throw new Error("Profile is in use. Stop its connector before login, logout or changing its binding.");
      }
      db.prepare("INSERT INTO owner VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(owner));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
    let released = false;
    return () => {
      if (released) return; released = true;
      db.prepare("DELETE FROM owner WHERE id=1 AND value=?").run(JSON.stringify(owner)); db.close();
    };
  }
}

export function publicProfile(profile: MatrixProfile, store: ProfileStore) {
  return { profile: store.name, userId: profile.userId, homeserver: profile.homeserver, deviceId: profile.deviceId,
    loggedIn: Boolean(profile.accessToken), connectorUrl: profile.connectorUrl, backend: profile.backend?.cardUrl ?? null };
}

export function connectorAddress(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Profile connector URL must be a loopback HTTP origin, for example http://127.0.0.1:8787.");
  }
  return url;
}
