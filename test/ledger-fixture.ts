import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceConfig, type ServiceExtension } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import { channelConfigSchema, createChannelRuntime } from "../src/service/channels.js";
import { ChannelHttpError } from "../src/http.js";
import type { HostCall, HostPort, HostRun } from "../src/execution/host.js";
import { AgentLedger } from "../src/ledger/ledger.js";

/** Shared fixture of the phase 4 ledger tests: a managed service with a scripted Host. */
export const owner = "@alice:example.test", other = "@bob:example.test", root = "/_agent-router/v1", enc = encodeURIComponent;
export type Plan = Array<Omit<HostCall, "runId" | "status" | "deadlineAt"> & { deadlineAt?: string }>;
export class Host implements HostPort {
  identity = "fixture-host";
  starts: Parameters<HostPort["start"]>[0][] = [];
  runs = new Map<string, HostRun>();
  calling = new Map<string, HostCall[]>();
  resolved: Array<{ runId: string; callId: string; result: unknown }> = [];
  steers: Array<{ runId: string; input: string }> = [];
  cancels: string[] = [];
  /** Calls of the n-th run (1-based); a run without calls completes at once. */
  plan: (n: number, input: Parameters<HostPort["start"]>[0]) => Plan = () => [];
  /** Keep a run open after its calls are answered (cancel and steer tests). */
  hold = false;
  failResolve = 0;
  /** Lose the response of the next start (the run may have started): the turn becomes `unknown`. */
  failStart = 0;
  steerUnsupported = false;
  async connect() {}
  async start(input: Parameters<HostPort["start"]>[0]): Promise<HostRun> {
    this.starts.push(input);
    if (this.failStart > 0) { this.failStart--; throw new Error("socket_hang_up"); }
    const n = this.starts.length, id = `run-${n}`;
    const calls = this.plan(n, input).map((call) => ({ deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), ...call, runId: id, status: "pending" }));
    this.calling.set(id, calls);
    const run: HostRun = { id, sessionId: input.sessionId, runtimeId: input.runtimeId, status: calls.length || this.hold ? "running" : "completed", answer: `回答-${n}` };
    this.runs.set(id, run); return run;
  }
  async get(id: string) {
    const run = this.runs.get(id)!;
    if (run.status === "running" && !this.hold && !(this.calling.get(id) ?? []).some((call) => call.status === "pending")) run.status = "completed";
    return { ...run };
  }
  async cancel(id: string) { this.cancels.push(id); const run = this.runs.get(id); if (run && run.status === "running") run.status = "cancelled"; }
  async calls(id: string) { return (this.calling.get(id) ?? []).map((call) => ({ ...call })); }
  async resolve(id: string, callId: string, result: unknown) {
    if (this.failResolve > 0) { this.failResolve--; throw new Error("network_unavailable"); }
    const call = (this.calling.get(id) ?? []).find((item) => item.id === callId);
    if (!call || call.status !== "pending") throw new ChannelHttpError(404, "interaction_not_found");
    call.status = "resolved"; this.resolved.push({ runId: id, callId, result });
  }
  async steer(id: string, input: string) {
    if (this.steerUnsupported) throw new ChannelHttpError(409, "host_steer_unsupported");
    this.steers.push({ runId: id, input });
  }
  /** Close a call in the Host's own UI (no Router answer). */
  answerNatively(runId: string, callId: string) { const call = this.calling.get(runId)!.find((item) => item.id === callId)!; call.status = "resolved"; }
}
function transport(agent: ManagedAgent, inbox: ApplicationInbox): MatrixTransport {
  return { identity: async () => agent.matrixId,
    sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
    state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!room:example.test",
    join: async () => {}, send: async () => "$sent", stop: () => {} };
}
export async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 2000)}`); await new Promise((r) => setTimeout(r, 25)); }
}
export async function setup(cleanup: Array<() => void | Promise<void>>, overrides: Partial<ServiceConfig> = {}, connections: unknown[] = [{ id: "matrix", kind: "matrix" }]) {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-phase4-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const host = new Host(), extensions = new Map<string, ServiceExtension>();
  const service: ManagedService = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48), ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true, ...overrides }, {
    authenticate: async (token) => { if (token === "alice") return owner; if (token === "bob") return other; throw new Error("bad_credentials"); },
    provision: async () => {}, transport,
    configure: async (agent, connector) => {
      const config = channelConfigSchema.parse({ agents: [{ agentId: agent.id, connections, host: { binding: "fixture", runtimeId: "fixture" } }] }).agents[0]!;
      const extension = await createChannelRuntime(agent, connector, config, stateDir, (name) => {
        const issued = service.issue(agent.id, name);
        return { id: issued.instance.id, validate: () => { service.instance(issued.token, agent.id); } };
      }, host, { persons: service.persons, watching: (sessionKey) => service.hubs.hub(agent.owner).watching(agent.id, sessionKey) });
      if (extension.control) extension.control.replanGraceMs = 0;
      extensions.set(agent.id, extension);
      return extension;
    } });
  cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  server.on("upgrade", (req, socket, head) => { if (!service.web?.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  async function api(path: string, token = "alice", method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
  }
  const agent = await service.create(owner, "helper");
  const ledger = AgentLedger.attached((await service.runtime(agent.id)).connector.store)!;
  const chatId = `dm:${agent.id}`, chat = `${root}/web/chats/${enc(chatId)}`;
  const send = (body: Record<string, unknown>, token = "alice") => api(`${chat}/messages`, token, "POST", body);
  const events = async () => (await api(`${chat}/events?limit=200`)).data.events as any[];
  const card = async (predicate: (card: any) => boolean = () => true) =>
    (await until(events, (items) => items.some((event) => event.kind === "card" && predicate(event.card)))).find((event) => event.kind === "card" && predicate(event.card)).card;
  const answer = (cardId: string, body: Record<string, unknown>, token = "alice") => api(`${chat}/cards/${enc(cardId)}/answer`, token, "POST", body);
  return { service, api, agent, ledger, host, port, chatId, chat, send, events, card, answer, extension: () => extensions.get(agent.id)! };
}
let counter = 0;
/** A fresh idempotency key (16–128 chars). */
export const ik = (label = "k") => `${label}${String(++counter).padStart(4, "0")}${"0".repeat(16)}`.slice(0, 32);
