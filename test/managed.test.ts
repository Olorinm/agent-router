import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceConfig } from "../src/matrix/managed.js";
import { ApplicationInbox } from "../src/matrix/application-service.js";
import { ConnectorStore } from "../src/matrix/store.js";
import { CliWork } from "../src/matrix/cli-work.js";
import { REQUEST_EVENT, type RoomEvent } from "../src/matrix/protocol.js";
import type { MatrixTransport } from "../src/matrix/transport.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", other = "@bob:example.test";
function config() {
  const stateDir = mkdtempSync(join(tmpdir(), "managed-router-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  return { serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48) };
}
function transport(agent: ManagedAgent, inbox: ApplicationInbox): MatrixTransport {
  return { identity: async () => agent.matrixId,
    sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
    state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!room:example.test",
    join: async () => {}, send: async () => "$sent", stop: () => {},
  };
}
async function setup(overrides: Partial<ServiceConfig> = {}) {
  const cfg = { ...config(), ...overrides };
  const service = new ManagedService(cfg, { authenticate: async (token) => {
    if (token === "alice") return owner;
    if (token === "bob") return other;
    throw new Error("bad_credentials");
  }, provision: async () => {}, transport });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function api(path: string, token = "alice", method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() as any };
  }
  return { service, api, cfg, base };
}
const root = "/_agent-router/v1";
const request = (text: string, contextId?: string) => SendMessageRequest.fromJSON({
  message: { messageId: crypto.randomUUID(), parts: [{ text }], role: "ROLE_USER", contextId },
});

describe("managed accounts, Agents and instances", () => {
  it("limits the owner and worker gateway before auth and ignores untrusted forwarded IPs", async () => {
    const { service, api, cfg, base } = await setup();
    const agent = await service.create(owner, "coder");
    for (let i = 0; i < 1200; i++) expect((await api(`${root}/agents`)).status).toBe(200);
    expect((await api(`${root}/agents/${agent.id}/gateway/api/status`, "invalid")).status).toBe(429);
    const forged = await fetch(`${base}${root}/agents`, { headers: { Authorization: "Bearer bob", "X-Forwarded-For": "198.51.100.2" } });
    expect(forged.status).toBe(429);
    expect((await api("/health/live")).status).toBe(200);
    expect((await api("/_matrix/app/v1/ping", cfg.hsToken, "POST", {})).status).toBe(200);
  });
  it("uses separate client buckets only behind an explicitly trusted proxy", async () => {
    const { base } = await setup({ trustedProxies: ["loopback"] });
    const exchange = (ip: string) => fetch(`${base}${root}/auth/exchange`, { method: "POST", headers: { "X-Forwarded-For": ip } });
    for (let i = 0; i < 30; i++) expect((await exchange("198.51.100.1")).status).toBe(503);
    expect((await exchange("198.51.100.1")).status).toBe(429);
    expect((await exchange("198.51.100.2")).status).toBe(503);
  });
  it("limits credential exchanges separately while leaving ordinary requests available", async () => {
    const { api } = await setup();
    for (let i = 0; i < 30; i++) expect((await api(`${root}/auth/exchange`, "", "POST", { provider: "disabled", accessToken: "invalid" })).status).toBe(503);
    const blocked = await api(`${root}/auth/exchange`, "", "POST", { provider: "disabled", accessToken: "invalid" });
    expect(blocked.status).toBe(429);
    expect(blocked.data.error).toBe("rate_limit_exceeded");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await api(`${root}/agents`)).status).toBe(200);
  });
  it("creates two passwordless Agent identities under one owner and enforces account boundaries", async () => {
    const { service, api } = await setup();
    const a = await api(`${root}/agents`, "alice", "POST", { name: "coder" });
    const b = await api(`${root}/agents`, "alice", "POST", { name: "researcher" });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    expect(a.data.owner).toBe(owner); expect(a.data.matrixId).not.toBe(b.data.matrixId);
    expect(a.data.address).toBe("alice/coder@example.test");
    expect((await api(`${root}/agents`, "alice", "POST", { name: "coder" })).data.id).toBe(a.data.id);
    expect((await api(`${root}/agents`, "bob")).data.data).toHaveLength(0);
    expect((await api(`${root}/agents/${a.data.id}/instances`, "bob", "POST", { name: "stolen" })).status).toBe(404);
    expect((await api(`${root}/agents/${a.data.id}/gateway/api/status`, "bob")).status).toBe(404);
    expect(service.agents()).toHaveLength(2);
  });
  it("scopes, rotates and revokes instance credentials without exposing the AS credential or giving management access", async () => {
    const { service, api, cfg } = await setup();
    const a = await service.create(owner, "coder"), b = await service.create(owner, "researcher");
    const issued = await api(`${root}/agents/${a.id}/instances`, "alice", "POST", { name: "laptop" });
    const token = issued.data.token as string;
    expect(token).toMatch(/^ari_/);
    expect(JSON.stringify(issued.data)).not.toContain(cfg.asToken);
    expect((await api(`${root}/agents/${a.id}/gateway/api/status`, token)).status).toBe(200);
    expect((await api(`${root}/agents/${b.id}/gateway/api/status`, token)).status).toBe(401);
    expect((await api(`${root}/agents`, token)).status).toBe(401);
    expect((await api(`${root}/agents/${a.id}/gateway/api/contacts`, token, "POST", {})).status).toBe(403);
    const listed = await api(`${root}/agents/${a.id}/instances`);
    expect(JSON.stringify(listed.data)).not.toContain(token); expect(JSON.stringify(listed.data)).not.toContain("tokenHash");
    const rotated = await api(`${root}/agents/${a.id}/instances`, "alice", "POST", { name: "laptop" });
    expect(rotated.data.instance.id).toBe(issued.data.instance.id);
    expect((await api(`${root}/agents/${a.id}/gateway/api/status`, token)).status).toBe(401);
    expect((await api(`${root}/agents/${a.id}/gateway/api/status`, rotated.data.token)).status).toBe(200);
    expect((await api(`${root}/agents/${a.id}/instances/${issued.data.instance.id}`, "alice", "DELETE")).status).toBe(204);
    expect((await api(`${root}/agents/${a.id}/gateway/api/status`, rotated.data.token)).status).toBe(401);
  });
  it("binds claims to the authenticated instance, prevents stolen claim updates and keeps a context on its instance", async () => {
    const { service, api } = await setup();
    const agent = await service.create(owner, "coder");
    const one = service.issue(agent.id, "one"), two = service.issue(agent.id, "two");
    const { connector } = await service.runtime(agent.id);
    const source = { sender: owner, room: "!room:example.test", approved: true };
    const first = await connector.cli!.send(request("remember", "context"), source);
    const path = `${root}/agents/${agent.id}/gateway`;
    const claim = await api(`${path}/api/work/claim`, one.token, "POST", { worker: "spoofed" });
    expect(claim.data.worker).toBe(one.instance.id);
    expect((await api(`${path}/api/work/claim`, two.token, "POST", { worker: one.instance.id })).data).toBeNull();
    expect((await api(`${path}/api/work/${claim.data.claimId}/update`, two.token, "POST", { action: "reply", text: "stolen" })).status).toBe(403);
    expect((await api(`${path}/api/work/${claim.data.claimId}/update`, one.token, "POST", { action: "reply", text: "done" })).status).toBe(200);
    expect((await connector.cli!.get(first.id)).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    await connector.cli!.send(request("continue", "context"), source);
    await connector.cli!.send(request("independent", "other-context"), source);
    const next = await api(`${path}/api/work/claim`, two.token, "POST", { worker: "two" });
    expect(next.data.contextId).toBe("other-context");
    expect((await api(`${path}/api/work/claim`, one.token, "POST", { worker: "one" })).data.contextId).toBe("context");
  });
  it("validates HS authentication and durably deduplicates AS transactions before execution", async () => {
    const { service, api, cfg } = await setup();
    const agent = await service.create(owner, "coder");
    const membership = { event_id: "$join", room_id: "!room:example.test", type: "m.room.member", sender: owner, state_key: agent.matrixId, content: { membership: "join" } };
    const event = { event_id: "$message", room_id: "!room:example.test", sender: owner, type: REQUEST_EVENT, content: {
      version: 1, requestId: "request-1", recipient: agent.matrixId, taskId: "task-1", contextId: "context-1", operation: "send",
      body: SendMessageRequest.toJSON(request("hello", "context-1")),
    } };
    const path = "/_matrix/app/v1/transactions/txn-1", body = { events: [membership, event] };
    expect((await api(path, "wrong", "PUT", body)).status).toBe(403);
    expect((await api(path, cfg.hsToken, "PUT", body)).status).toBe(200);
    expect((await api(path, cfg.hsToken, "PUT", body)).status).toBe(200);
    expect((await api(path, cfg.hsToken, "PUT", { events: [membership] })).status).toBe(409);
    const { connector } = await service.runtime(agent.id);
    await new Promise((r) => setTimeout(r, 600));
    expect(connector.cli!.list()).toHaveLength(1);
    expect(service.store.entries("as_transactions")).toHaveLength(1);
  });
});

it("replays unacknowledged AS batches after a store restart and excludes unrelated Agent rooms", () => {
  const cfg = config();
  const file = join(cfg.stateDir, "inbox.sqlite");
  let store = new ConnectorStore(file, "test");
  const users = new Map([["@a:test", "a"], ["@b:test", "b"]]);
  let inbox = new ApplicationInbox(store, (user) => users.get(user));
  const events = [{ event_id: "$1", room_id: "!one:test", sender: "@owner:test", state_key: "@a:test", type: "m.room.member", content: { membership: "join" } },
    { event_id: "$2", room_id: "!one:test", sender: "@owner:test", type: "m.room.message", content: { body: "only A" } }];
  inbox.receive("first", { events }); const batch = inbox.next("a")!;
  expect(inbox.next("b")).toBeUndefined(); store.close();
  store = new ConnectorStore(file, "test"); inbox = new ApplicationInbox(store, (user) => users.get(user));
  expect(inbox.next("a")).toEqual(batch); inbox.receive("first", { events });
  expect(store.entries("as_queue:a")).toHaveLength(1);
  expect(inbox.next("a", batch.next_batch)).toBeUndefined(); store.close();
});
