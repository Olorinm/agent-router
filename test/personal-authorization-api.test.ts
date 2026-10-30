import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceExtension } from "../src/matrix/managed.js";
import { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import type { WorkSessions, WorkSessionSubmission } from "../src/execution/sessions.js";

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
async function setup(extension?: ServiceExtension) {
  const cfg = config();
  const service = new ManagedService(cfg, { authenticate: async (token) => {
    if (token === "alice") return owner;
    if (token === "bob") return other;
    throw new Error("bad_credentials");
  }, provision: async () => {}, transport, ...(extension ? { configure: async () => extension } : {}) });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function api(path: string, token = "alice", method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
  }
  return { service, api, cfg };
}
const root = "/_agent-router/v1";
it("keeps personal authorization under the owner API and outside worker credentials", async () => {
  const calls: string[] = [], extension: ServiceExtension = { start: async () => {}, stop: async () => {}, status: () => ({}),
    resolve: async () => {}, reconcile: async () => {}, closeUnknown: async () => {},
    authorization: async (id, action) => { calls.push(`${id}:${action}`); return action === "begin" ? { verificationUrl: "https://accounts.feishu.cn/verify" } : { authorized: true }; } };
  const { service, api } = await setup(extension), agent = await service.create(owner, "personal"), worker = service.issue(agent.id, "worker");
  const path = `${root}/agents/${agent.id}/communication/connections/feishu/authorization`;
  expect((await api(path, "bob")).status).toBe(404);
  expect((await api(path + "/begin", worker.token, "POST", {})).status).toBe(401); expect(calls).toHaveLength(0);
  expect((await api(path)).data).toEqual({ authorized: true });
  expect((await api(path + "/begin", "alice", "POST", {})).data).toEqual({ verificationUrl: "https://accounts.feishu.cn/verify" });
  expect((await api(path + "/complete", "alice", "POST", {})).status).toBe(200);
  expect((await api(path + "/invalid", "alice", "POST", {})).status).toBe(400);
  expect(calls).toEqual(["feishu:status", "feishu:begin", "feishu:complete"]);
});

it("keeps work submission and native sessions owner-scoped and authors user admission on the server", async () => {
  const submissions: WorkSessionSubmission[] = [], native: unknown[] = [];
  const extension: ServiceExtension = { start: async () => {}, stop: async () => {}, status: () => ({}),
    resolve: async () => {}, reconcile: async () => {}, closeUnknown: async () => {},
    sessions: { list: () => [], submit: async (input: WorkSessionSubmission) => { submissions.push(input); return { eventId: input.eventId }; },
      native: async (sessionId: string, input: unknown) => { native.push({ sessionId, input }); return {}; } } as unknown as WorkSessions };
  const { service, api } = await setup(extension), agent = await service.create(owner, "native"), worker = service.issue(agent.id, "worker");
  const path = `${root}/agents/${agent.id}/communication`, input = { eventId: "one", input: "work" };
  expect((await api(path + "/sessions", "bob")).status).toBe(404);
  expect((await api(path + "/sessions", worker.token)).status).toBe(401);
  expect((await api(path + "/work-events", "bob", "POST", input)).status).toBe(404);
  expect((await api(path + "/work-events", worker.token, "POST", input)).status).toBe(401);
  expect((await api(path + "/work-events", "alice", "POST", { ...input, admission: { kind: "schedule" } })).status).toBe(400);
  expect(submissions).toHaveLength(0);
  expect((await api(path + "/work-events", "alice", "POST", input)).status).toBe(202);
  expect(submissions[0]?.admission).toEqual({ kind: "owner", owner, agentId: agent.id, reference: "one" });
  expect((await api(path + "/sessions/one/native", "alice", "POST", { action: "list" })).status).toBe(400);
  expect((await api(path + "/sessions/one/native", "alice", "POST", { action: "read", nativeSessionId: "another-owner" })).status).toBe(400);
  expect(native).toHaveLength(0);
  expect((await api(path + "/sessions/one/native", "alice", "POST", { action: "history", itemsView: "none" })).status).toBe(400);
  expect((await api(path + "/sessions/one/native", "alice", "POST", { action: "history", itemsView: "notLoaded" })).status).toBe(200);
  expect(native).toEqual([{ sessionId: "one", input: { action: "history", itemsView: "notLoaded" } }]);
});
