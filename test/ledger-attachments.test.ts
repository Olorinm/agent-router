import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceConfig } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import { CommunicationCore } from "../src/communication/core.js";
import type { AttachmentReference, ChannelAdapter, ChannelContext, ChannelMessage, ReplyRoute } from "../src/communication/types.js";
import { AgentLedger } from "../src/ledger/ledger.js";
import { personId } from "../src/ledger/registry.js";
import { LocalBlobStore, R2BlobStore, objectKey } from "../src/ledger/blobs.js";
import { digest } from "../src/execution/protocol.js";
import { fileName, parseRange } from "../src/ledger/blobs-web.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", other = "@bob:example.test", root = "/_agent-router/v1";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };

class Adapter implements ChannelAdapter {
  readonly kind = "feishu"; readonly retrySafe = true; context!: ChannelContext; reads = 0;
  constructor(private readonly files: Record<string, Buffer>) {}
  async start(context: ChannelContext) { this.context = context; }
  async stop() {}
  async send(_route: ReplyRoute, _text: string, key: string) { return { externalId: `sent-${key}` }; }
  async readAttachment(_message: ChannelMessage, attachment: AttachmentReference) {
    this.reads++; const bytes = this.files[attachment.id];
    if (!bytes) throw new Error("gone");
    return { name: attachment.name, mediaType: attachment.mediaType, data: bytes.toString("base64") };
  }
}
function transport(agent: ManagedAgent, inbox: ApplicationInbox): MatrixTransport {
  return { identity: async () => agent.matrixId,
    sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
    state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!room:example.test",
    join: async () => {}, send: async () => "$sent", stop: () => {} };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A minimal S3 endpoint: path-style objects, conditional create, Content-MD5, Range. Records every request. */
interface S3Request { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer }
async function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string }>(), requests: S3Request[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks), path = decodeURIComponent(new URL(req.url!, "http://s3").pathname);
      requests.push({ method: req.method!, url: path, headers: req.headers, body });
      if (!/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/.test(req.headers.authorization ?? "")
        || !req.headers["x-amz-date"] || !req.headers["x-amz-content-sha256"]) { res.writeHead(403).end(); return; }
      const object = objects.get(path);
      if (req.method === "PUT") {
        if (req.headers["content-md5"] !== createHash("md5").update(body).digest("base64")) { res.writeHead(400).end("BadDigest"); return; }
        if (req.headers["x-amz-content-sha256"] !== sha(body)) { res.writeHead(400).end("XAmzContentSHA256Mismatch"); return; }
        if (req.headers["if-none-match"] === "*" && object) { res.writeHead(412).end(); return; }
        objects.set(path, { body, type: String(req.headers["content-type"]) }); res.writeHead(200).end(); return;
      }
      if (req.method === "DELETE") { objects.delete(path); res.writeHead(204).end(); return; }
      if (!object) { res.writeHead(404).end(); return; }
      if (req.method === "HEAD") { res.writeHead(200, { "Content-Length": object.body.length }).end(); return; }
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
      if (range) {
        const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : object.body.length - 1, object.body.length - 1);
        if (start >= object.body.length) { res.writeHead(416).end(); return; }
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${object.body.length}`, "Content-Length": end - start + 1 }).end(object.body.subarray(start, end + 1)); return;
      }
      res.writeHead(200, { "Content-Length": object.body.length }).end(object.body);
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { objects, requests, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function setup(store: "local" | "r2", overrides: Partial<ServiceConfig> = {}) {
  const stateDir = temp("ledger-att-");
  const s3 = store === "r2" ? await fakeS3() : undefined;
  let blobStore: ServiceConfig["blobStore"];
  if (s3) {
    const keys = temp("r2-keys-");
    writeFileSync(join(keys, "id"), "AKIDTEST\n"); writeFileSync(join(keys, "secret"), "s3cr3t-value-never-sent\n");
    blobStore = { kind: "r2", endpoint: s3.endpoint, bucket: "agent-router-blobs", accessKeyIdFile: join(keys, "id"), secretAccessKeyFile: join(keys, "secret") };
  }
  const files: Record<string, Buffer> = {}, adapters = new Map<string, Adapter>(), cores = new Map<string, CommunicationCore>();
  const service = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48), ledgerRead: true, ledgerSend: true, ledgerAttachments: true, ...(blobStore ? { blobStore } : {}), ...overrides }, {
    authenticate: async (token) => { if (token === "alice") return owner; if (token === "bob") return other; throw new Error("bad_credentials"); },
    provision: async () => {}, transport,
    configure: async (agent, connector) => {
      const core = new CommunicationCore(agent.id, connector.store, connector.cli!), adapter = new Adapter(files);
      core.ownerPersonId = personId(agent.owner);
      core.register({ id: "feishu", ownerAddresses: ["ou_owner"] }, adapter);
      cores.set(agent.id, core); adapters.set(agent.id, adapter);
      return { start: () => core.start(), stop: () => core.stop(), status: () => ({}), resolve: async () => {}, reconcile: async () => {}, closeUnknown: async () => {},
        readAttachment: (inputId, reference) => core.readStoredAttachment(inputId, reference) };
    } });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port;
  /** Raw HTTP so tests control Content-Length and Transfer-Encoding exactly. */
  function http(path: string, options: { token?: string; method?: string; headers?: Record<string, string>; body?: Buffer | Buffer[]; noBody?: boolean } = {}) {
    return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: root + path, method: options.method ?? "GET",
        headers: { Authorization: `Bearer ${options.token ?? "alice"}`, ...options.headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => { const body = Buffer.concat(chunks); let json; try { json = JSON.parse(body.toString()); } catch { json = undefined; } resolve({ status: res.statusCode!, headers: res.headers, body, json }); });
      });
      req.on("error", reject);
      if (Array.isArray(options.body)) for (const chunk of options.body) req.write(chunk);
      else if (options.body) req.write(options.body);
      if (!options.noBody) req.end();
      else { req.flushHeaders(); setTimeout(() => req.destroy(), 2000); }
    });
  }
  const upload = (bytes: Buffer, headers: Record<string, string> = {}, token = "alice") => http("/web/attachments", { method: "POST", token,
    headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length), ...headers }, body: bytes });
  const agent = await service.create(owner, "helper");
  const ledger = AgentLedger.attached((await service.runtime(agent.id)).connector.store)!;
  return { service, http, upload, agent, ledger, core: cores.get(agent.id)!, adapter: adapters.get(agent.id)!, files, s3, stateDir };
}
const objectCount = (t: Awaited<ReturnType<typeof setup>>) => t.s3 ? t.s3.objects.size
  : (function walk(dir: string): number { try { return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? walk(join(dir, e.name)) : 1), 0); } catch { return 0; } })(join(t.stateDir, "blobs"));

describe.each(["local", "r2"] as const)("attachments over the %s blob store", (kind) => {
  it("uploads, dedupes per owner and serves same-origin downloads with Range and safe headers", async () => {
    const t = await setup(kind), png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
    const me = await t.http("/web/me");
    expect(me.json.limits).toMatchObject({ attachmentBytes: 25 * 1024 * 1024, attachmentQuotaBytes: 5 * 1024 ** 3, features: { attachments: true } });
    const first = await t.upload(png, { "X-File-Name": "UTF-8''%E6%88%AA%E5%9B%BE.png", "X-Sha256": sha(png) });
    expect(first.status).toBe(201);
    expect(first.json).toEqual({ attachmentId: expect.stringMatching(/^at_[0-9A-Z]{26}$/), name: "截图.png", contentType: "image/png", size: png.length,
      sha256: sha(png), url: `/_agent-router/v1/web/attachments/${first.json.attachmentId}` });
    const again = await t.upload(png);
    expect(again.status).toBe(201); expect(again.json.attachmentId).not.toBe(first.json.attachmentId); expect(again.json.name).toBe("attachment");
    expect(objectCount(t)).toBe(1);
    // Another owner's identical file is a separate object under that owner's prefix.
    expect((await t.upload(png, {}, "bob")).status).toBe(201);
    expect(objectCount(t)).toBe(2);
    if (t.s3) expect([...t.s3.objects.keys()].sort()).toEqual([`/agent-router-blobs/${objectKey({ ownerKey: digest(owner), sha256: sha(png) })}`,
      `/agent-router-blobs/${objectKey({ ownerKey: digest(other), sha256: sha(png) })}`].sort());

    const full = await t.http(first.json.url.slice(root.length));
    expect(full.status).toBe(200); expect(full.body.equals(png)).toBe(true);
    expect(full.headers).toMatchObject({ "content-type": "image/png", "content-disposition": "inline; filename*=UTF-8''%E6%88%AA%E5%9B%BE.png",
      "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'",
      "accept-ranges": "bytes", etag: `"sha256:${sha(png)}"` });
    const part = await t.http(first.json.url.slice(root.length), { headers: { Range: "bytes=2-4" } });
    expect(part.status).toBe(206); expect(part.headers["content-range"]).toBe(`bytes 2-4/${png.length}`); expect(part.body.equals(png.subarray(2, 5))).toBe(true);
    const suffix = await t.http(first.json.url.slice(root.length), { headers: { Range: "bytes=-3" } });
    expect(suffix.status).toBe(206); expect(suffix.body.toString()).toBe("els");
    const bad = await t.http(first.json.url.slice(root.length), { headers: { Range: "bytes=999-" } });
    expect(bad.status).toBe(416); expect(bad.headers["content-range"]).toBe(`bytes */${png.length}`);
    // Owner isolation: another owner (and an unknown id) get 404.
    expect((await t.http(first.json.url.slice(root.length), { token: "bob" })).json).toEqual({ error: "attachment_not_found" });
    expect((await t.http("/web/attachments/at_00000000000000000000000000")).status).toBe(404);

    const html = Buffer.from("<script>alert(1)</script>");
    const page = await t.upload(html, { "Content-Type": "text/html; charset=utf-8", "X-File-Name": "x.html" });
    const served = await t.http(page.json.url.slice(root.length));
    expect(served.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''x.html");
    expect(served.headers["content-type"]).toBe("text/html");
    // A JSON file is a raw upload too (the service JSON parser skips this route).
    const json = await t.upload(Buffer.from('{"a":1}'), { "Content-Type": "application/json" });
    expect(json.status).toBe(201); expect((await t.http(json.json.url.slice(root.length))).body.toString()).toBe('{"a":1}');
  });

  it("rejects missing lengths, oversize bodies, sha mismatches and uploads over quota", async () => {
    const t = await setup(kind, { attachmentQuotaBytes: 10 });
    expect((await t.http("/web/attachments", { method: "POST", headers: { "Transfer-Encoding": "chunked" }, body: [Buffer.from("abc")] })).json)
      .toEqual({ error: "content_length_required" });
    expect((await t.http("/web/attachments", { method: "POST", headers: { "Content-Length": String(25 * 1024 * 1024 + 1) }, noBody: true })).status).toBe(413);
    const mismatch = await t.upload(Buffer.from("abcd"), { "X-Sha256": sha("other") });
    expect([mismatch.status, mismatch.json.error]).toEqual([422, "sha256_mismatch"]);
    expect((await t.upload(Buffer.from("12345678"))).status).toBe(201);
    const over = await t.upload(Buffer.from("abcdefgh"));
    expect([over.status, over.json.error]).toEqual([413, "attachment_quota_exceeded"]);
    // Dedupe does not count again.
    expect((await t.upload(Buffer.from("12345678"), { "X-Sha256": sha("12345678") })).status).toBe(201);
    expect(t.service.attachments!.usage(owner)).toBe(8);
    expect(objectCount(t)).toBe(1);
  });

  it("promotes channel attachments lazily and sweeps released blobs after the grace period", async () => {
    const t = await setup(kind), bytes = Buffer.from("feishu-file-bytes");
    t.files.file_1 = bytes;
    t.core.receive("feishu", { externalId: "m1", sender: "ou_owner", scope: "direct", threadId: "oc_chat", text: "see file",
      attachments: [{ id: "file_1", name: "report.pdf", mediaType: "application/pdf", kind: "file" }], reply: { target: "oc_chat", messageId: "m1", data: {} } });
    await tick();
    const history = await t.http(`/web/chats/${encodeURIComponent(`dm:${t.agent.id}`)}/events`);
    const item = history.json.events.find((event: any) => event.kind === "message").attachments[0];
    expect(item).toMatchObject({ name: "report.pdf", contentType: "application/pdf", url: expect.stringMatching(/^\/_agent-router\/v1\/web\/attachments\/at_/) });
    const first = await t.http(item.url.slice(root.length));
    expect(first.status).toBe(200); expect(first.body.equals(bytes)).toBe(true);
    expect(first.headers["content-disposition"]).toBe("inline; filename*=UTF-8''report.pdf");
    const row = t.ledger.store.db.prepare("SELECT * FROM ledger_attachments WHERE attachment_id=?").get(item.attachmentId)!;
    expect([row.sha256, row.size, JSON.parse(String(row.locator))]).toEqual([sha(bytes), bytes.length, { blob: `sha256:${sha(bytes)}` }]);
    delete t.files.file_1;
    expect((await t.http(item.url.slice(root.length))).body.equals(bytes)).toBe(true);
    expect(t.adapter.reads).toBe(1);
    expect((await t.http(item.url.slice(root.length), { token: "bob" })).status).toBe(404);

    // Redaction releases the agent reference; the blob survives the 7-day grace period and is then deleted.
    const attachments = t.service.attachments!, now = Date.now();
    attachments.releaseAgent(owner, t.agent.id, [item.attachmentId], now);
    expect(await attachments.sweep(now + 6 * 86_400_000)).toEqual({ expiredUploads: 0, deletedBlobs: 0 });
    expect(objectCount(t)).toBe(1);
    expect(await attachments.sweep(now + 7 * 86_400_000 + 1)).toEqual({ expiredUploads: 0, deletedBlobs: 1 });
    expect(objectCount(t)).toBe(0);
    expect(attachments.usage(owner)).toBe(0);
  });

  it("streams a multi-megabyte upload and download", async () => {
    const t = await setup(kind), big = randomBytes(3 * 1024 * 1024 + 17);
    const sent = await t.http("/web/attachments", { method: "POST", headers: { "Content-Type": "application/zip", "Content-Length": String(big.length) },
      body: Array.from({ length: 4 }, (_, i) => big.subarray(i * 800_000, i === 3 ? big.length : (i + 1) * 800_000)) });
    expect([sent.status, sent.json.sha256]).toEqual([201, sha(big)]);
    const back = await t.http(sent.json.url.slice(root.length));
    expect(back.body.equals(big)).toBe(true);
    expect(back.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''attachment");
  });

  it("binds uploads to a message for the send path and expires unbound uploads", async () => {
    const t = await setup(kind), attachments = t.service.attachments!, alice = { ownerId: owner, personId: personId(owner) };
    const sent = (await t.upload(Buffer.from("sent-file"), { "X-File-Name": "a.png" })).json, left = (await t.upload(Buffer.from("left-file"))).json;
    expect(() => attachments.reserve({ ownerId: other, personId: personId(other) }, [sent.attachmentId], { agentId: t.agent.id })).toThrow("attachment_not_found");
    expect(() => attachments.reserve(alice, ["at_00000000000000000000000000"], { agentId: t.agent.id })).toThrow("attachment_not_found");
    const items = attachments.reserve(alice, [sent.attachmentId], { agentId: t.agent.id });
    expect(items).toEqual([{ attachmentId: sent.attachmentId, name: "a.png", contentType: "image/png", size: 9, sha256: sha("sent-file") }]);
    const session = `c-${digest(["x"]).slice(0, 8)}`;
    t.ledger.store.transaction(() => {
      t.ledger.ensureSession(session, "owner_main", "owner-main");
      const { event } = t.ledger.append(session, { kind: "message", role: "user", senderType: "person", senderId: alice.personId, body: { text: "hi", attachments: items } });
      attachments.writeLedger(t.ledger, items, event.eventId);
    });
    attachments.commit(alice, [sent.attachmentId]);
    expect(() => attachments.reserve(alice, [sent.attachmentId], { agentId: t.agent.id })).toThrow("attachment_not_found");
    expect((await t.http(sent.url.slice(root.length))).body.toString()).toBe("sent-file");

    const now = Date.now();
    expect(await attachments.sweep(now + 25 * 3_600_000)).toEqual({ expiredUploads: 1, deletedBlobs: 0 });
    expect(await attachments.sweep(now + 25 * 3_600_000 + 7 * 86_400_000)).toEqual({ expiredUploads: 0, deletedBlobs: 1 });
    expect((await t.http(left.url.slice(root.length))).status).toBe(404);
    // The bound one is referenced by its message and stays.
    expect(objectCount(t)).toBe(1);
    expect((await t.http(sent.url.slice(root.length))).status).toBe(200);
    const media = await attachments.readMedia(owner, items[0]!);
    expect(Buffer.from(media.data, "base64").toString()).toBe("sent-file");
  });
});

describe("attachments", () => {
  it("is off without the flag", async () => {
    const t = await setup("local", { ledgerAttachments: false });
    expect((await t.http("/web/me")).json.limits.features.attachments).toBe(false);
    expect((await t.upload(Buffer.from("x"))).json).toEqual({ error: "attachments_disabled" });
  });
  it("signs R2 requests with SigV4 and sends create-once PUTs with Content-MD5, never the secret", async () => {
    const s3 = await fakeS3(), dir = temp("r2-file-");
    const store = new R2BlobStore({ endpoint: s3.endpoint, bucket: "agent-router-blobs", accessKeyId: "AKIDTEST", secretAccessKey: "s3cr3t-value-never-sent" });
    const bytes = Buffer.from("hello r2"), path = join(dir, "f"), key = { ownerKey: digest(owner), sha256: sha(bytes) };
    writeFileSync(path, bytes);
    const file = { path, size: bytes.length, sha256: sha(bytes), md5: createHash("md5").update(bytes).digest("hex"), contentType: "text/plain" };
    await store.put(key, file);
    await store.put(key, file); // 412 from If-None-Match: * is success
    const puts = s3.requests.filter((item) => item.method === "PUT");
    expect(puts.map((item) => s3.objects.has(item.url))).toEqual([true, true]);
    for (const put of puts) expect(put.headers).toMatchObject({ "if-none-match": "*", "content-md5": createHash("md5").update(bytes).digest("base64"),
      "x-amz-content-sha256": sha(bytes), "content-type": "text/plain", authorization: expect.stringMatching(/SignedHeaders=[^,]*content-md5[^,]*if-none-match/) });
    expect(await store.head(key)).toEqual({ size: bytes.length });
    const range = await store.get(key, { start: 6 });
    expect([range.start, range.end, range.size]).toEqual([6, 7, 8]);
    let text = ""; for await (const chunk of range.body) text += chunk; expect(text).toBe("r2");
    await store.delete(key);
    expect(await store.head(key)).toBeNull();
    await expect(store.get(key)).rejects.toThrow("blob_not_found");
    for (const item of s3.requests) expect(JSON.stringify(item.headers)).not.toContain("s3cr3t");
    expect(() => new R2BlobStore({ endpoint: "http://r2.example.com", bucket: "b-1", accessKeyId: "a", secretAccessKey: "b" })).toThrow("invalid_r2_endpoint");
  });
  it("stores atomically on local disk and parses names and ranges", async () => {
    const dir = temp("local-blobs-"), store = new LocalBlobStore(dir), bytes = Buffer.from("local"), path = join(dir, "src");
    writeFileSync(path, bytes);
    const key = { ownerKey: digest(owner), sha256: sha(bytes) };
    await store.put(key, { path, size: 5, sha256: sha(bytes), md5: "", contentType: "text/plain" });
    await store.put(key, { path, size: 5, sha256: sha(bytes), md5: "", contentType: "text/plain" });
    expect(readdirSync(join(dir, "o", digest(owner), "sha256", sha(bytes).slice(0, 2)))).toEqual([sha(bytes)]);
    await expect(store.get(key, { start: 5 })).rejects.toThrow("range_not_satisfiable");
    expect(() => objectKey({ ownerKey: "../x", sha256: sha(bytes) })).toThrow("invalid_blob_key");
    expect(fileName("a/b\\c\u0001.txt")).toBe("a_b_c_.txt");
    expect(fileName(undefined)).toBe("attachment");
    expect(Buffer.byteLength(fileName(`UTF-8''${encodeURIComponent("图".repeat(100))}`))).toBeLessThanOrEqual(200);
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0 });
    expect(parseRange("bytes=-4", 10)).toEqual({ start: 6 });
    expect(parseRange("bytes=1-2,4-5", 10)).toBeUndefined();
  });
});
