import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ClientFactory, DefaultAgentCardResolver, RestTransportFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";

const dir = process.env.MATRIX_LAB_DIR ?? "state/matrix-lab";
const phase = process.argv[2] ?? "basic";
const file = `${dir}/verification.json`;
const journal = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { passes: [] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const A = "@agent:matrix-a.test", B = "@agent:matrix-b.test";
const token = (side, name) => readFileSync(`${dir}/secrets-${side}/${name}`, "utf8").trim();
const base = (side) => `http://connector-${side}:8787`;
const auth = (side) => (input, init) => {
  const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${token(side, "connector")}`);
  return fetch(input, { ...init, headers, redirect: "error" });
};
async function api(side, path, method = "GET", body) {
  const response = await auth(side)(base(side) + path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.ok, true, `${method} ${path}: ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}
async function client(side, target, protocol = "REST") {
  const fetchImpl = auth(side);
  return new ClientFactory({ cardResolver: new DefaultAgentCardResolver({ fetchImpl }), transports:
    protocol === "REST" ? [new RestTransportFactory({ fetchImpl })] : [new JsonRpcTransportFactory({ fetchImpl })] })
    .createFromUrl(`${base(side)}/agents/${encodeURIComponent(target)}/`);
}
const send = (client, text, fields = {}) => client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...fields }, configuration: { returnImmediately: true } }));
async function wait(client, id, state = TaskState.TASK_STATE_COMPLETED, timeout = 90_000) {
  const until = Date.now() + timeout;
  let task;
  while (Date.now() < until) {
    task = await client.getTask({ id, historyLength: 20, tenant: "" });
    if (task.status?.state === state) return task;
    if ([4, 5, 6].includes(task.status?.state)) throw new Error(`task_${id}_ended_${task.status.state}: ${JSON.stringify(task.status.message?.parts)}`);
    await delay(250);
  }
  throw new Error(`wait_${id}_wanted_${state}_got_${task?.status?.state}`);
}
const output = (task) => task.artifacts.flatMap((a) => a.parts).filter((p) => p.content?.$case === "text").map((p) => p.content.value).join("\n");
function pass(name, detail = {}) {
  const result = { name, at: new Date().toISOString(), ...detail }; journal.passes.push(result);
  writeFileSync(file, JSON.stringify(journal, null, 2), { mode: 0o600 }); process.stdout.write(`PASS ${name}\n`);
}
async function diagnostics(side) {
  const response = await fetch(`http://agent-${side}:8080/diagnostics`, { headers: { Authorization: `Bearer ${token(side, "agent")}` } });
  assert.equal(response.ok, true); return response.json();
}
async function until(check, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(250); }
  throw new Error("condition_timed_out");
}
const a = await until(() => client("a", B).catch(() => undefined));
if (phase === "basic") {
  const b = await until(() => client("b", A, "JSONRPC").catch(() => undefined));
  await until(() => api("a", "/health/ready").catch(() => undefined));
  await until(() => api("b", "/health/ready").catch(() => undefined));
  const first = await send(a, "hello from a");
  assert.equal(output(await wait(a, first.id)), "echo: hello from a");
  const reverse = await send(b, "hello from b");
  assert.equal(output(await wait(b, reverse.id)), "echo: hello from b");
  pass("bidirectional_federation_official_rest_and_jsonrpc");
  const req = SendMessageRequest.fromJSON({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text: "dedup" }] }, configuration: { returnImmediately: true } });
  const before = (await diagnostics("b")).invocations.length;
  const once = await a.sendMessage(req), twice = await a.sendMessage(req);
  assert.equal(once.id, twice.id); await wait(a, once.id);
  assert.equal((await diagnostics("b")).invocations.length, before + 1);
  pass("message_id_retry_executes_once");
  const memory = `MEMORY_${crypto.randomUUID()}`;
  const remember = await send(a, `remember ${memory}`); await wait(a, remember.id);
  const recall = await send(a, "recall", { contextId: remember.contextId });
  assert.equal(output(await wait(a, recall.id)), memory);
  journal.memory = { value: memory, contextId: remember.contextId };
  pass("same_context_across_two_a2a_tasks");
  const input = await send(a, "input"); await wait(a, input.id, TaskState.TASK_STATE_INPUT_REQUIRED);
  const answer = await send(a, "provided input", { taskId: input.id, contextId: input.contextId });
  assert.equal(answer.id, input.id); assert.equal(output(await wait(a, answer.id)), "echo: provided input");
  pass("input_required_continuation_and_artifact");
  const slow = await send(a, "slow 30000"); await wait(a, slow.id, TaskState.TASK_STATE_WORKING);
  const cancelled = await a.cancelTask({ id: slow.id, tenant: "", metadata: {} });
  assert.equal(cancelled.status?.state, TaskState.TASK_STATE_CANCELED);
  pass("cancel_after_execution_starts");
  await api("b", "/api/contacts", "POST", { address: A, execution: "ask", note: "Test separate contact and execution permission" });
  try {
    const stranger = await send(a, "requires approval");
    const invite = await until(async () => (await api("b", "/api/invites")).data.find((r) => r.sender === A));
    await api("b", `/api/invites/${encodeURIComponent(invite.room)}/accept`, "POST");
    const pending = await until(async () => (await api("b", "/api/requests")).data.find((r) => r.request.taskId === stranger.id));
    const count = (await diagnostics("b")).invocations.length; await delay(1000);
    assert.equal((await diagnostics("b")).invocations.length, count);
    await api("b", `/api/requests/${encodeURIComponent(pending.id)}/approve`, "POST");
    await wait(a, stranger.id); pass("invitation_then_request_inbox_then_explicit_execution_approval");
  } finally { await api("b", "/api/contacts", "POST", { address: A, receive: "allow", execution: "allow", note: "Conformance fixture" }); }
  const stream = a.sendMessageStream(SendMessageRequest.fromJSON({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text: "slow 1500" }] } }));
  const kinds = [];
  for await (const event of stream) kinds.push(event.payload?.$case);
  assert.ok(kinds.includes("task")); assert.ok(kinds.includes("artifactUpdate")); assert.ok(kinds.includes("statusUpdate"));
  pass("official_a2a_sse_task_artifact_status");
} else if (phase === "cancel-pending") {
  await api("b", "/api/contacts", "POST", { address: A, receive: "allow", execution: "ask", note: "Conformance pending cancellation" });
  try {
    const before = (await diagnostics("b")).invocations.length;
    const task = await send(a, "withdraw before approval");
    await until(async () => (await api("b", "/api/requests")).data.find((r) => r.request.taskId === task.id));
    const canceled = await a.cancelTask({ id: task.id, tenant: "", metadata: {} });
    assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
    assert.equal((await api("b", "/api/requests")).data.some((r) => r.request.taskId === task.id), false);
    assert.equal((await diagnostics("b")).invocations.length, before);
    pass("cancel_unapproved_request_closes_inbox_without_execution");
  } finally { await api("b", "/api/contacts", "POST", { address: A, receive: "allow", execution: "allow", note: "Conformance fixture" }); }
} else if (phase === "queue-offline") {
  journal.offline = await send(a, "offline delivery"); pass("queued_while_destination_connector_offline");
} else if (phase === "verify-offline") {
  assert.equal(output(await wait(a, journal.offline.id)), "echo: offline delivery"); pass("offline_delivery_after_connector_restart");
} else if (phase === "verify-restart") {
  const task = await send(a, "recall", { contextId: journal.memory.contextId });
  assert.equal(output(await wait(a, task.id)), journal.memory.value);
  assert.ok((await diagnostics("b")).invocations.every((i) => i.count === 1));
  pass("context_and_dedup_survive_both_connector_and_backend_restart");
} else if (phase === "queue-cancel") {
  journal.cancelCount = (await diagnostics("b")).invocations.length;
  journal.cancel = await send(a, "must never execute", { contextId: journal.memory.contextId });
  try { await a.cancelTask({ id: journal.cancel.id, tenant: "", metadata: {} }, { signal: AbortSignal.timeout(1500) }); } catch { /* Transport closes; durable cancellation remains queued. */ }
  pass("cancel_requested_while_destination_offline");
} else if (phase === "verify-cancel") {
  await wait(a, journal.cancel.id, TaskState.TASK_STATE_CANCELED);
  assert.equal((await diagnostics("b")).invocations.length, journal.cancelCount);
  pass("cancel_before_execution_prevents_backend_invocation");
} else if (phase === "gap-fill") {
  journal.gap = await send(a, "gap recovery", { contextId: journal.memory.contextId });
  await delay(1500);
  const room = (await api("a", "/api/conversations")).data.find((c) => c.id === journal.memory.contextId).room;
  // More than the connector's timeline limit, while the receiver is offline.
  for (let i = 0; i < 120; i++) {
    const response = await fetch(`https://matrix-a.test:8448/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/io.agentrouter.test.noise/${crypto.randomUUID()}`, {
      method: "PUT", headers: { Authorization: `Bearer ${token("a", "matrix")}`, "Content-Type": "application/json" }, body: JSON.stringify({ index: i }) });
    assert.equal(response.ok, true, `gap noise ${response.status}`);
  }
  pass("history_gap_prepared_with_120_events");
} else if (phase === "verify-gap") {
  assert.equal(output(await wait(a, journal.gap.id)), "echo: gap recovery"); pass("limited_sync_history_gap_recovered");
} else if (phase === "codex-first") {
  const before = new Set((await diagnostics("b")).sessions.map((s) => s.contextId));
  const memory = `MATRIX_CODEX_${crypto.randomUUID()}`;
  const task = await send(a, `Remember this private test marker in this conversation: ${memory}. Reply exactly REMEMBERED.`);
  assert.match(output(await wait(a, task.id, TaskState.TASK_STATE_COMPLETED, 300_000)), /REMEMBERED/);
  journal.codex = { contextId: task.contextId, marker: memory, sessions: (await diagnostics("b")).sessions.filter((s) => !before.has(s.contextId)) };
  assert.equal(journal.codex.sessions.length, 1); pass("real_codex_first_turn_persisted");
} else if (phase === "codex-resume") {
  const task = await send(a, "What was the private test marker I asked you to remember? Reply with only that marker.", { contextId: journal.codex.contextId });
  assert.equal(output(await wait(a, task.id, TaskState.TASK_STATE_COMPLETED, 300_000)).trim(), journal.codex.marker);
  assert.deepEqual((await diagnostics("b")).sessions.filter((s) => journal.codex.sessions.some((p) => p.contextId === s.contextId)), journal.codex.sessions);
  pass("real_codex_same_session_after_process_restart");
} else throw new Error(`Unknown phase: ${phase}`);
writeFileSync(file, JSON.stringify(journal, null, 2), { mode: 0o600 });
