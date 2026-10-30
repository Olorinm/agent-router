// Run after installing independent Router and Host archives into CONSUMER_DIRECTORY.
// This verifies the public package boundary and real HTTP/native subprocess protocol, not a live model.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-native-sessions.mjs CONSUMER_DIRECTORY");
const bridge = join(resolve(process.argv[2]), `.native-consumer-${randomUUID()}.mjs`);
await writeFile(bridge, 'export * from "@agent-router/server"; export { createNativeRuntime, startAgentHostServer } from "@olorinm/agent-host/server";\n', { flag: "wx" });
const { createRouter, HttpAgentHost, ServiceHttp, createNativeRuntime, startAgentHostServer } = await import(pathToFileURL(bridge));
const root = await mkdtemp(join(tmpdir(), "router-native-package-")), owner = "@owner:example.test";
let router, server;
try {
  const workspace = join(root, "workspace"), state = join(root, "host"); await mkdir(workspace);
  const runtime = createNativeRuntime({ id: "codex", kernel: "codex", cwd: workspace,
    options: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/native-sessions-server.mjs", import.meta.url))] },
  }, state);
  server = await startAgentHostServer({ runtimes: [runtime], stateDirectory: state, token: "fixture-token-at-least-sixteen", port: 0 });
  const http = new ServiceHttp(server.url, "fixture-token-at-least-sixteen");
  let sessions, coordinationCalls = 0;
  class ProductHost extends HttpAgentHost {
    pending = new Map();
    submitted = new Map();
    async start(input) {
      const run = await super.start({ ...input, tools: [...(input.tools ?? []), { name: "coordinate", description: "Wait for an independent task", inputSchema: { type: "object", properties: {} }, timeoutMs: 30_000 }] });
      this.submitted.set(run.id, input);
      return run;
    }
    async calls(id) {
      const calls = await super.calls(id);
      for (const call of calls.filter(call => call.name === "coordinate" && call.status === "pending")) {
        if (!this.pending.has(call.id)) this.pending.set(call.id, (async () => {
          coordinationCalls++;
          const parent = this.submitted.get(id), child = `${parent.context.conversationId}-child`;
          await sessions.fork(parent.context.conversationId, child);
          assert.equal((await sessions.history(child, { limit: 10 })).items.length, 0);
          await sessions.submit({ eventId: child, sessionId: child, input: "child", admission: { kind: "delegation", owner, agentId: agent.id, reference: call.id } });
          const context = { waitingRunId: id, waitingReference: parent.admission.reference, waitingCallId: call.id };
          let snapshot = await sessions.wait([child], { ...context, timeoutMs: 0 });
          while (snapshot.data[0].status !== "completed") {
            if (["failed", "unknown", "cancelled"].includes(snapshot.data[0].status)) throw new Error("child_did_not_complete");
            snapshot = await sessions.wait([child], { ...context, after: snapshot.cursor, timeoutMs: 1000 });
          }
          const result = snapshot.data[0];
          await super.resolve(id, call.id, { success: true, contentItems: [{ type: "inputText", text: result.answer }] });
        })());
        // Deliberately wait here: Router must keep observing other native sessions independently.
        await this.pending.get(call.id);
      }
      return calls.filter(call => call.name !== "coordinate");
    }
  }
  const host = new ProductHost(http), config = { serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir: join(root, "router"), asToken: "a".repeat(48), hsToken: "h".repeat(48) };
  const options = { hosts: { assertReady() {}, host: () => host, http: () => http }, dependencies: {
    authenticate: async token => { if (token !== "owner") throw new Error("unauthorized"); return owner; }, provision: async () => {},
    transport: agent => ({ identity: async () => agent.matrixId, sync: async since => { await sleep(20); return { next_batch: since ?? "0" }; },
      state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!fixture:example.test", join: async () => {}, send: async () => "$fixture", stop() {} }),
  } };
  router = createRouter(config, options);
  const agent = await router.service.create(owner, "worker");
  await router.connections.edit(owner, agent.id, config => { config.host = { binding: "fixture", runtimeId: "codex", instanceName: "native", instructions: "Use the original native sessions." }; });
  sessions = (await router.service.runtime(agent.id)).extension.sessions;
  for (let i = 0; i < 4; i++) await sessions.submit({ eventId: `parent-${i}`, sessionId: `parent-session-${i}`, input: "parent",
    admission: { kind: "owner", owner, agentId: agent.id, reference: `owner-request-${i}` } });
  const results = await until(() => { const results = [...Array(4)].map((_, i) => sessions.get(`parent-${i}`)); return results.every(result => result.status === "completed") ? results : null; });
  for (const result of results) assert.match(result.answer, /Parent received child result.*Finished: child/);
  assert.equal(coordinationCalls, 4);
  const parentThread = (await sessions.read("parent-session-0")).thread.id;
  await router.close(); router = createRouter(config, options); await router.start();
  sessions = (await router.service.runtime(agent.id)).extension.sessions;
  assert.equal(sessions.get("parent-0").answer, results[0].answer);
  await sessions.submit({ eventId: "followup", sessionId: "parent-session-0", input: "followup", admission: { kind: "owner", owner, agentId: agent.id, reference: "followup" } });
  await until(() => sessions.get("followup").status === "completed");
  assert.equal((await sessions.read("parent-session-0")).thread.id, parentThread);
  const history = await sessions.history("parent-session-0", { limit: 1 });
  assert.equal(history.items.length, 1);
  const childThread = (await sessions.read("parent-session-0-child")).thread;
  assert.equal(childThread.id === parentThread, false);
  const childTurn = (await sessions.history("parent-session-0-child", { limit: 1 })).items[0];
  assert.equal(childTurn.items[0].type, "dynamicToolCall");
  assert.equal(childTurn.items[0].content.namespace, "mau");
  assert.equal(childTurn.items[0].content.name, "work_sessions");
  assert.equal(JSON.parse(childTurn.items[0].content.output).source.kind, "delegation");
  console.log("PASS independent Router/Host archives: 4 saturated active parents → native forks → delegated children with bounded wait reserve → parent completion, original source retained, restart continuation, scoped paginated history (protocol fixture)");
} finally { await router?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); await rm(bridge, { force: true }); }

async function until(condition) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { const value = await condition(); if (value) return value; await sleep(25); }
  throw new Error("native_coordination_timeout");
}
