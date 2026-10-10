#!/usr/bin/env node
// Public HTTP integration with the real Agent Host service and its deterministic Codex fixture.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ManagedService, createManagedApp } from "../dist/matrix/managed.js";
import { createChannelRuntime, channelConfigSchema } from "../dist/service/channels.js";
import { CommunicationCore } from "../dist/communication/core.js";
import { DurableStore } from "../dist/communication/store.js";
import { CliWork } from "../dist/execution/work.js";
import { HostWorker } from "../dist/execution/host-worker.js";
import { HttpAgentHost } from "../dist/execution/host.js";
import { ServiceHttp } from "../dist/channels/http.js";
import { FeishuAccount, privateFile } from "../dist/services/feishu/cli.js";
import { FeishuTools } from "../dist/services/feishu/tools.js";

const hostProject = process.argv[2];
if (!hostProject) throw new Error("Usage: node scripts/verify-agent-host.mjs AGENT_HOST_PROJECT (build both projects first)");
const { createNativeRuntime, startAgentHostServer } = await import(pathToFileURL(resolve(hostProject, "dist/service/index.js")).href);
const root = await mkdtemp(join(tmpdir(), "router-host-verify-"));
const owner = "@owner:example.test", token = "fixture-owner-token-00000000000000";
let host, service, server, toolStore;
const sent = [];
try {
  const productRuntime = { id: "product-fixture", kernel: "fixture", cwd: root, configurationKey: "product-fixture-v1", close() {},
    async *run(request) {
      yield { type: "turn.started", runId: request.runId };
      const tool = request.tools.find((tool) => tool.name === "feishu_personal"); assert.ok(tool);
      const result = await tool.execute({ args: ["calendar", "+agenda"] }, { sessionId: request.sessionId, runId: request.runId,
        threadId: "fixture-thread", turnId: request.runId, callId: "fixture-call", signal: request.signal });
      assert.equal(result.success, true);
      yield { type: "model.response", runId: request.runId, text: result.contentItems[0].text };
      yield { type: "turn.finished", runId: request.runId, outcome: { status: "completed" } };
    } };
  host = await startAgentHostServer({ token, stateDirectory: join(root, "host"), port: 0, runtimes: [createNativeRuntime({
    id: "fixture", kernel: "codex", cwd: root, options: { command: process.execPath,
      args: [resolve(hostProject, "test/fixtures/codex-server.mjs")], requestTimeoutMs: 3000, cancellationGraceMs: 100 },
  }, join(root, "host")), productRuntime] });
  await writeFile(join(root, "host-token"), token, { mode: 0o600 });
  service = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir: join(root, "router"), asToken: "a".repeat(48), hsToken: "h".repeat(48) }, {
    authenticate: async (value) => value === "owner" ? owner : "@other:example.test",
    provision: async () => {},
    transport: (agent) => ({ identity: async () => agent.matrixId,
      sync: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { next_batch: "idle" }; },
      state: async () => [agent.matrixId, owner].map((id) => ({ type: "m.room.member", state_key: id, content: { membership: "join" } })),
      history: async () => ({ events: [] }), createRoom: async () => "!room:example.test", join: async () => {}, stop: () => {},
      send: async (_room, _type, content, txn) => { sent.push({ content, txn }); return `$${txn}`; } }),
    configure: (agent, connector) => {
      const config = channelConfigSchema.parse({ agents: [{ agentId: agent.id, connections: [{ id: "matrix", kind: "matrix" }],
        host: { url: host.url, tokenFile: "host-token", runtimeId: "fixture" } }] }).agents[0];
      return createChannelRuntime(agent, connector, config, root, (name) => {
        const issued = service.issue(agent.id, name);
        return { id: issued.instance.id, validate: () => { service.instance(issued.token, agent.id); } };
      });
    },
  });
  const agent = await service.create(owner, "personal"), runtime = await service.runtime(agent.id);
  server = createManagedApp(service).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/_agent-router/v1/agents/${agent.id}/communication`;
  const api = async (path = "", body, credential = "owner") => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const until = async (predicate) => {
    const deadline = Date.now() + 15_000;
    for (;;) { const status = (await api()).value; if (predicate(status)) return status;
      assert.ok(Date.now() < deadline, `timed out: ${JSON.stringify(status)}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
  };
  const input = async (id, text) => runtime.connector.acceptSync({ next_batch: id, rooms: { join: { "!room:example.test": { timeline: { events: [
    { event_id: `$${id}`, sender: owner, type: "m.room.message", origin_server_ts: Date.now() + 1000, content: { msgtype: "m.text", body: text } },
  ] } } } } });
  assert.equal((await api("", undefined, "other")).status, 404);
  await input("first", "first turn"); const first = await until((status) => status.outbox.filter((row) => row.state === "accepted").length === 1);
  await input("second", "second turn"); const second = await until((status) => status.outbox.filter((row) => row.state === "accepted").length === 2);
  assert.equal(first.host.runs[0].sessionId, second.host.runs[1].sessionId);
  assert.ok(sent[0].content.body.includes("first turn")); assert.ok(sent[1].content.body.includes("second turn"));
  await input("question", "question"); const pending = await until((status) => status.host.calls.length === 1);
  assert.equal(pending.host.calls[0].name, "item/tool/requestUserInput");
  const result = { answers: { color: { answers: ["Blue"] } } };
  assert.equal((await api(`/calls/${pending.host.calls[0].id}/result`, { result })).status, 200);
  await until((status) => status.outbox.filter((row) => row.state === "accepted").length === 3);
  assert.ok(sent[2].content.body.includes('"Blue"'));
  const accountDirectory = join(root, "feishu"); privateFile(join(accountDirectory, "app-secret"), "fixture-app-secret");
  // Local status has no --verify: validate the pinned CLI's real config/JSON contract without platform API calls.
  const formatAccount = new FeishuAccount({ version: 1, appId: "cli_router_format_fixture", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_fixture" }, join(root, "cli-format"));
  privateFile(join(formatAccount.directory, "app-secret"), "fixture-format-secret");
  assert.equal((await formatAccount.status()).authorized, false);
  let commands = 0;
  const account = new FeishuAccount({ version: 1, appId: "app", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_owner" }, accountDirectory,
    async (args) => {
      if (args[0] === "auth") return { code: 0, stderr: "", stdout: JSON.stringify({ appId: "app", identities: { user: { available: true, openId: "ou_owner", tokenStatus: "valid" } } }) };
      assert.deepEqual(args, ["calendar", "+agenda", "--as", "user", "--profile", "app"]); commands++;
      return { code: 0, stderr: "", stdout: '{"ok":true,"data":{"items":["meeting fixture"]}}' };
    });
  toolStore = new DurableStore(join(root, "product-tools.sqlite"), "tool-agent");
  const work = new CliWork(toolStore, () => "allow"), core = new CommunicationCore("tool-agent", toolStore, work), replies = [];
  core.register({ id: "fixture", ownerAddresses: ["ou_owner"] }, { kind: "feishu", retrySafe: false, start: async () => {}, stop: async () => {},
    send: async (_route, text) => { replies.push(text); return { externalId: "fixture-reply" }; } });
  await core.start(); const tools = new FeishuTools("personal", account);
  const worker = new HostWorker("tool-agent", "tool-instance", toolStore, work, new HttpAgentHost(new ServiceHttp(host.url, token)), "product-fixture", "Use Feishu tools",
    () => {}, (id, text) => core.saveResult(id, text), { definitions: [tools.definition], instructions: "", allowed: (context, task) => core.isOwnerTask(context, task), execute: (call) => tools.execute(call) });
  core.receive("fixture", { externalId: "agenda", sender: "ou_owner", scope: "direct", threadId: "fixture-chat", text: "show my agenda",
    reply: { target: "fixture-chat", messageId: "agenda", data: {} } });
  const end = Date.now() + 15_000;
  while (!replies.length) {
    await core.dispatch(); await worker.tick(); await core.dispatch(); await core.flush();
    assert.ok(Date.now() < end, `tool fixture timed out: ${JSON.stringify(worker.status())}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(commands, 1); assert.ok(replies[0].includes("meeting fixture")); assert.equal(worker.status().tools[0].phase, "completed");
  await core.stop();
  process.stdout.write(JSON.stringify({ status: "passed", nativeKernel: "Codex protocol fixture", personalTools: "public Host tool broker and isolated CLI fixture",
    checks: ["managed service composition", "private Matrix input and reply", "stable Host session", "native question reply", "owner boundary", "Feishu product tool HTTP round trip"] }) + "\n");
} finally {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await service?.close(); await host?.close(); toolStore?.close(); await rm(root, { recursive: true, force: true });
}
