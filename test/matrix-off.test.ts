import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createRouter, loadServiceConfig, type ServiceConfig } from "../src/server.js";
import type { ManagedAgent } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport, SyncBatch } from "../src/matrix/transport.js";
import { Host, until } from "./ledger-fixture.js";
import { AgentLedger } from "../src/ledger/ledger.js";
import { createBlobStore } from "../src/ledger/blobs.js";
import { exportMatrix, forgetMatrix, promoteMedia } from "../src/matrix/removal.js";

/**
 * ADR 0005 19.5: the full service (createRouter, loadServiceConfig) with `AGENT_MATRIX=off`, the edge identity as the only
 * owner login and the homeserver URL pointing at a closed port. Every owner flow works through the ledger and no request
 * ever leaves for the homeserver.
 */
const team = "https://example-team.cloudflareaccess.com", aud = "c".repeat(64), root = "/_agent-router/v1", enc = encodeURIComponent;
const owner = "@owner:example.test", origin = "https://mau.example.test";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
let counter = 0;
const ik = () => `mo${String(++counter).padStart(6, "0")}${"0".repeat(16)}`;

async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function edge() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "k1", alg: "RS256", use: "sig" };
  const server: Server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const certs = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/cdn-cgi/access/certs`);
  const token = await new SignJWT({ email: "owner@example.test", sub: "s-1", type: "app" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(team).setAudience(aud).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  return { certs, token };
}
/** Records every outbound request made through `fetch` (Matrix calls use it, directly or through matrix-js-sdk). */
function recordFetch() {
  const urls: string[] = [], original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return original(input, init);
  });
  return urls;
}

async function boot(stateDir: string, overrides: Partial<ServiceConfig> = {}, extra: { transport?: (agent: ManagedAgent, inbox: ApplicationInbox) => MatrixTransport; provision?: () => Promise<void> } = {}) {
  const homeserverPort = await closedPort(), keys = await edge();
  const edgeFile = join(stateDir, "..", `edge-${counter++}.json`);
  writeFileSync(edgeFile, JSON.stringify({ edgeIdentity: { provider: "cloudflare-access", teamDomain: team, audiences: [aud], owners: { "owner@example.test": owner } } }));
  cleanup.push(() => rmSync(edgeFile, { force: true }));
  // The operator environment of our deployment: no AS token files, no homeserver variables are needed.
  const env = { MATRIX_SERVER_NAME: "example.test", AGENT_SERVICE_URL: `${origin}/_agent-router/v1`, AGENT_SERVICE_STATE: stateDir, AGENT_MATRIX: "off",
    AGENT_LEDGER_READ: "1", AGENT_LEDGER_SEND: "1", AGENT_LEDGER_CARDS: "1", AGENT_LEDGER_CONTROL: "1", AGENT_LEDGER_GROUPS: "1",
    AGENT_LEDGER_ATTACHMENTS: "1", AGENT_LEDGER_IDENTITY: "1", AGENT_EDGE_IDENTITY_FILE: edgeFile };
  const loaded = loadServiceConfig(env);
  expect(loaded).toMatchObject({ matrix: { enabled: false } });
  expect(loaded.homeserver).toBeUndefined();
  // Even if Matrix settings are present, nothing may use them: the homeserver is a closed port.
  const config: ServiceConfig = { ...loaded, homeserver: `http://127.0.0.1:${homeserverPort}`, asToken: "a".repeat(48), hsToken: "h".repeat(48), ...overrides };
  const host = new Host();
  const router = createRouter(config, { hosts: { assertReady: () => {}, host: () => host, http: () => ({ request: async () => { throw new Error("unused"); } }) as never },
    dependencies: { edgeIdentityCerts: keys.certs, ...(extra.transport ? { transport: extra.transport } : {}), ...(extra.provision ? { provision: extra.provision } : {}) } });
  const server = router.app.listen(0, "127.0.0.1");
  server.on("upgrade", (req, socket, head) => { if (!router.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const stop = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await router.close(); };
  cleanup.push(stop);
  await router.start();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = (extra: Record<string, string> = {}) => ({ "cf-access-jwt-assertion": keys.token, Origin: origin, "Content-Type": "application/json", ...extra });
  async function api(path: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(base + path, { method, headers: headers(extraHeaders), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) as any : null };
  }
  async function upload(bytes: Buffer, type: string, name: string) {
    const response = await fetch(`${base}${root}/web/attachments`, { method: "POST", body: new Blob([new Uint8Array(bytes)]),
      headers: { ...headers({ "Content-Type": type }), "X-File-Name": `UTF-8''${enc(name)}` } });
    return { status: response.status, data: await response.json() as any };
  }
  async function download(url: string) {
    const response = await fetch(base + url, { headers: { "cf-access-jwt-assertion": keys.token } });
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  }
  const events = async (chatId: string) => (await api(`${root}/web/chats/${enc(chatId)}/events?limit=200`)).data.events as any[];
  return { router, host, api, upload, download, events, base, homeserverPort, stop };
}
async function withHost(t: Awaited<ReturnType<typeof boot>>, agent: { id: string }) {
  await t.router.connections.replaceHost(owner, agent.id, { binding: "fixture", runtimeId: "fixture", instanceName: "channel-host", instructions: "" });
}

describe("Router with AGENT_MATRIX=off (ADR 0005 phase 7)", () => {
  it("boots without a homeserver and serves DMs, cards, attachments and groups through the ledger", async () => {
    const urls = recordFetch();
    const stateDir = mkdtempSync(join(tmpdir(), "matrix-off-"));
    cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const t = await boot(stateDir);
    expect((await fetch(`${t.base}/health/live`).then((r) => r.json()))).toEqual({ status: "ok", component: "agent-service" });
    const me = (await t.api(`${root}/web/me`)).data;
    expect(me).toMatchObject({ ownerId: owner, auth: { via: "edge", email: "owner@example.test" } });
    expect(me.limits.features).toEqual({ history: true, send: true, cards: true, attachments: true, reset: true, groups: true, identity: true, matrix: false });

    // Agent creation provisions no Matrix user.
    const created = await t.api(`${root}/agents`, "POST", { name: "helper" });
    expect(created).toMatchObject({ status: 201, data: { name: "helper", status: "active", matrix: { state: "none", userId: null }, matrixId: expect.stringMatching(/^@_ar_/) } });
    const helper = created.data, writer = (await t.api(`${root}/agents`, "POST", { name: "writer" })).data;
    expect(t.router.service.store.get("matrix_agents", helper.matrixId)).toBeUndefined();
    await withHost(t, helper); await withHost(t, writer);

    // DM send and reply.
    const chatId = `dm:${helper.id}`;
    expect((await t.api(`${root}/web/chats/dm`, "POST", { agentId: helper.id })).data).toMatchObject({ chatId, readOnly: false });
    const sent = await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "你好" });
    expect(sent).toMatchObject({ status: 200, data: { status: "accepted", event: { kind: "message", text: "你好", channel: { kind: "web" } } } });
    const reply = (await until(() => t.events(chatId), (items) => items.some((event) => event.kind === "message" && event.role === "assistant")))
      .find((event) => event.role === "assistant");
    expect(reply).toMatchObject({ text: "回答-1", final: true, sender: { type: "agent", id: helper.id } });

    // A card answered through the web.
    t.host.plan = (_n, input) => input.input.includes("需要批准") ? [{ id: "a1", kind: "interaction", name: "item/commandExecution/requestApproval", input: { command: "make" } }] : [];
    await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "需要批准" });
    const card = (await until(() => t.events(chatId), (items) => items.some((event) => event.kind === "card"))).find((event) => event.kind === "card").card;
    expect(card).toMatchObject({ kind: "approval", status: "pending" });
    const answered = await t.api(`${root}/web/chats/${enc(chatId)}/cards/${enc(card.cardId)}/answer`, "POST", { idempotencyKey: ik(), choiceId: "0" });
    expect(answered).toMatchObject({ status: 200, data: { status: "accepted", card: { status: "approved" } } });
    expect(t.host.resolved).toEqual([expect.objectContaining({ callId: "a1", result: { decision: "accept" } })]);

    // An attachment: upload, send, the Host reads the bytes, the console downloads it.
    const uploaded = await t.upload(png, "image/png", "截图.png");
    expect(uploaded).toMatchObject({ status: 201, data: { attachmentId: expect.stringMatching(/^at_/) } });
    const withImage = await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "看图", attachments: [uploaded.data.attachmentId] });
    expect(withImage.data.event.attachments).toMatchObject([{ name: "截图.png", contentType: "image/png", size: png.length }]);
    const start = await until(() => t.host.starts.find((item) => item.input.includes("看图")), Boolean);
    expect(start.attachments?.map((item) => Buffer.from(item.data, "base64").equals(png))).toEqual([true]);
    expect(await t.download(withImage.data.event.attachments[0].url)).toMatchObject({ status: 200, body: png });

    // A native group: @all fans out to both agents, both reply in the room.
    const group = await t.api(`${root}/web/groups`, "POST", { idempotencyKey: ik(), title: "周报小组", agentIds: [helper.id, writer.id] });
    expect(group.status).toBe(201);
    const roomChat = group.data.chatId as string;
    const posted = await t.api(`${root}/web/chats/${enc(roomChat)}/messages`, "POST", { idempotencyKey: ik(), text: "@all 周报", mentions: { agentIds: [], all: true } });
    expect(posted.data.addressed.map((item: any) => item.state).sort()).toEqual(["queued", "queued"]);
    const room = await until(() => t.events(roomChat), (items) => items.filter((event) => event.kind === "message" && event.role === "assistant").length === 2);
    expect(new Set(room.filter((event) => event.role === "assistant").map((event) => event.agentId))).toEqual(new Set([helper.id, writer.id]));

    // Documented degradations (19.2).
    expect(await t.api("/_matrix/app/v1/ping", "POST", {})).toEqual({ status: 404, data: { error: "not_found" } });
    const bearer = await fetch(`${t.base}${root}/agents`, { headers: { Authorization: "Bearer syt_matrix_token" } });
    expect({ status: bearer.status, body: await bearer.json() }).toEqual({ status: 401, body: { error: "matrix_disabled" } });
    expect(await t.api(`${root}/agents/${helper.id}/matrix`, "PUT", { enabled: true })).toEqual({ status: 409, data: { error: "matrix_disabled" } });
    expect(await t.api(`${root}/agents/${helper.id}/connections`, "POST", { kind: "matrix" })).toEqual({ status: 409, data: { error: "matrix_disabled" } });
    expect(await t.api(`${root}/agents/${helper.id}/gateway/api/contacts`)).toEqual({ status: 409, data: { error: "matrix_disabled" } });
    expect((await t.api(`${root}/agents/${helper.id}/gateway/health/ready`)).data).toMatchObject({ status: "ready", matrix: "dormant" });
    const directory = await fetch(`${t.base}${root}/directory?address=${enc(helper.address)}`).then((r) => r.json());
    expect(directory).toMatchObject({ id: helper.id, matrixId: null });

    // Deleting needs no Synapse deactivation.
    expect((await t.api(`${root}/agents/${writer.id}`, "DELETE")).status).toBe(204);
    expect(t.router.service.store.entries("matrix_orphans")).toEqual([]);

    // Nothing ever went to the homeserver, or to any Matrix API.
    expect(urls.filter((url) => !url.startsWith(t.base) && (url.includes(`:${t.homeserverPort}`) || url.includes("/_matrix/")))).toEqual([]);
  }, 60_000);

  it("keeps an existing Matrix agent: its runtime starts dormant, its Matrix connection is kept but disabled, and delete skips deactivation", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "matrix-off-legacy-"));
    cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
    // Phase 6 state: an agent provisioned while Matrix was on, with a Matrix connection.
    const on = await boot(stateDir, { matrix: { enabled: true } }, { provision: async () => {},
      transport: (agent, inbox) => ({ identity: async () => agent.matrixId, sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
        state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!r:example.test", join: async () => {}, send: async () => "$e", stop: () => {} }) });
    const legacy = (await on.api(`${root}/agents`, "POST", { name: "legacy" })).data;
    expect(legacy.matrix).toEqual({ state: "active", userId: legacy.matrixId });
    await on.router.connections.edit(owner, legacy.id, (config) => {
      config.connections.push({ id: "matrix", kind: "matrix", ownerAddresses: [owner], peerAddresses: [], groupIds: [] });
      config.host = { binding: "fixture", runtimeId: "fixture", instanceName: "channel-host", instructions: "" };
    });
    // Strip the phase 7 field, as a record written by an older Router.
    const { matrix: _state, ...record } = on.router.service.agent(legacy.id);
    on.router.service.store.set("agents", legacy.id, record);
    await on.stop(); cleanup.splice(cleanup.indexOf(on.stop), 1);

    const urls = recordFetch();
    const t = await boot(stateDir);
    expect((await t.api(`${root}/agents/${legacy.id}`)).data.matrix).toEqual({ state: "dormant", userId: legacy.matrixId });
    const status = (await t.api(`${root}/agents/${legacy.id}/communication`)).data;
    expect(status.connections).toEqual(expect.arrayContaining([expect.objectContaining({ id: "matrix", kind: "matrix", started: false, disabled: "matrix_off" }),
      expect.objectContaining({ id: "web", started: true })]));
    const checked = await t.api(`${root}/agents/${legacy.id}/check`, "POST", {});
    expect(checked.status, JSON.stringify(checked.data)).toBe(200);
    const checks = checked.data.checks;
    expect(checks.find((check: any) => check.connectionId === "matrix")).toMatchObject({ status: "disabled" });
    const chatId = `dm:${legacy.id}`;
    await t.api(`${root}/web/chats/${enc(chatId)}/messages`, "POST", { idempotencyKey: ik(), text: "还在吗" });
    await until(() => t.events(chatId), (items) => items.some((event) => event.role === "assistant"));
    expect((await t.api(`${root}/agents/${legacy.id}`, "DELETE")).status).toBe(204);
    // The account was not deactivated: `matrix forget` lists it.
    expect(t.router.service.store.entries("matrix_orphans").map(({ id }) => id)).toEqual([legacy.matrixId]);
    expect(urls.filter((url) => !url.startsWith(t.base) && (url.includes(`:${t.homeserverPort}`) || url.includes("/_matrix/")))).toEqual([]);
  }, 60_000);
});

describe("per-agent Matrix toggle with Matrix on (19.1)", () => {
  it("switches between active and dormant and ignores Matrix events from before the new activation checkpoint", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "matrix-toggle-"));
    cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const provisioned: string[] = [];
    const t = await boot(stateDir, { matrix: { enabled: true } }, { provision: async () => { provisioned.push("register"); },
      transport: (agent, inbox) => ({ identity: async () => agent.matrixId,
        sync: async (since): Promise<SyncBatch> => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
        state: async () => [{ type: "m.room.member", event_id: "$m1", sender: owner, state_key: owner, content: { membership: "join" } },
          { type: "m.room.member", event_id: "$m2", sender: agent.matrixId, state_key: agent.matrixId, content: { membership: "join" } }],
        history: async () => ({ events: [] }), createRoom: async () => "!dm:example.test", join: async () => {}, send: async () => "$e", stop: () => {} }) });
    const agent = (await t.api(`${root}/agents`, "POST", { name: "toggle" })).data;
    await t.router.connections.edit(owner, agent.id, (config) => {
      config.connections.push({ id: "matrix", kind: "matrix", ownerAddresses: [owner], peerAddresses: [], groupIds: [] });
      config.host = { binding: "fixture", runtimeId: "fixture", instanceName: "channel-host", instructions: "" };
    });
    const service = t.router.service;
    const message = (id: string, body: string, ts: number) => ({ event_id: id, room_id: "!dm:example.test", sender: owner, type: "m.room.message", origin_server_ts: ts, content: { msgtype: "m.text", body } });
    service.inbox.receive("t0", { events: [{ event_id: "$j", room_id: "!dm:example.test", sender: agent.matrixId, type: "m.room.member", state_key: agent.matrixId, content: { membership: "join" } }] });
    expect(await t.api(`${root}/agents/${agent.id}/matrix`, "PUT", { enabled: false })).toEqual({ status: 200, data: { state: "dormant", userId: agent.matrixId } });
    expect(service.matrixEnabled(agent.id)).toBe(false);
    // While dormant: nothing is queued for the agent, and an event sent now must never run later.
    const dormantAt = Date.now(), queued = service.store.entries(`as_queue:${agent.id}`).length;
    service.inbox.receive("t1", { events: [message("$old", "离线时的消息", dormantAt)] });
    expect(service.store.entries(`as_queue:${agent.id}`).length).toBe(queued);
    expect((await t.api(`${root}/agents/${agent.id}/communication`)).data.connections).toEqual(expect.arrayContaining([expect.objectContaining({ id: "matrix", disabled: "matrix_off" })]));
    await new Promise((r) => setTimeout(r, 5));
    expect(await t.api(`${root}/agents/${agent.id}/matrix`, "PUT", { enabled: true })).toEqual({ status: 200, data: { state: "active", userId: agent.matrixId } });
    expect(provisioned.length).toBe(2); // create + re-enable (M_USER_IN_USE is fine); dormant opens make no call
    // A late delivery of the dormant-period event (homeserver retry) is dropped by the activation checkpoint.
    service.inbox.receive("t2", { events: [message("$late", "迟到的消息", dormantAt), message("$new", "新消息", Date.now() + 1000)] });
    await until(() => t.host.starts.map((item) => item.input), (inputs) => inputs.some((input) => input.includes("新消息")));
    expect(t.host.starts.some((item) => item.input.includes("迟到的消息") || item.input.includes("离线时的消息"))).toBe(false);
    expect((await t.api(`${root}/agents/${agent.id}`)).data.matrix.state).toBe("active");
  }, 60_000);
});

describe("external identity sessions without Synapse (19.2)", () => {
  it("exchanges an issuer token for an `ars_` session with no admin token and no homeserver account", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "matrix-off-ext-"));
    cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const original = globalThis.fetch, urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url === "https://issuer.example.test/userinfo") return new Response(JSON.stringify({ sub: "u-1", roles: ["member"] }), { headers: { "Content-Type": "application/json" } });
      return original(input, init);
    });
    const { ManagedService } = await import("../src/matrix/managed.js");
    const service = new ManagedService({ serverName: "example.test", publicUrl: "https://example.test/_agent-router/v1", stateDir, matrix: { enabled: false },
      externalIdentity: { providers: { issuer: { issuer: "https://issuer.example.test", userInfoUrl: "https://issuer.example.test/userinfo", subjectPath: ["sub"],
        rolesPath: ["roles"], requiredRoles: ["member"] } } } });
    cleanup.push(() => service.close());
    const session = await service.externalIdentity!.exchange("issuer", "issuer-token");
    expect(session).toMatchObject({ accessToken: expect.stringMatching(/^ars_/), owner: expect.stringMatching(/^@ext_.*:example\.test$/),
      agent: { name: "client", matrix: "none" } });
    expect(await service.authenticate(session.accessToken)).toBe(session.owner);
    await expect(service.authenticate("syt_matrix")).rejects.toMatchObject({ message: "matrix_disabled", status: 401 });
    expect(urls).toEqual(["https://issuer.example.test/userinfo"]);
  });
});

describe("Synapse removal tooling (19.4)", () => {
  it("promotes mxc:// media into the blob store idempotently, reports consistency and forgets the Matrix mirrors", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "matrix-removal-"));
    cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const t = await boot(stateDir, { matrix: { enabled: true } }, { provision: async () => {},
      transport: (agent, inbox) => ({ identity: async () => agent.matrixId,
        sync: async (since): Promise<SyncBatch> => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
        state: async () => [{ type: "m.room.member", event_id: "$m1", sender: owner, state_key: owner, content: { membership: "join" } },
          { type: "m.room.member", event_id: "$m2", sender: agent.matrixId, state_key: agent.matrixId, content: { membership: "join" } }],
        history: async () => ({ events: [] }), createRoom: async () => "!dm:example.test", join: async () => {}, send: async () => "$e", stop: () => {} }) });
    const agent = (await t.api(`${root}/agents`, "POST", { name: "media" })).data;
    await t.router.connections.edit(owner, agent.id, (config) => {
      config.connections.push({ id: "matrix", kind: "matrix", ownerAddresses: [owner], peerAddresses: [], groupIds: [] });
      config.host = { binding: "fixture", runtimeId: "fixture", instanceName: "channel-host", instructions: "" };
    });
    t.router.service.inbox.receive("j", { events: [{ event_id: "$j", room_id: "!dm:example.test", sender: agent.matrixId, type: "m.room.member", state_key: agent.matrixId, content: { membership: "join" } }] });
    t.router.service.inbox.receive("i", { events: [{ event_id: "$img", room_id: "!dm:example.test", sender: owner, type: "m.room.message", origin_server_ts: Date.now() + 1000,
      content: { msgtype: "m.image", body: "cat.png", url: "mxc://example.test/abc", info: { mimetype: "image/png", size: png.length } } }] });
    const ledger = AgentLedger.attached((await t.router.service.runtime(agent.id)).connector.store)!;
    await until(() => ledger.store.db.prepare("SELECT COUNT(*) AS n FROM ledger_attachments WHERE event_id IS NOT NULL").get()!.n, (n) => Number(n) === 1);
    await t.stop(); cleanup.splice(cleanup.indexOf(t.stop), 1);

    const store = createBlobStore(undefined, stateDir), reads: string[] = [];
    const read = () => async (uri: string) => { reads.push(uri); return png; };
    const before = await exportMatrix({ stateDir, all: true });
    expect(before.report).toMatchObject({ ready: false, blocking: { unpromotedMedia: 1 } });
    expect(await promoteMedia({ stateDir, all: true, dryRun: true, store })).toMatchObject({ remaining: 1, agents: [{ candidates: 1, promoted: 0 }] });
    const promoted = await promoteMedia({ stateDir, all: true, store, read });
    expect(promoted).toMatchObject({ dryRun: false, remaining: 0, agents: [{ agentId: agent.id, candidates: 1, promoted: 1, failed: [], remaining: 0 }] });
    expect(reads).toEqual(["mxc://example.test/abc"]);
    expect(await promoteMedia({ stateDir, all: true, store, read })).toMatchObject({ remaining: 0, agents: [{ candidates: 0, promoted: 0 }] });
    expect(reads).toHaveLength(1);

    const out = join(stateDir, "export");
    const { manifest, report } = await exportMatrix({ stateDir, all: true, out });
    expect(report.blocking.unpromotedMedia).toBe(0);
    expect(manifest.agents).toEqual([expect.objectContaining({ id: agent.id, matrixId: agent.matrixId, state: "active" })]);
    expect(manifest.rooms.find((room) => room.roomId === "!dm:example.test")).toMatchObject({ agents: [agent.id], members: [agent.matrixId, owner].sort(),
      conversations: [expect.objectContaining({ agentId: agent.id, kind: "direct" })] });
    expect(report.blocking.ownersWithoutEdgeLogin).toEqual([]);

    const dry = await forgetMatrix({ stateDir, all: true, dryRun: true });
    expect(dry.agents[0]).toMatchObject({ agentId: agent.id, previous: "active", documents: { rooms: 1, "meta.sync": 1 } });
    expect(dry.registry).toMatchObject({ matrix_agents: 1 });
    await forgetMatrix({ stateDir, all: true });
    expect(await forgetMatrix({ stateDir, all: true, dryRun: true })).toMatchObject({ agents: [{ previous: "none", documents: { rooms: 0, "meta.sync": 0 } }],
      registry: { matrix_agents: 0, as_queue: 0, as_members: 0 } });

    // The promoted attachment is served from the blob store by a Router with Matrix off.
    const off = await boot(stateDir);
    expect((await off.api(`${root}/agents/${agent.id}`)).data.matrix).toEqual({ state: "none", userId: null });
    const image = (await off.events(`dm:${agent.id}`)).find((event) => event.attachments?.length);
    expect(await off.download(image.attachments[0].url)).toMatchObject({ status: 200, body: png });
  }, 60_000);
});
