import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceDependencies } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "@alice:example.test", other = "@bob:example.test", root = "/_agent-router/v1";
function transport(agent: ManagedAgent, inbox: ApplicationInbox): MatrixTransport {
  return { identity: async () => agent.matrixId,
    sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
    state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!room:example.test",
    join: async () => {}, send: async () => "$sent", stop: () => {},
  };
}
async function setup(extra: Partial<ServiceDependencies> = {}, closeService = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "router-delete-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const deactivated: string[] = [];
  const service = new ManagedService({ serverName: "example.test", homeserver: "https://example.test",
    publicUrl: "https://example.test/_agent-router/v1", stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48) }, {
    authenticate: async (token) => token === "alice" ? owner : token === "bob" ? other : Promise.reject(new Error("bad")),
    provision: async () => {}, transport, deprovision: async (agent) => { deactivated.push(agent.matrixId); }, ...extra });
  if (closeService) cleanup.push(() => service.close());
  const server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = async (path: string, token = "alice", method = "GET") => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
  };
  return { service, api, stateDir, deactivated };
}

describe("deleting an Agent", () => {
  it("deactivates its Matrix account and removes its identity, credentials, journal and connection files", async () => {
    const { service, api, stateDir, deactivated } = await setup();
    const agent = await service.create(owner, "scratch"), kept = await service.create(owner, "kept");
    const issued = service.issue(agent.id, "laptop");
    service.inbox.receive("t1", { events: [
      { event_id: "$1", room_id: "!shared", sender: owner, type: "m.room.member", state_key: agent.matrixId, content: { membership: "join" } },
      { event_id: "$2", room_id: "!shared", sender: owner, type: "m.room.member", state_key: kept.matrixId, content: { membership: "join" } },
      { event_id: "$3", room_id: "!solo", sender: owner, type: "m.room.member", state_key: agent.matrixId, content: { membership: "join" } },
    ] });
    const connections = join(stateDir, "connections", "agents", agent.id, "feishu");
    mkdirSync(connections, { recursive: true }); writeFileSync(join(connections, "app-secret"), "secret");

    expect((await api(`${root}/agents/${agent.id}`, "bob", "DELETE")).status).toBe(404);
    expect((await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).status).toBe(204);

    expect(deactivated).toEqual([agent.matrixId]);
    expect(service.agents(owner).map((a) => a.name)).toEqual(["kept"]);
    expect(service.store.get("matrix_agents", agent.matrixId)).toBeUndefined();
    expect(service.store.get("as_members", "!shared")).toEqual({ [kept.id]: "join" });
    expect(service.store.get("as_members", "!solo")).toBeUndefined();
    expect(service.store.entries(`as_queue:${agent.id}`)).toHaveLength(0);
    expect(service.instances(agent.id)).toHaveLength(0);
    expect(existsSync(join(stateDir, "agents", `${agent.id}.sqlite`))).toBe(false);
    expect(existsSync(join(stateDir, "connections", "agents", agent.id))).toBe(false);
    expect((await api(`${root}/agents/${agent.id}/gateway/api/status`, issued.token)).status).toBe(401);
    expect((await api(`${root}/agents/${agent.id}`)).status).toBe(404);
    // The kept Agent still works and a new Agent with the old name gets a new identity.
    expect((await api(`${root}/agents/${kept.id}/gateway/api/status`)).status).toBe(200);
    expect((await service.create(owner, "scratch")).id).not.toBe(agent.id);
  });

  it("refuses while work is running, and keeps the Agent intact", async () => {
    const { service, api, deactivated } = await setup();
    const agent = await service.create(owner, "busy");
    const runtime = await service.runtime(agent.id);
    runtime.connector.store.set("communication_runs", "claim", { phase: "unknown" });
    expect(await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).toEqual({ status: 409, data: { error: "agent_has_active_or_unknown_run" } });
    runtime.connector.store.set("communication_runs", "claim", { phase: "finished" });
    expect(deactivated).toEqual([]);
    expect(service.agent(agent.id).status).toBe("active");
    expect((await api(`${root}/agents/${agent.id}/gateway/api/status`)).status).toBe(200);
  });

  it("keeps the Agent when product teardown fails, and finishes a deletion interrupted after Router state changed", async () => {
    let failTeardown = true, failMatrix = true;
    const order: string[] = [];
    const { service, api } = await setup({
      beforeDelete: async () => { order.push("before"); if (failTeardown) throw new Error("environment_destroy_failed"); },
      deprovision: async () => { order.push("matrix"); if (failMatrix) throw new Error("matrix_down"); },
      afterDelete: async () => { order.push("after"); },
    });
    const agent = await service.create(owner, "flaky");
    expect((await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).status).toBe(500);
    expect(service.agent(agent.id).status).toBe("active");
    failTeardown = false;
    expect((await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).status).toBe(500);
    expect(service.agent(agent.id).status).toBe("deleting");
    expect(await api(`${root}/agents/${agent.id}/gateway/api/status`)).toEqual({ status: 409, data: { error: "agent_deleting" } });
    failMatrix = false;
    expect((await api(`${root}/agents/${agent.id}`, "alice", "DELETE")).status).toBe(204);
    expect(order).toEqual(["before", "before", "matrix", "matrix", "after"]);
    expect(service.agents(owner)).toHaveLength(0);
  });

  it("skips a half-deleted Agent on restart instead of reopening its account", async () => {
    const { service } = await setup({ deprovision: async () => { throw new Error("matrix_down"); } }, false);
    const agent = await service.create(owner, "halfway");
    await expect(service.delete(owner, agent.id)).rejects.toThrow("matrix_down");
    // Close the first service's database before reopening the same state directory.
    service.store.close();
    const restarted = new ManagedService(service.config, { provision: async () => { throw new Error("must_not_reprovision"); }, transport });
    cleanup.push(() => restarted.close());
    await restarted.start();
    expect(restarted.agent(agent.id).status).toBe("deleting");
  });

  it("deactivates through Synapse with the application-service token and accepts an already deactivated account", async () => {
    const calls: Array<{ url: string; auth: string | null; body: string }> = [];
    let reply = new Response("{}", { status: 200 });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (!String(url).startsWith("https://example.test/")) return real(url, init);
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
      return reply;
    });
    cleanup.push(() => { vi.unstubAllGlobals(); });
    const { service } = await setup({ deprovision: undefined });
    const agent = await service.create(owner, "synapse");
    await service.delete(owner, agent.id);
    expect(calls).toEqual([{ url: `https://example.test/_matrix/client/v3/account/deactivate?user_id=${encodeURIComponent(agent.matrixId)}`,
      auth: `Bearer ${"a".repeat(48)}`, body: JSON.stringify({ erase: false }) }]);
    const again = await service.create(owner, "synapse-2");
    reply = new Response(JSON.stringify({ errcode: "M_FORBIDDEN" }), { status: 403 });
    await expect(service.delete(owner, again.id)).rejects.toThrow("matrix_agent_deactivation_failed");
    reply = new Response(JSON.stringify({ errcode: "M_USER_DEACTIVATED" }), { status: 403 });
    await service.delete(owner, again.id);
    expect(service.agents(owner)).toHaveLength(0);
  });
});
