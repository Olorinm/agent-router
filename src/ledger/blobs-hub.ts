import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AttachmentReference, MediaContent } from "../communication/types.js";
import { MAX_MEDIA_BYTES } from "../communication/media.js";
import { digest } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import { boundRange, type BlobBody, type BlobFile, type BlobKey, type BlobRange, type BlobStore } from "./blobs.js";
import type { OwnerHub, OwnerHubs } from "./hub.js";
import { ulid, type AgentLedger } from "./ledger.js";

/** ADR 0005 16.5 limits. `quotaBytes` counts distinct blobs per owner. */
export const ATTACHMENT_LIMITS = { uploadBytes: 25 * 1024 * 1024, perMessage: 10, messageBytes: 30 * 1024 * 1024,
  quotaBytes: 5 * 1024 ** 3, uploadsPerMinute: 60, unboundMs: 24 * 3_600_000, graceMs: 7 * 24 * 3_600_000 };

export interface AttachmentMeta { attachmentId: string; name: string; contentType: string; size: number; sha256: string }
/** The body entry of a message event (`ChatEvent.attachments[]` without the `url`, which `render` adds). */
export type MessageAttachment = AttachmentMeta;
export type AttachmentTarget = { agentId: string } | { roomId: string };
export interface AttachmentDependencies {
  hubs: OwnerHubs;
  store: BlobStore;
  quotaBytes?: number | undefined;
  /** Active agents of an owner, as the web API sees them. */
  owned(ownerId: string): Array<{ id: string }>;
  /** Opens the agent runtime (and so its ledger) when needed. */
  open(agentId: string): Promise<void>;
  ledger(agentId: string): AgentLedger | undefined;
  /** Lazy promotion of channel attachments: reads the bytes through the channel adapter (`readAttachment`). */
  readChannel?(agentId: string, inputId: string, reference: AttachmentReference & { connectionId: string }): Promise<MediaContent>;
  tempDir?: string | undefined;
}
interface Spooled extends BlobFile { cleanup(): Promise<void> }
const ownerKey = (ownerId: string) => digest(ownerId);
const refs = { upload: (id: string) => `upload:${id}`, agent: (agentId: string, id: string) => `agent:${agentId}:${id}`, room: (roomId: string, id: string) => `room:${roomId}:${id}` };
const refFor = (target: AttachmentTarget, id: string) => "agentId" in target ? refs.agent(target.agentId, id) : refs.room(target.roomId, id);

/**
 * Attachments and blob reference counting (ADR 0005 16.5) over the owner hubs (`hub_uploads`, `hub_blobs`,
 * `hub_blob_refs`, `hub_room_attachments`) and the agent ledgers (`ledger_attachments`). Bytes live in the
 * `BlobStore` under the owner's prefix, so deduplication never crosses owners.
 *
 * Network calls never run inside a SQLite transaction. One in-process lock per (owner, sha256) orders uploads,
 * promotions and the sweeper, so a sweep can never delete an object that a concurrent upload just found present.
 */
export class OwnerAttachments {
  readonly quotaBytes: number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly tempDir: string;
  constructor(private readonly deps: AttachmentDependencies) {
    this.quotaBytes = deps.quotaBytes ?? ATTACHMENT_LIMITS.quotaBytes;
    this.tempDir = deps.tempDir ?? join(tmpdir(), "agent-router-uploads");
  }
  get store(): BlobStore { return this.deps.store; }
  private hub(ownerId: string): OwnerHub { return this.deps.hubs.hub(ownerId); }
  private key(ownerId: string, sha256: string): BlobKey { return { ownerKey: ownerKey(ownerId), sha256 }; }
  private async locked<T>(ownerId: string, sha256: string, work: () => Promise<T>): Promise<T> {
    const id = `${ownerKey(ownerId)}:${sha256}`, prior = this.locks.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  /** Bytes used by an owner: distinct blobs, including those waiting out their grace period. */
  usage(ownerId: string): number {
    return Number(this.hub(ownerId).store.db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM hub_blobs").get()!.n);
  }
  private hasBlob(hub: OwnerHub, sha256: string): boolean {
    return Boolean(hub.store.db.prepare("SELECT 1 FROM hub_blobs WHERE sha256=?").get(sha256));
  }
  /** Stream to a temp file while hashing. More bytes than `limit` (or than `expected`) is rejected. */
  async spool(source: Iterable<Uint8Array> | AsyncIterable<Uint8Array> | Readable, contentType: string, limit: number, expected?: number): Promise<Spooled> {
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    const path = join(this.tempDir, `up-${randomBytes(12).toString("hex")}`);
    const sha = createHash("sha256"), md5 = createHash("md5");
    let size = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > limit || (expected !== undefined && size > expected)) { done(new WorkError("attachment_too_large", 413)); return; }
      sha.update(chunk); md5.update(chunk); done(null, chunk);
    } });
    const cleanup = () => rm(path, { force: true });
    try {
      await pipeline(source instanceof Readable ? source : Readable.from(source), meter, createWriteStream(path, { mode: 0o600 }));
    } catch (error) { await cleanup(); throw error instanceof WorkError ? error : new WorkError("upload_incomplete", 400); }
    if (expected !== undefined && size !== expected) { await cleanup(); throw new WorkError("upload_incomplete", 400); }
    return { path, size, sha256: sha.digest("hex"), md5: md5.digest("hex"), contentType, cleanup };
  }
  /**
   * `POST /attachments`. The caller has checked `Content-Length` (411/413). Quota is checked before the bytes
   * are stored and again in the hub transaction; a blob the owner already holds does not count again.
   */
  async upload(owner: { ownerId: string; personId: string }, body: Readable, input: { size: number; contentType: string; name: string; sha256?: string | undefined },
    at = Date.now()): Promise<AttachmentMeta> {
    const hub = this.hub(owner.ownerId);
    if (input.size > ATTACHMENT_LIMITS.uploadBytes) throw new WorkError("attachment_too_large", 413);
    const known = input.sha256 !== undefined && this.hasBlob(hub, input.sha256);
    if (!known && this.usage(owner.ownerId) + input.size > this.quotaBytes) { body.resume(); throw new WorkError("attachment_quota_exceeded", 413); }
    const file = await this.spool(body, input.contentType, ATTACHMENT_LIMITS.uploadBytes, input.size);
    try {
      if (input.sha256 !== undefined && input.sha256 !== file.sha256) throw new WorkError("sha256_mismatch", 422);
      return await this.locked(owner.ownerId, file.sha256, async () => {
        const existed = this.hasBlob(hub, file.sha256);
        if (!existed && this.usage(owner.ownerId) + file.size > this.quotaBytes) throw new WorkError("attachment_quota_exceeded", 413);
        const key = this.key(owner.ownerId, file.sha256);
        if (!(await this.store.head(key))) await this.store.put(key, file);
        const attachmentId = `at_${ulid(at)}`;
        try {
          hub.store.transaction(() => {
            if (!this.hasBlob(hub, file.sha256) && this.usage(owner.ownerId) + file.size > this.quotaBytes) throw new WorkError("attachment_quota_exceeded", 413);
            this.upsertBlob(hub, file.sha256, file.size, input.contentType, owner.personId, at);
            hub.store.db.prepare(`INSERT INTO hub_uploads(attachment_id,sha256,name,content_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)`)
              .run(attachmentId, file.sha256, input.name, input.contentType, file.size, owner.personId, at);
            this.addRef(hub, file.sha256, refs.upload(attachmentId), at);
          });
        } catch (error) {
          // Nothing references the object: remove it again unless the owner held it before.
          if (!this.hasBlob(hub, file.sha256)) await this.store.delete(key).catch(() => undefined);
          throw error;
        }
        return { attachmentId, name: input.name, contentType: input.contentType, size: file.size, sha256: file.sha256 };
      });
    } finally { await file.cleanup(); }
  }
  private upsertBlob(hub: OwnerHub, sha256: string, size: number, contentType: string, uploadedBy: string, at: number) {
    hub.store.db.prepare(`INSERT INTO hub_blobs(sha256,size,content_type,uploaded_by,created_at,unreferenced_at) VALUES(?,?,?,?,?,NULL)
      ON CONFLICT(sha256) DO UPDATE SET unreferenced_at=NULL`).run(sha256, size, contentType, uploadedBy, at);
  }
  private addRef(hub: OwnerHub, sha256: string, ref: string, at: number) {
    hub.store.db.prepare("INSERT OR IGNORE INTO hub_blob_refs(sha256,ref,created_at) VALUES(?,?,?)").run(sha256, ref, at);
    hub.store.db.prepare("UPDATE hub_blobs SET unreferenced_at=NULL WHERE sha256=?").run(sha256);
  }
  /** Delete references (redaction, purge, expiry). A blob left without references starts its 7-day grace period. */
  release(ownerId: string, released: string[], at = Date.now()): void {
    if (!released.length) return;
    const hub = this.hub(ownerId);
    hub.store.transaction(() => this.releaseIn(hub, released, at));
  }
  private releaseIn(hub: OwnerHub, released: string[], at: number) {
    for (const ref of released) {
      const rows = hub.store.db.prepare("SELECT sha256 FROM hub_blob_refs WHERE ref=?").all(ref);
      hub.store.db.prepare("DELETE FROM hub_blob_refs WHERE ref=?").run(ref);
      for (const row of rows) hub.store.db.prepare(`UPDATE hub_blobs SET unreferenced_at=? WHERE sha256=? AND unreferenced_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hub_blob_refs WHERE sha256=?)`).run(at, row.sha256 as string, row.sha256 as string);
    }
  }
  /** Redaction/purge of agent ledger attachments (ADR 16.4): drop their `agent:` references. */
  releaseAgent(ownerId: string, agentId: string, attachmentIds: string[], at = Date.now()): void {
    this.release(ownerId, attachmentIds.map((id) => refs.agent(agentId, id)), at);
  }
  releaseRoom(ownerId: string, roomId: string, attachmentIds: string[], at = Date.now()): void {
    this.release(ownerId, attachmentIds.map((id) => refs.room(roomId, id)), at);
  }

  // ---- Send binding (ADR 16.5 "Send binding"). Called by the phase 3 send path; see the ADR implementation notes. ----

  /**
   * Step 1, before the send transaction: validate `SendRequest.attachments` (the caller's own unbound uploads, at most
   * 10 and 30 MiB) and pin them with the target reference, so no sweep can collect them while the send commits.
   */
  reserve(owner: { ownerId: string; personId: string }, attachmentIds: string[], target: AttachmentTarget, at = Date.now()): MessageAttachment[] {
    if (!attachmentIds.length) return [];
    if (attachmentIds.length > ATTACHMENT_LIMITS.perMessage || new Set(attachmentIds).size !== attachmentIds.length) throw new WorkError("too_many_attachments", 422);
    const hub = this.hub(owner.ownerId);
    return hub.store.transaction(() => {
      const items = attachmentIds.map((id) => {
        const row = hub.store.db.prepare("SELECT * FROM hub_uploads WHERE attachment_id=? AND uploaded_by=? AND bound_at IS NULL").get(id, owner.personId);
        if (!row) throw new WorkError("attachment_not_found", 422);
        return { attachmentId: id, name: String(row.name), contentType: String(row.content_type), size: Number(row.size), sha256: String(row.sha256) };
      });
      if (items.reduce((total, item) => total + item.size, 0) > ATTACHMENT_LIMITS.messageBytes) throw new WorkError("attachments_too_large", 413);
      for (const item of items) this.addRef(hub, item.sha256, refFor(target, item.attachmentId), at);
      return items;
    });
  }
  /** Step 2, inside the agent ledger's send transaction: the DM rows (`locator {"blob":"sha256:<hex>"}`, `event_id` set). */
  writeLedger(ledger: AgentLedger, items: MessageAttachment[], eventId: string, at = Date.now()): void {
    for (const item of items) ledger.store.db.prepare(`INSERT OR IGNORE INTO ledger_attachments(attachment_id,event_id,name,content_type,size,sha256,locator,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(item.attachmentId, eventId, item.name, item.contentType, item.size, item.sha256, JSON.stringify({ blob: `sha256:${item.sha256}` }), at);
  }
  /** Step 2 for rooms (phase 5), inside the hub transaction that appends the room event. */
  writeRoom(ownerId: string, roomId: string, items: MessageAttachment[], eventId: string, at = Date.now()): void {
    const hub = this.hub(ownerId);
    for (const item of items) hub.store.db.prepare(`INSERT OR IGNORE INTO hub_room_attachments(attachment_id,room_id,event_id,name,content_type,size,sha256,locator,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(item.attachmentId, roomId, eventId, item.name, item.contentType, item.size, item.sha256, JSON.stringify({ blob: `sha256:${item.sha256}` }), at);
  }
  /** Step 3, after the send committed: the uploads become bound and lose their `upload:` reference. */
  commit(owner: { ownerId: string; personId: string }, attachmentIds: string[], at = Date.now()): void {
    if (!attachmentIds.length) return;
    const hub = this.hub(owner.ownerId);
    hub.store.transaction(() => {
      for (const id of attachmentIds) hub.store.db.prepare("UPDATE hub_uploads SET bound_at=? WHERE attachment_id=? AND uploaded_by=? AND bound_at IS NULL").run(at, id, owner.personId);
      this.releaseIn(hub, attachmentIds.map(refs.upload), at);
    });
  }
  /** The send failed before commit: drop the pins of step 1. The uploads stay unbound and can be sent again. */
  abort(ownerId: string, attachmentIds: string[], target: AttachmentTarget, at = Date.now()): void {
    this.release(ownerId, attachmentIds.map((id) => refFor(target, id)), at);
  }
  /**
   * Agent outbound media on a web or room turn (`ChannelContent.media`): stored under the owner's prefix and
   * referenced by the returned attachment. The caller writes it with `writeLedger`/`writeRoom` on the final event.
   */
  async storeMedia(ownerId: string, target: AttachmentTarget, media: MediaContent, at = Date.now()): Promise<MessageAttachment> {
    const bytes = Buffer.from(media.data, "base64");
    const file = await this.spool([bytes], media.mediaType, MAX_MEDIA_BYTES);
    try {
      const attachmentId = `at_${ulid(at)}`;
      await this.locked(ownerId, file.sha256, async () => {
        const key = this.key(ownerId, file.sha256);
        if (!(await this.store.head(key))) await this.store.put(key, file);
        const hub = this.hub(ownerId);
        hub.store.transaction(() => { this.upsertBlob(hub, file.sha256, file.size, media.mediaType, "agent", at); this.addRef(hub, file.sha256, refFor(target, attachmentId), at); });
      });
      return { attachmentId, name: media.name, contentType: media.mediaType, size: file.size, sha256: file.sha256 };
    } finally { await file.cleanup(); }
  }
  /** `WebChannel.readAttachment` / `RoomChannel.readAttachment`: blob → `MediaContent` (cap `MAX_MEDIA_BYTES`). */
  async readMedia(ownerId: string, item: Pick<AttachmentMeta, "name" | "contentType" | "sha256">): Promise<MediaContent> {
    const { body } = await this.store.get(this.key(ownerId, item.sha256));
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of body) {
      size += (chunk as Buffer).length;
      if (size > MAX_MEDIA_BYTES) { body.destroy(); throw new Error("attachment_too_large"); }
      chunks.push(chunk as Buffer);
    }
    return { name: item.name, mediaType: item.contentType, data: Buffer.concat(chunks).toString("base64") };
  }

  // ---- Download ----

  /**
   * Permission (ADR 16.5): the caller uploaded it, or an event in a chat the caller can read references it.
   * Everything else is 404, including attachments of other owners. Channel attachments are promoted lazily.
   */
  async resolve(owner: { ownerId: string; personId: string }, attachmentId: string, at = Date.now()): Promise<AttachmentMeta> {
    if (!/^at_[0-9A-Z]{26}$/.test(attachmentId)) throw new WorkError("attachment_not_found", 404);
    const hub = this.hub(owner.ownerId), db = hub.store.db;
    const upload = db.prepare("SELECT * FROM hub_uploads WHERE attachment_id=? AND uploaded_by=?").get(attachmentId, owner.personId);
    if (upload) return { attachmentId, name: String(upload.name), contentType: String(upload.content_type), size: Number(upload.size), sha256: String(upload.sha256) };
    const room = db.prepare("SELECT * FROM hub_room_attachments WHERE attachment_id=? AND event_id IS NOT NULL AND sha256 IS NOT NULL").get(attachmentId);
    if (room) return { attachmentId, name: String(room.name), contentType: String(room.content_type), size: Number(room.size), sha256: String(room.sha256) };
    const owned = this.deps.owned(owner.ownerId).map((agent) => agent.id);
    // Fast path: blob-bound agent attachments carry their agent in the reference.
    const hinted = db.prepare("SELECT ref FROM hub_blob_refs WHERE ref LIKE 'agent:%' AND ref LIKE ?").all(`%:${attachmentId}`)
      .filter((row) => String(row.ref).endsWith(`:${attachmentId}`)).map((row) => String(row.ref).split(":")[1]!).filter((id) => owned.includes(id));
    for (const agentId of [...new Set([...hinted, ...owned])]) {
      await this.deps.open(agentId).catch(() => undefined);
      const ledger = this.deps.ledger(agentId);
      const row = ledger?.store.db.prepare("SELECT * FROM ledger_attachments WHERE attachment_id=? AND event_id IS NOT NULL").get(attachmentId);
      if (!ledger || !row) continue;
      const locator = JSON.parse(String(row.locator)) as { blob?: string; channel?: AttachmentReference & { connectionId: string } };
      if (row.sha256 && locator.blob) return { attachmentId, name: String(row.name), contentType: String(row.content_type), size: Number(row.size), sha256: String(row.sha256) };
      if (locator.channel) return this.promote(owner.ownerId, agentId, ledger, attachmentId, String(row.event_id), locator.channel, at);
    }
    throw new WorkError("attachment_not_found", 404);
  }
  /** Read a channel attachment through its adapter, store it under the owner's prefix and rewrite the locator. */
  private async promote(ownerId: string, agentId: string, ledger: AgentLedger, attachmentId: string, eventId: string,
    reference: AttachmentReference & { connectionId: string }, at: number): Promise<AttachmentMeta> {
    const claim = ledger.store.db.prepare("SELECT input_id FROM ledger_ingress WHERE event_id=?").get(eventId);
    if (!claim || !this.deps.readChannel) throw new WorkError("attachment_unavailable", 502);
    let media: MediaContent;
    try { media = await this.deps.readChannel(agentId, String(claim.input_id), reference); }
    catch { throw new WorkError("attachment_unavailable", 502); }
    const file = await this.spool([Buffer.from(media.data, "base64")], media.mediaType, MAX_MEDIA_BYTES);
    try {
      return await this.locked(ownerId, file.sha256, async () => {
        const key = this.key(ownerId, file.sha256);
        if (!(await this.store.head(key))) await this.store.put(key, file);
        const hub = this.hub(ownerId);
        hub.store.transaction(() => { this.upsertBlob(hub, file.sha256, file.size, media.mediaType, "channel", at); this.addRef(hub, file.sha256, refs.agent(agentId, attachmentId), at); });
        ledger.store.db.prepare("UPDATE ledger_attachments SET sha256=?, size=?, content_type=?, locator=? WHERE attachment_id=?")
          .run(file.sha256, file.size, media.mediaType, JSON.stringify({ blob: `sha256:${file.sha256}` }), attachmentId);
        return { attachmentId, name: media.name || reference.name, contentType: media.mediaType, size: file.size, sha256: file.sha256 };
      });
    } finally { await file.cleanup(); }
  }
  /** Open the bytes of a resolved attachment, honoring an inclusive byte range (416 outside the blob). */
  async open(owner: { ownerId: string }, meta: AttachmentMeta, range?: BlobRange): Promise<BlobBody> {
    if (range) boundRange(meta.size, range);
    return this.store.get(this.key(owner.ownerId, meta.sha256), range);
  }

  // ---- Sweeper ----

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Hourly sweep in the background (unref'd). `stop()` on service close. */
  startSweeper(intervalMs = 3_600_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(() => undefined); }, intervalMs);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  /**
   * Unbound uploads older than 24 h lose their reference; blobs without references for 7 days are deleted from the
   * store and then from `hub_blobs`. A failed store delete keeps the row, so the next sweep retries.
   */
  async sweep(at = Date.now()): Promise<{ expiredUploads: number; deletedBlobs: number }> {
    let expiredUploads = 0, deletedBlobs = 0;
    for (const hub of this.deps.hubs.open()) {
      const ownerId = hub.ownerId;
      const stale = hub.store.db.prepare("SELECT attachment_id FROM hub_uploads WHERE bound_at IS NULL AND created_at<?").all(at - ATTACHMENT_LIMITS.unboundMs)
        .map((row) => String(row.attachment_id));
      if (stale.length) hub.store.transaction(() => {
        this.releaseIn(hub, stale.map(refs.upload), at);
        for (const id of stale) hub.store.db.prepare("DELETE FROM hub_uploads WHERE attachment_id=? AND bound_at IS NULL").run(id);
      });
      expiredUploads += stale.length;
      hub.store.db.prepare("UPDATE hub_blobs SET unreferenced_at=? WHERE unreferenced_at IS NULL AND NOT EXISTS (SELECT 1 FROM hub_blob_refs r WHERE r.sha256=hub_blobs.sha256)").run(at);
      const due = hub.store.db.prepare(`SELECT sha256 FROM hub_blobs WHERE unreferenced_at IS NOT NULL AND unreferenced_at<=?
        AND NOT EXISTS (SELECT 1 FROM hub_blob_refs r WHERE r.sha256=hub_blobs.sha256)`).all(at - ATTACHMENT_LIMITS.graceMs).map((row) => String(row.sha256));
      for (const sha256 of due) {
        await this.locked(ownerId, sha256, async () => {
          const still = hub.store.db.prepare(`SELECT 1 FROM hub_blobs WHERE sha256=? AND unreferenced_at IS NOT NULL AND unreferenced_at<=?
            AND NOT EXISTS (SELECT 1 FROM hub_blob_refs r WHERE r.sha256=?)`).get(sha256, at - ATTACHMENT_LIMITS.graceMs, sha256);
          if (!still) return;
          try { await this.store.delete(this.key(ownerId, sha256)); } catch { return; }
          hub.store.db.prepare("DELETE FROM hub_blobs WHERE sha256=? AND NOT EXISTS (SELECT 1 FROM hub_blob_refs WHERE sha256=?)").run(sha256, sha256);
          deletedBlobs++;
        });
      }
    }
    return { expiredUploads, deletedBlobs };
  }
}
