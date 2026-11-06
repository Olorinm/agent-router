import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceConfig, type ServiceExtension } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import { channelConfigSchema, createChannelRuntime } from "../src/service/channels.js";
import type { HostPort, HostRun } from "../src/execution/host.js";
import { ChannelTools } from "../src/communication/tools.js";
import { AgentLedger } from "../src/ledger/ledger.js";

/** ADR 0005 16.5 end to end: upload → send with attachments → the Host reads them → agent media back → redaction. */
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", other = "@bob:example.test", root = "/_agent-router/v1", enc = encodeURIComponent;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
class Host implements HostPort {
  identity = "fixture-host";
  starts: Parameters<HostPort["start"]>[0][] = [];
  runs = new Map<string, HostRun>();
  files = new Map<string, Buffer>();
  async connect() {}
  async start(input: Parameters<HostPort["start"]>[0]): Promise<HostRun> {
    this.starts.push(input);
    const run: HostRun = { id: `run-${this.starts.length}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "completed", answer: `回答-${this.starts.length}` };
    this.runs.set(run.id, run); return run;
  }
  async get(id: string) { return this.runs.get(id)!; }
  async cancel() {}
  async calls() { return []; }
  async resolve() {}
  async readFile(_sessionId: string, path: string) {
    const bytes = this.files.get(path); if (!bytes) throw new Error("file_not_found");
    return { content: bytes.toString("base64"), encoding: "base64" as const };
  }
}
function transport(agent: ManagedAgent, inbox: ApplicationInbox): MatrixTransport {
  return { identity: async () => agent.matrixId,
    sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
    state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!room:example.test",
    join: async () => {}, send: async () => "$sent", stop: () => {} };
}
async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value)}`); await new Promise((r) => setTimeout(r, 25)); }
}
async function setup(overrides: Partial<ServiceConfig> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-web-att-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const host = new Host(), extensions = new Map<string, ServiceExtension>();
  const service: ManagedService = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48), ledgerRead: true, ledgerSend: true, ledgerAttachments: true, ...overrides }, {
    authenticate: async (token) => { if (token === "alice") return owner; if (token === "bob") return other; throw new Error("bad_credentials"); },
    provision: async () => {}, transport,
    configure: async (agent, connector) => {
      const config = channelConfigSchema.parse({ agents: [{ agentId: agent.id, connections: [{ id: "matrix", kind: "matrix" }],
        host: { binding: "fixture", runtimeId: "fixture" } }] }).agents[0]!;
      const extension = await createChannelRuntime(agent, connector, config, stateDir, (name) => {
        const issued = service.issue(agent.id, name);
        return { id: issued.instance.id, validate: () => { service.instance(issued.token, agent.id); } };
      }, host, { persons: service.persons, attachments: service.attachments });
      extensions.set(agent.id, extension);
      return extension;
    } });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function api(path: string, token = "alice", method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  }
  async function upload(bytes: Buffer, type: string, name: string, token = "alice") {
    const response = await fetch(`${base}${root}/web/attachments`, { method: "POST", body: new Blob([new Uint8Array(bytes)]),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": type, "X-File-Name": `UTF-8''${enc(name)}` } });
    return { status: response.status, data: await response.json() as any };
  }
  async function download(url: string, token = "alice") {
    const response = await fetch(base + url, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()), type: response.headers.get("content-type") };
  }
  const agent = await service.create(owner, "helper");
  const ledger = AgentLedger.attached((await service.runtime(agent.id)).connector.store)!;
  const chatId = `dm:${agent.id}`;
  await api(`${root}/web/chats/dm`, "alice", "POST", { agentId: agent.id });
  const send = (body: Record<string, unknown>, token = "alice") => api(`${root}/web/chats/${enc(chatId)}/messages`, token, "POST", body);
  const events = async () => (await api(`${root}/web/chats/${enc(chatId)}/events?limit=200`)).data.events as any[];
  return { service, api, upload, download, agent, ledger, host, chatId, send, events, extension: () => extensions.get(agent.id)! };
}
const key = "01JC9Z7Q4M0000000000000001";
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);

describe("web send with attachments", () => {
  it("binds uploads to the message, renders them with URLs and hands them to the Host as media", async () => {
    const t = await setup();
    expect((await t.api(`${root}/web/me`)).data.limits.features).toMatchObject({ send: true, attachments: true });
    const image = (await t.upload(png, "image/png", "截图.png")).data, doc = (await t.upload(Buffer.from("%PDF-1"), "application/pdf", "a.pdf")).data;
    const sent = await t.send({ idempotencyKey: key, text: "看图", attachments: [image.attachmentId, doc.attachmentId] });
    expect(sent.status).toBe(200);
    expect(sent.data.event.attachments).toEqual([
      { attachmentId: image.attachmentId, name: "截图.png", contentType: "image/png", size: png.length, sha256: sha(png), url: image.url },
      { attachmentId: doc.attachmentId, name: "a.pdf", contentType: "application/pdf", size: 6, sha256: sha("%PDF-1"), url: doc.url }]);
    const rows = t.ledger.store.db.prepare("SELECT attachment_id, event_id, locator FROM ledger_attachments ORDER BY attachment_id").all();
    expect(rows).toEqual([image, doc].map((item) => ({ attachment_id: item.attachmentId, event_id: sent.data.event.eventId,
      locator: JSON.stringify({ blob: `sha256:${item.sha256}` }) })).sort((a, b) => a.attachment_id.localeCompare(b.attachment_id)));
    // The Host receives the bytes as MediaContent, like channel media, and the text lists them.
    await until(() => t.host.starts.length, (n) => n >= 1);
    const start = t.host.starts[0]!;
    expect(start.input).toContain("附件：截图.png (image/png)");
    expect(start.attachments?.map((item) => [item.name, item.mediaType, Buffer.from(item.data, "base64").toString("hex")]))
      .toEqual([["截图.png", "image/png", png.toString("hex")], ["a.pdf", "application/pdf", Buffer.from("%PDF-1").toString("hex")]]);
    // History renders the same entries; the bound upload stays downloadable through its message, never for another owner.
    expect((await t.events()).find((event) => event.eventId === sent.data.event.eventId).attachments).toEqual(sent.data.event.attachments);
    expect((await t.download(image.url)).body.equals(png)).toBe(true);
    expect((await t.download(image.url, "bob")).status).toBe(404);
    // A retry with the same key and attachments is the stored event; other attachments are a conflict; a bound upload cannot be sent twice.
    expect((await t.send({ idempotencyKey: key, text: "看图", attachments: [image.attachmentId, doc.attachmentId] })).data)
      .toMatchObject({ status: "duplicate", event: { eventId: sent.data.event.eventId } });
    expect(await t.send({ idempotencyKey: key, text: "看图", attachments: [image.attachmentId] })).toEqual({ status: 409, data: { error: "idempotency_key_reused" } });
    expect(await t.send({ idempotencyKey: `${key}2`, text: "", attachments: [image.attachmentId] })).toEqual({ status: 422, data: { error: "attachment_not_found" } });
    expect(t.service.attachments!.usage(owner)).toBe(png.length + 6);
  }, 20_000);

  it("validates attachments, accepts attachment-only messages and leaves failed sends sendable", async () => {
    const t = await setup();
    const mine = (await t.upload(Buffer.from("file"), "text/plain", "n.txt")).data, bobs = (await t.upload(Buffer.from("bob"), "text/plain", "b.txt", "bob")).data;
    expect(await t.send({ idempotencyKey: `${key}a`, text: "x", attachments: [bobs.attachmentId] })).toEqual({ status: 422, data: { error: "attachment_not_found" } });
    expect(await t.send({ idempotencyKey: `${key}b`, text: "x", attachments: [mine.attachmentId, mine.attachmentId] })).toEqual({ status: 422, data: { error: "too_many_attachments" } });
    expect((await t.send({ idempotencyKey: `${key}c`, text: "x", attachments: Array.from({ length: 11 }, () => mine.attachmentId) })).status).toBe(400);
    // A rejected send (here: an unknown reply target) pins nothing, so the upload can still be sent.
    expect(await t.send({ idempotencyKey: `${key}d`, text: "x", attachments: [mine.attachmentId], replyTo: "ev_missing" })).toEqual({ status: 422, data: { error: "reply_target_not_found" } });
    const hub = t.service.hubs.hub(owner).store.db;
    expect(hub.prepare("SELECT ref FROM hub_blob_refs").all().map((row) => row.ref)).toEqual([`upload:${mine.attachmentId}`]);
    const only = await t.send({ idempotencyKey: `${key}e`, text: "", attachments: [mine.attachmentId] });
    expect(only.data).toMatchObject({ status: "accepted", event: { text: "", attachments: [{ attachmentId: mine.attachmentId, name: "n.txt" }] } });
    expect(hub.prepare("SELECT ref FROM hub_blob_refs").all().map((row) => row.ref)).toEqual([`agent:${t.agent.id}:${mine.attachmentId}`]);
    expect(hub.prepare("SELECT bound_at FROM hub_uploads WHERE attachment_id=?").get(mine.attachmentId)!.bound_at).toEqual(expect.any(Number));
    await until(() => t.host.starts.length, (n) => n >= 1);
    expect(t.host.starts[0]!.attachments?.[0]).toMatchObject({ name: "n.txt", mediaType: "text/plain" });
  }, 20_000);

  it("stores agent media sent through the channel tool and renders it as attachments in the web chat", async () => {
    const t = await setup();
    await t.send({ idempotencyKey: key, text: "做张图" });
    const reply = await until(t.events, (events) => events.some((event) => event.text === "回答-1"));
    const turnId = reply.find((event) => event.text === "回答-1").turnId as string;
    const core = t.extension().communication!;
    expect(core.capabilities(turnId)?.send).toEqual(["text", "file", "image", "audio", "video"]);
    // A running binding for the tool call, as the Host worker records it.
    core.store.set("communication_runs", "claim-x", { runId: "run-x", taskId: turnId, sessionId: "s-1", phase: "running" });
    t.host.files.set("out/chart.png", png);
    const tools = new ChannelTools(core, t.host);
    const call = { runId: "run-x", id: "call-1", name: "channel", input: { operation: "send", text: "图来了", files: [{ path: "out/chart.png", name: "chart.png", mediaType: "image/png" }] } };
    const result = JSON.parse((await tools.execute(call as never)).contentItems[0]!.text as string);
    expect(result).toMatchObject({ state: "accepted" });
    const events = await until(t.events, (items) => items.some((event) => event.text === "图来了"));
    const media = events.find((event) => event.text === "图来了");
    expect(media).toMatchObject({ role: "assistant", turnId, channel: { kind: "web" },
      attachments: [{ name: "chart.png", contentType: "image/png", size: png.length, sha256: sha(png), url: expect.stringMatching(/^\/_agent-router\/v1\/web\/attachments\/at_/) }] });
    expect(media.media).toBeUndefined();
    expect((await t.download(media.attachments[0].url)).body.equals(png)).toBe(true);
    // The outbox row keeps no copy of the bytes, and a retried tool call stores nothing again.
    expect(JSON.stringify(core.store.entries("communication_outbox"))).not.toContain(png.toString("base64"));
    await tools.execute(call as never);
    expect(t.service.hubs.hub(owner).store.db.prepare("SELECT COUNT(*) AS n FROM hub_blob_refs").get()!.n).toBe(1);
    expect((await t.events()).filter((event) => event.text === "图来了")).toHaveLength(1);
  }, 20_000);

  it("redaction detaches the attachments, ends access and releases the blob references", async () => {
    const t = await setup();
    const image = (await t.upload(png, "image/png", "p.png")).data;
    const sent = await t.send({ idempotencyKey: key, text: "撤回带图", attachments: [image.attachmentId] });
    await until(t.events, (items) => items.some((event) => event.text === "回答-1"));
    const redacted = await t.api(`${root}/web/chats/${enc(t.chatId)}/events/${enc(sent.data.event.eventId)}/redact`, "alice", "POST", { idempotencyKey: `${key}r` });
    expect(redacted.data).toMatchObject({ status: "accepted" });
    const target = (await t.events()).find((event) => event.eventId === sent.data.event.eventId);
    expect(target).toMatchObject({ redacted: true, text: "" });
    expect(target.attachments).toBeUndefined();
    expect(t.ledger.store.db.prepare("SELECT event_id FROM ledger_attachments WHERE attachment_id=?").get(image.attachmentId)!.event_id).toBeNull();
    expect((await t.download(image.url)).status).toBe(404);
    const hub = t.service.hubs.hub(owner).store.db;
    expect(hub.prepare("SELECT COUNT(*) AS n FROM hub_blob_refs").get()!.n).toBe(0);
    expect(hub.prepare("SELECT unreferenced_at FROM hub_blobs").get()!.unreferenced_at).toEqual(expect.any(Number));
    const now = Date.now();
    expect(await t.service.attachments!.sweep(now + 7 * 86_400_000 + 1000)).toMatchObject({ deletedBlobs: 1 });
  }, 20_000);

  it("purge deletes the session's attachments and releases their blob references", async () => {
    const t = await setup({ ledgerControl: true });
    const image = (await t.upload(png, "image/png", "p.png")).data, kept = (await t.upload(Buffer.from("other"), "text/plain", "o.txt")).data;
    await t.send({ idempotencyKey: key, text: "带图", attachments: [image.attachmentId] });
    await until(t.events, (items) => items.some((event) => event.text === "回答-1"));
    const hub = t.service.hubs.hub(owner).store.db;
    const refs = () => hub.prepare("SELECT ref FROM hub_blob_refs ORDER BY ref").all().map((row) => row.ref);
    expect(refs()).toEqual([`agent:${t.agent.id}:${image.attachmentId}`, `upload:${kept.attachmentId}`]);
    const purged = await t.api(`${root}/web/chats/${enc(t.chatId)}/purge`, "alice", "POST", { idempotencyKey: `${key}p`, confirm: t.chatId });
    expect(purged).toMatchObject({ status: 200, data: { generation: 2 } });
    expect(t.ledger.store.db.prepare("SELECT COUNT(*) AS n FROM ledger_attachments").get()!.n).toBe(0);
    // Only the purged message's reference goes; an unrelated pending upload keeps its own.
    expect(refs()).toEqual([`upload:${kept.attachmentId}`]);
    expect(hub.prepare("SELECT unreferenced_at FROM hub_blobs WHERE sha256=?").get(sha(png))!.unreferenced_at).toEqual(expect.any(Number));
    expect(hub.prepare("SELECT unreferenced_at FROM hub_blobs WHERE sha256=?").get(sha("other"))!.unreferenced_at).toBeNull();
    expect((await t.download(image.url)).status).toBe(404);
    // A retry of the same purge is a stored duplicate and releases nothing twice.
    expect((await t.api(`${root}/web/chats/${enc(t.chatId)}/purge`, "alice", "POST", { idempotencyKey: `${key}p`, confirm: t.chatId })).status).toBe(200);
    expect(await t.service.attachments!.sweep(Date.now() + 7 * 86_400_000 + 1000)).toMatchObject({ deletedBlobs: 1 });
  }, 20_000);

  it("requires the send flag and keeps attachments unsupported without the attachments flag", async () => {
    const off = await setup({ ledgerAttachments: false });
    expect((await off.api(`${root}/web/me`)).data.limits.features).toMatchObject({ send: true, attachments: false });
    expect(await off.send({ idempotencyKey: key, text: "图", attachments: ["at_1"] })).toEqual({ status: 422, data: { error: "attachments_unsupported" } });
    expect(off.extension().communication!.capabilities("missing")).toBeUndefined();
    const noSend = await setup({ ledgerSend: false });
    expect(noSend.service.attachments).toBeUndefined();
    expect((await noSend.api(`${root}/web/me`)).data.limits.features).toMatchObject({ send: false, attachments: false });
  }, 20_000);
});
