// End-to-end account onboarding against a real, invite-gated Synapse.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const server = process.env.MATRIX_TEST_HOMESERVER;
const invitation = process.env.MATRIX_TEST_INVITATION_FILE;
if (!server || !invitation) throw new Error("MATRIX_TEST_HOMESERVER and MATRIX_TEST_INVITATION_FILE are required (invitation needs two uses).");
const root = resolve(process.env.MATRIX_AUTH_CHECK_DIR ?? "state/matrix-auth-check");
mkdirSync(root, { recursive: true, mode: 0o700 });
const config = join(root, "profiles");
const env = { ...process.env, MATRIX_CONFIG_DIR: config };
delete env.MATRIX_PROFILE;
const suffix = randomBytes(5).toString("hex");
const users = { a: `onboard_a_${suffix}`, b: `onboard_b_${suffix}` };
const password = randomBytes(24).toString("base64url"), agentToken = randomBytes(24).toString("base64url");
const passwordFile = join(root, `password-${suffix}`), agentTokenFile = join(root, `agent-token-${suffix}`);
writeFileSync(passwordFile, password, { mode: 0o600 }); writeFileSync(agentTokenFile, agentToken, { mode: 0o600 });
const profileName = (side) => `${side}_${suffix}`;
const profileFile = (side) => join(config, profileName(side), "session.json");
const profile = (side) => JSON.parse(readFileSync(profileFile(side), "utf8"));
const passes = [];
const pass = (name) => { passes.push({ name, at: new Date().toISOString() }); process.stdout.write(`PASS ${name}\n`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set();

async function cli(side, ...args) {
  const child = spawn(process.execPath, ["dist/cli/matrix.js", ...args, "--profile", profileName(side)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); clearTimeout(timer);
  assert.ok(!stdout.includes(password) && !stderr.includes(password) && !stdout.includes(agentToken) && !stderr.includes(agentToken), "CLI exposed a secret");
  if (code !== 0) throw new Error(`CLI ${args[0]} failed: ${stderr.replace(/Task .*\n/g, "")}`);
  return stdout ? JSON.parse(stdout) : undefined;
}
function start(args, additionalEnv = {}) {
  const child = spawn(process.execPath, args, { env: { ...env, ...additionalEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (x) => { log += x; }); child.stderr.on("data", (x) => { log += x; });
  child.diagnostics = () => log.slice(-4000); children.add(child); return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45000);
  await done; clearTimeout(timeout); children.delete(child);
  assert.equal(child.signalCode, null, "Connector should stop gracefully");
}
async function until(work, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) { try { const result = await work(); if (result) return result; } catch (e) { last = e; } await delay(500); }
  throw last ?? new Error("Condition timed out");
}
async function ready(side, child) {
  return until(async () => {
    if (child.exitCode !== null) throw new Error(`Connector exited: ${child.diagnostics()}`);
    return (await cli(side, "doctor")).status === "ready";
  });
}
const artifact = (task) => task.artifacts.flatMap((a) => a.parts).map((p) => p.text ?? "").join("\n");

try {
  for (const side of ["a", "b"]) {
    const registered = await cli(side, "register", new URL(server).host, users[side], "--password-file", passwordFile, "--registration-token-file", invitation);
    assert.match(registered.userId, /^@onboard_/); assert.equal(registered.loggedIn, true);
    await cli(side, "configure", "--connector-url", `http://127.0.0.1:${side === "a" ? 18791 : 18792}`);
    assert.equal((await cli(side, "whoami")).userId, profile(side).userId);
    const before = profile(side);
    await cli(side, "login", profile(side).userId, "--password-file", passwordFile);
    assert.equal(profile(side).deviceId, before.deviceId);
  }
  pass("native_invitation_registration_login_identity_and_device_reuse");
  const fixture = start(["dist/matrix/demo-agent.js"], { HOST: "127.0.0.1", PORT: "18880", PUBLIC_BASE_URL: "http://127.0.0.1:18880",
    ENDPOINT_BEARER_TOKEN_FILE: agentTokenFile, DEMO_STORE_PATH: join(root, `agent-${suffix}.sqlite`) });
  await until(async () => (await fetch("http://127.0.0.1:18880/health/live")).ok);
  await cli("b", "bind", "http://127.0.0.1:18880/.well-known/agent-card.json", "--endpoint-token-file", agentTokenFile);
  let a = start(["dist/cli/matrix.js", "connect", "--profile", profileName("a")]);
  let b = start(["dist/cli/matrix.js", "connect", "--profile", profileName("b")]);
  await ready("a", a); await ready("b", b);
  await assert.rejects(cli("b", "logout"), /Profile is in use/);
  await cli("b", "contact-add", profile("a").userId, "--allow-receive");
  const request = await cli("a", "send", profile("b").userId, "onboarding approval", "--detach");
  const pending = await until(async () => (await cli("b", "requests")).data.find((x) => x.request.taskId === request.id));
  const diagnostics = await fetch("http://127.0.0.1:18880/diagnostics", { headers: { Authorization: `Bearer ${agentToken}` } }).then((r) => r.json());
  assert.equal(diagnostics.invocations.length, 0);
  await cli("b", "approve", pending.id);
  const result = await until(async () => {
    const task = await cli("a", "get", profile("b").userId, request.id);
    return task.status.state === "TASK_STATE_COMPLETED" ? task : undefined;
  });
  assert.equal(artifact(result), "echo: onboarding approval");
  pass("saved_login_connect_bind_request_approval_and_task_result");
  await cli("b", "contact-add", profile("a").userId, "--allow-receive", "--allow-execution");
  const marker = `ONBOARDING_${suffix}`;
  const memory = await cli("a", "send", profile("b").userId, `remember ${marker}`);
  assert.equal(memory.status.state, "TASK_STATE_COMPLETED");
  const old = { a: profile("a"), b: profile("b") };
  await stop(a); await stop(b);
  for (const side of ["a", "b"]) {
    await cli(side, "logout");
    assert.equal(profile(side).accessToken, undefined); assert.equal(profile(side).refreshToken, undefined);
    const revoked = await fetch(`${server}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${old[side].accessToken}` } });
    assert.equal(revoked.status, 401);
    await cli(side, "login", profile(side).userId, "--password-file", passwordFile);
    assert.notEqual(profile(side).accessToken, old[side].accessToken);
    assert.equal(profile(side).gatewayToken, old[side].gatewayToken);
    assert.deepEqual(profile(side).backend, old[side].backend);
  }
  pass("logout_revokes_server_tokens_and_relogin_preserves_profile_bindings");
  a = start(["dist/cli/matrix.js", "connect", "--profile", profileName("a")]);
  b = start(["dist/cli/matrix.js", "connect", "--profile", profileName("b")]);
  await ready("a", a); await ready("b", b);
  assert.equal(artifact(await cli("a", "send", profile("b").userId, "recall", "--context-id", memory.contextId)), marker);
  assert.equal((await cli("a", "get", profile("b").userId, request.id)).status.state, "TASK_STATE_COMPLETED");
  pass("contacts_task_history_and_context_survive_logout_login_and_connector_restart");
  await stop(a); await stop(b); await stop(fixture);
  await cli("a", "logout"); await cli("b", "logout");
  const evidence = { checkedAt: new Date().toISOString(), nativeMatrixAccounts: true, syntheticDataOnly: true, checkpoints: passes };
  writeFileSync(join(root, "verification.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write("Matrix account onboarding conformance completed.\n");
} finally { for (const child of children) { try { await stop(child); } catch { /* Retain the original test failure. */ } } }
