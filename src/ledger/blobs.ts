import { createReadStream, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { AwsClient } from "aws4fetch";
import { WorkError } from "../execution/work.js";

/** ADR 0005 16.5. `ownerKey = digest(ownerId)`, the same key as the owner hub file. */
export type BlobKey = { ownerKey: string; sha256: string };
export interface BlobFile { path: string; size: number; sha256: string; md5: string; contentType: string }
export interface BlobRange { start: number; end?: number | undefined }
export interface BlobBody { body: Readable; size: number; start: number; end: number }
export interface BlobStore {
  readonly kind: string;
  /** Idempotent. Bytes come from a verified temp file; the key is content-addressed. */
  put(key: BlobKey, file: BlobFile): Promise<void>;
  head(key: BlobKey): Promise<{ size: number } | null>;
  /** `end` is inclusive. A range past the end gives 416 `range_not_satisfiable`. */
  get(key: BlobKey, range?: BlobRange): Promise<BlobBody>;
  delete(key: BlobKey): Promise<void>;
}
export type BlobStoreConfig =
  | { kind: "local"; dir?: string | undefined }
  | { kind: "r2"; bucket: string; accessKeyIdFile: string; secretAccessKeyFile: string; endpoint?: string | undefined; accountId?: string | undefined };

const hex64 = /^[0-9a-f]{64}$/;
/** Object key `o/<ownerKey>/sha256/<aa>/<hex>`. Both parts are validated, so a key never leaves its owner prefix. */
export function objectKey(key: BlobKey): string {
  if (!hex64.test(key.ownerKey) || !hex64.test(key.sha256)) throw new WorkError("invalid_blob_key", 400);
  return `o/${key.ownerKey}/sha256/${key.sha256.slice(0, 2)}/${key.sha256}`;
}
/** Resolve an inclusive byte range against a known size (416 when it cannot be served). */
export function boundRange(size: number, range?: BlobRange): { start: number; end: number } {
  if (!range) return { start: 0, end: Math.max(0, size - 1) };
  const end = Math.min(range.end ?? size - 1, size - 1);
  if (!Number.isSafeInteger(range.start) || range.start < 0 || range.start >= size || end < range.start) throw new WorkError("range_not_satisfiable", 416);
  return { start: range.start, end };
}

/** `state/blobs/o/<ownerKey>/sha256/<aa>/<hex>`. Tests, development, and the default without R2. */
export class LocalBlobStore implements BlobStore {
  readonly kind = "local";
  constructor(readonly dir: string) {}
  private path(key: BlobKey) { return join(this.dir, ...objectKey(key).split("/")); }
  async put(key: BlobKey, file: BlobFile): Promise<void> {
    const target = this.path(key);
    if (await this.head(key)) return;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Atomic: copy into a temp file in the target directory, then rename over the (identical) content address.
    const temp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await copyFile(file.path, temp);
      if ((await stat(temp)).size !== file.size) throw new WorkError("blob_size_mismatch", 500);
      await rename(temp, target);
    } finally { await rm(temp, { force: true }); }
  }
  async head(key: BlobKey) {
    try { const info = await stat(this.path(key)); return info.isFile() ? { size: info.size } : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async get(key: BlobKey, range?: BlobRange): Promise<BlobBody> {
    const found = await this.head(key);
    if (!found) throw new WorkError("blob_not_found", 404);
    const { start, end } = boundRange(found.size, range);
    const body = found.size === 0 ? Readable.from([]) : createReadStream(this.path(key), { start, end });
    return { body, size: found.size, start, end };
  }
  async delete(key: BlobKey): Promise<void> { await rm(this.path(key), { force: true }); }
}

/**
 * Cloudflare R2 over its S3 API (ADR 0005 15.2.1), signed with `aws4fetch`, region `auto`, path-style
 * `<endpoint>/<bucket>/<key>`. Credentials are a bucket-scoped "Object Read & Write" token, read from files once.
 * Nothing here logs; errors carry codes and statuses only.
 */
export class R2BlobStore implements BlobStore {
  readonly kind = "r2";
  private readonly client: AwsClient;
  private readonly base: string;
  constructor(options: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; timeoutMs?: number },
    private readonly timeoutMs = options.timeoutMs ?? 60_000) {
    const url = new URL(options.endpoint);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("invalid_r2_endpoint");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error("invalid_r2_bucket");
    if (!options.accessKeyId || !options.secretAccessKey) throw new Error("r2_credentials_required");
    this.client = new AwsClient({ accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, service: "s3", region: "auto", retries: 2 });
    this.base = `${url.origin}/${options.bucket}/`;
  }
  private async request(key: BlobKey, method: string, headers: Record<string, string> = {}, body?: Uint8Array) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.client.fetch(this.base + objectKey(key), { method, headers, ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}), signal: controller.signal, redirect: "error" });
    } catch { throw new WorkError("blob_store_unavailable", 503); }
    finally { clearTimeout(timer); }
  }
  async put(key: BlobKey, file: BlobFile): Promise<void> {
    const bytes = await readFile(file.path);
    if (bytes.length !== file.size) throw new WorkError("blob_size_mismatch", 500);
    // R2 verifies Content-MD5; If-None-Match:* makes the write create-once (412 means the object already exists).
    const response = await this.request(key, "PUT", { "Content-Type": file.contentType, "Content-MD5": Buffer.from(file.md5, "hex").toString("base64"),
      "If-None-Match": "*", "X-Amz-Content-Sha256": file.sha256 }, bytes);
    await response.body?.cancel();
    if (!response.ok && response.status !== 412) throw new WorkError(response.status === 400 ? "blob_integrity_rejected" : "blob_store_unavailable", 503);
  }
  async head(key: BlobKey) {
    const response = await this.request(key, "HEAD");
    if (response.status === 404) return null;
    if (!response.ok) throw new WorkError("blob_store_unavailable", 503);
    return { size: Number(response.headers.get("content-length") ?? 0) };
  }
  async get(key: BlobKey, range?: BlobRange): Promise<BlobBody> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.client.fetch(this.base + objectKey(key), { method: "GET", signal: controller.signal, redirect: "error",
        headers: range ? { Range: `bytes=${range.start}-${range.end ?? ""}` } : {} });
    } catch { clearTimeout(timer); throw new WorkError("blob_store_unavailable", 503); }
    // The timeout covers the response headers; the body streams for as long as the client reads it.
    clearTimeout(timer);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 404) throw new WorkError("blob_not_found", 404);
      if (response.status === 416) throw new WorkError("range_not_satisfiable", 416);
      throw new WorkError("blob_store_unavailable", 503);
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    const span = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    const start = span ? Number(span[1]) : 0, end = span ? Number(span[2]) : Math.max(0, length - 1), size = span ? Number(span[3]) : length;
    return { body: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), size, start, end };
  }
  async delete(key: BlobKey): Promise<void> {
    const response = await this.request(key, "DELETE");
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw new WorkError("blob_store_unavailable", 503);
  }
}

function secretFile(path: string): string {
  let value = "";
  try { value = readFileSync(path, "utf8").trim(); } catch { /* reported below without the content */ }
  if (!value) throw new Error("r2_credentials_unreadable");
  return value;
}
/** Build the configured store. Without configuration: `LocalBlobStore` under `<stateDir>/blobs`. */
export function createBlobStore(config: BlobStoreConfig | undefined, stateDir: string): BlobStore {
  if (!config || config.kind === "local") return new LocalBlobStore(resolve(config?.dir ?? join(stateDir, "blobs")));
  const endpoint = config.endpoint ?? (config.accountId && /^[a-f0-9]{32}$/.test(config.accountId) ? `https://${config.accountId}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint) throw new Error("r2_endpoint_required");
  return new R2BlobStore({ endpoint, bucket: config.bucket, accessKeyId: secretFile(config.accessKeyIdFile), secretAccessKey: secretFile(config.secretAccessKeyFile) });
}
/**
 * Environment (ADR 16.5): `AGENT_LEDGER_ATTACHMENTS=1`, `AGENT_BLOB_STORE=local|r2`, `AGENT_BLOB_DIR`,
 * `AGENT_R2_ENDPOINT` or `AGENT_R2_ACCOUNT_ID`, `AGENT_R2_BUCKET`, `AGENT_R2_ACCESS_KEY_ID_FILE`,
 * `AGENT_R2_SECRET_ACCESS_KEY_FILE`, `AGENT_ATTACHMENT_QUOTA_BYTES`.
 */
export function blobConfigFromEnv(env: NodeJS.ProcessEnv): { ledgerAttachments?: true; blobStore?: BlobStoreConfig; attachmentQuotaBytes?: number } {
  const required = (key: string) => { const value = env[key]; if (!value) throw new Error(`${key}_required`); return value; };
  const kind = env.AGENT_BLOB_STORE ?? "local";
  if (kind !== "local" && kind !== "r2") throw new Error("invalid_AGENT_BLOB_STORE");
  const blobStore: BlobStoreConfig | undefined = kind === "r2" ? { kind: "r2", bucket: required("AGENT_R2_BUCKET"),
    accessKeyIdFile: required("AGENT_R2_ACCESS_KEY_ID_FILE"), secretAccessKeyFile: required("AGENT_R2_SECRET_ACCESS_KEY_FILE"),
    ...(env.AGENT_R2_ENDPOINT ? { endpoint: env.AGENT_R2_ENDPOINT } : {}), ...(env.AGENT_R2_ACCOUNT_ID ? { accountId: env.AGENT_R2_ACCOUNT_ID } : {}) }
    : env.AGENT_BLOB_DIR ? { kind: "local", dir: env.AGENT_BLOB_DIR } : undefined;
  const quota = env.AGENT_ATTACHMENT_QUOTA_BYTES ? Number(env.AGENT_ATTACHMENT_QUOTA_BYTES) : undefined;
  if (quota !== undefined && !(Number.isSafeInteger(quota) && quota > 0)) throw new Error("invalid_AGENT_ATTACHMENT_QUOTA_BYTES");
  return { ...(["1", "true"].includes(env.AGENT_LEDGER_ATTACHMENTS ?? "") ? { ledgerAttachments: true as const } : {}),
    ...(blobStore ? { blobStore } : {}), ...(quota ? { attachmentQuotaBytes: quota } : {}) };
}
