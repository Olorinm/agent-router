// Both peers use only the delivered CLI. No A2A server or demo execution fixture is started.
import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const lab = process.env.MATRIX_LAB_DIR ?? "/lab";
const root = resolve(process.env.MATRIX_WORK_CHECK_DIR ?? `${lab}/cli-work-check`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const suffix = randomBytes(5).toString("hex"), config = join(root, "profiles");
const env = { ...process.env, MATRIX_CONFIG_DIR: config, AGENT_ROUTER_CONNECTOR_ENTRY: resolve("dist/matrix/index.js") };
for (const key of ["MATRIX_PROFILE", "MATRIX_HOMESERVER_URL", "CONNECTOR_API_TOKEN", "CONNECTOR_API_TOKEN_FILE", "A2A_AGENT_CARD_URL"]) delete env[key];
const server = (side) => `https://matrix-${side}.test:8448`;
const name = (side) => `work_${side}_${suffix}`;
const password = randomBytes(24).toString("base64url"), passwordFile = join(root, `password-${suffix}`);
writeFileSync(passwordFile, password, { mode: 0o600 });
const profile = (side) => JSON.parse(readFileSync(join(config, name(side), "session.json"), "utf8"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const passes = [], children = new Set();
const pass = (name) => { passes.push({ name, at: new Date().toISOString() }); process.stdout.write(`PASS ${name}\n`); };
function start(args) {
  const child = spawn(resolve(process.env.AGENT_ROUTER_CLI ?? "bin/agent-router"), args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", (x) => { out += x; }); child.stderr.on("data", (x) => { err += x; });
  child.logs = () => ({ out, err }); children.add(child); return child;
}
async function cli(side, ...args) {
  const child = start([...args, "--profile", name(side)]);
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  const code = await new Promise((r, reject) => { child.once("exit", r); child.once("error", reject); }); clearTimeout(timer); children.delete(child);
  const { out, err } = child.logs(); assert.ok(!out.includes(password) && !err.includes(password));
  if (code !== 0) throw new Error(`CLI ${args[0]} failed: ${err}`);
  return out ? JSON.parse(out) : undefined;
}
async function until(work, timeout = 90000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const result = await work(); if (result) return result; } catch (e) { last = e; }
    await delay(300);
  }
  throw last ?? new Error("condition timed out");
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const done = new Promise((r) => child.once("exit", r)); child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000); await done; clearTimeout(timer); children.delete(child);
  assert.equal(child.signalCode, null, "connector did not stop gracefully");
}
const ready = (side) => until(async () => (await cli(side, "doctor")).status === "ready");
const artifact = (task) => task.artifacts.flatMap((a) => a.parts).map((p) => p.text ?? "").join("\n");
async function state(side, target, id, wanted = "TASK_STATE_COMPLETED") {
  return until(async () => { const task = await cli(side, "get", target, id); return task.status.state === wanted ? task : undefined; });
}
try {
  for (const side of ["a", "b"]) {
    const url = `${server(side)}/_synapse/admin/v1/register`;
    const { nonce } = await fetch(url).then((r) => r.json());
    const secret = readFileSync(`${lab}/secrets-${side}/registration`, "utf8").trim();
    // Synapse's nonce-bound shared-secret registration MAC, not a password-storage hash.
    // https://element-hq.github.io/synapse/latest/admin_api/register_api.html
    const mac = createHmac("sha1", secret).update([nonce, name(side), password, "notadmin"].join("\0")).digest("hex");
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, username: name(side), password, admin: false, mac }) });
    assert.equal(response.ok, true); const registered = await response.json();
    assert.equal((await fetch(`${server(side)}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${registered.access_token}` } })).ok, true);
    await cli(side, "login", registered.user_id, "--homeserver", server(side), "--password-file", passwordFile);
    await cli(side, "configure", "--connector-url", `http://127.0.0.1:${side === "a" ? 18901 : 18902}`);
    assert.equal(profile(side).backend, undefined);
  }
  const A = profile("a").userId, B = profile("b").userId;
  let a = start(["connect", "--profile", name("a")]);
  let b = start(["connect", "--profile", name("b")]);
  await ready("a"); await ready("b");
  await cli("b", "contact-add", A, "--allow-receive");
  await cli("a", "contact-add", B, "--allow-receive", "--allow-execution");
  const sent = await cli("a", "send", B, "first request");
  assert.equal(sent.status.state, "TASK_STATE_SUBMITTED");
  const pending = await until(async () => (await cli("b", "inbox")).requests[0]);
  assert.equal(pending.from, A); assert.equal(await cli("b", "claim", "--worker", "b-session"), null);
  await cli("b", "approve", pending.id);
  const claim = await cli("b", "claim", "--worker", "b-session", "--wait", "60"); assert.ok(claim);
  assert.equal(claim.from, A); assert.equal((await cli("b", "claim", "--worker", "b-session")).claimId, claim.claimId);
  assert.equal(await cli("b", "claim", "--worker", "competing-session"), null);
  await cli("b", "progress", claim.claimId, "halfway");
  await until(async () => (await cli("a", "get", B, sent.id)).status.message?.parts.some((p) => p.text === "halfway"));
  await cli("b", "reply", claim.claimId, "first answer");
  await cli("b", "reply", claim.claimId, "first answer");
  assert.equal(artifact(await state("a", B, sent.id)), "first answer");
  pass("both_cli_only_default_send_approval_exclusive_claim_progress_and_idempotent_result");
  await cli("b", "contact-add", A, "--allow-receive", "--allow-execution");
  const next = await cli("a", "send", B, "next request", "--context-id", sent.contextId);
  const more = await cli("b", "claim", "--worker", "b-session", "--wait", "60"); assert.equal(more.contextId, claim.contextId);
  await cli("b", "need-input", more.claimId, "Which file?"); await state("a", B, next.id, "TASK_STATE_INPUT_REQUIRED");
  await cli("a", "send", B, "report.txt", "--task-id", next.id, "--context-id", sent.contextId);
  const continued = await cli("b", "claim", "--worker", "b-session", "--wait", "60");
  assert.equal(continued.id, more.id); assert.notEqual(continued.claimId, more.claimId);
  await assert.rejects(cli("b", "reply", more.claimId, "stale answer"), /claim_closed/);
  await cli("b", "reply", continued.claimId, "updated answer"); await state("a", B, next.id);
  const reverse = await cli("b", "send", A, "peer initiated", "--context-id", claim.conversation);
  const received = await cli("a", "claim", "--worker", "a-session", "--wait", "60");
  assert.equal(received.conversation, claim.conversation); await cli("a", "reply", received.claimId, "reverse answer");
  assert.equal(artifact(await state("b", A, reverse.id)), "reverse answer");
  pass("same_conversation_both_directions_and_input_required_continuation");
  const restart = await cli("a", "send", B, "restart request", "--context-id", sent.contextId);
  const owned = await cli("b", "claim", "--worker", "b-session", "--wait", "60");
  await stop(b); b = start(["connect", "--profile", name("b")]); await ready("b");
  assert.equal((await cli("b", "claim", "--worker", "b-session")).claimId, owned.claimId);
  assert.equal(await cli("b", "claim", "--worker", "other-session"), null);
  await cli("b", "reply", owned.claimId, "after restart"); await state("a", B, restart.id);
  pass("connector_restart_preserves_claim_and_result_correlation");
  const cancel = await cli("a", "send", B, "cancel request", "--context-id", sent.contextId);
  const active = await cli("b", "claim", "--worker", "b-session", "--wait", "60");
  const cancellation = cli("a", "cancel", B, cancel.id); cancellation.catch(() => {});
  await until(async () => (await cli("b", "work", active.claimId)).cancelRequested);
  assert.equal((await cli("a", "get", B, cancel.id)).status.state, "TASK_STATE_WORKING");
  await assert.rejects(cli("b", "reply", active.claimId, "must not complete"), /cancellation_requested/);
  await cli("b", "cancelled", active.claimId); await cancellation; await state("a", B, cancel.id, "TASK_STATE_CANCELED");
  const queued = await cli("a", "send", B, "cancel before claiming", "--context-id", sent.contextId);
  await cli("a", "cancel", B, queued.id); assert.equal(await cli("b", "claim", "--worker", "b-session"), null);
  pass("cancellation_before_claim_and_acknowledged_cancellation_during_execution");
  await stop(b);
  const offline = await cli("a", "send", B, "offline request", "--context-id", sent.contextId);
  b = start(["connect", "--profile", name("b")]); await ready("b");
  const recovered = await cli("b", "claim", "--worker", "b-session", "--wait", "60");
  assert.ok(recovered.input.parts.some((p) => p.text === "offline request"));
  await cli("b", "reply", recovered.claimId, "received after reconnect"); await state("a", B, offline.id);
  const failed = await cli("a", "send", B, "failure request", "--context-id", sent.contextId);
  const failing = await cli("b", "claim", "--worker", "b-session", "--wait", "60");
  await cli("b", "fail", failing.claimId, "Cannot complete this request."); await state("a", B, failed.id, "TASK_STATE_FAILED");
  pass("offline_delivery_and_explicit_failure_return_through_the_same_adapter");
  assert.equal(await cli("b", "claim", "--worker", "b-session", "--wait", "1"), null);
  await stop(a); await stop(b); await cli("a", "logout"); await cli("b", "logout");
  assert.equal(profile("a").accessToken, undefined); assert.equal(profile("b").accessToken, undefined);
  writeFileSync(join(root, "verification.json"), JSON.stringify({ checkedAt: new Date().toISOString(), syntheticDataOnly: true,
    twoHomeservers: true, executionServersStarted: 0, bothPeersUseCliOnly: true, testDevicesLoggedOut: true, passes }, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write("CLI-only agent conformance completed.\n");
} finally { for (const child of [...children]) await stop(child).catch(() => {}); }
