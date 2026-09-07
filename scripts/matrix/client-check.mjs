// Real native Matrix APIs on two Synapse homeservers; all identities are synthetic.
import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { authClient } from "../../dist/matrix/auth.js";
import { contactType } from "../../dist/matrix/social.js";

const lab = process.env.MATRIX_LAB_DIR ?? "/lab";
const root = resolve(process.env.MATRIX_CLIENT_CHECK_DIR ?? `${lab}/client-check`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const suffix = randomBytes(5).toString("hex"), config = join(root, "profiles");
const env = { ...process.env, MATRIX_CONFIG_DIR: config };
for (const key of ["MATRIX_PROFILE", "MATRIX_HOMESERVER_URL", "CONNECTOR_API_TOKEN", "CONNECTOR_API_TOKEN_FILE"]) delete env[key];
const server = (side) => `https://matrix-${side === "c" ? "a" : side}.test:8448`;
const name = (side) => `client_${side}_${suffix}`;
const password = randomBytes(24).toString("base64url"), endpointToken = randomBytes(24).toString("base64url");
const passwordFile = join(root, `password-${suffix}`), tokenFile = join(root, `endpoint-${suffix}`);
writeFileSync(passwordFile, password, { mode: 0o600 }); writeFileSync(tokenFile, endpointToken, { mode: 0o600 });
const profile = (side) => JSON.parse(readFileSync(join(config, name(side), "session.json"), "utf8"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const passes = [], children = new Set();
const pass = (name) => { passes.push({ name, at: new Date().toISOString() }); process.stdout.write(`PASS ${name}\n`); };
function start(args, extra = {}) {
  const child = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", (x) => { out += x; }); child.stderr.on("data", (x) => { err += x; });
  child.logs = () => ({ out, err }); children.add(child); return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const done = new Promise((r) => child.once("exit", r)); child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000); await done; clearTimeout(timer); children.delete(child);
  assert.notEqual(child.signalCode, "SIGKILL", "process failed to stop gracefully");
}
async function cli(side, ...args) {
  const child = start(["dist/cli/matrix.js", ...args, "--profile", name(side)]);
  const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
  const code = await new Promise((r, reject) => { child.once("exit", r); child.once("error", reject); }); clearTimeout(timer); children.delete(child);
  const { out, err } = child.logs();
  assert.ok(!out.includes(password) && !err.includes(password) && !out.includes(endpointToken) && !err.includes(endpointToken));
  assert.equal(code, 0, `CLI ${args[0]} failed: ${err}`); return out ? JSON.parse(out) : undefined;
}
async function until(work, timeout = 90000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const result = await work(); if (result) return result; } catch (e) { last = e; }
    await delay(400);
  }
  throw last ?? new Error("condition timed out");
}
async function ready(side) { return until(async () => (await cli(side, "doctor")).status === "ready"); }
async function native(side, path, method = "GET", body) {
  const p = profile(side);
  const response = await fetch(`${p.homeserver}/_matrix/client/v3${path}`, { method,
    headers: { Authorization: `Bearer ${p.accessToken}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  assert.equal(response.ok, true, `Native ${method} ${path}: ${response.status}`); return response.json();
}
const account = (side, type) => native(side, `/user/${encodeURIComponent(profile(side).userId)}/account_data/${encodeURIComponent(type)}`);
const diagnostics = () => fetch("http://127.0.0.1:18890/diagnostics", { headers: { Authorization: `Bearer ${endpointToken}` } }).then((r) => r.json());
const artifact = (task) => task.artifacts.flatMap((a) => a.parts).map((p) => p.text ?? "").join("\n");
async function completed(side, target, task) {
  return until(async () => { const result = await cli(side, "get", target, task.id); return result.status.state === "TASK_STATE_COMPLETED" ? result : undefined; });
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
    assert.equal(response.ok, true); const credentials = await response.json();
    // Bootstrap-created device is not used by the test; revoke it before normal native CLI login.
    const initial = authClient(server(side), { accessToken: credentials.access_token }); await initial.logout(); initial.http.abort();
    await cli(side, "login", credentials.user_id, "--homeserver", server(side), "--password-file", passwordFile);
    await cli(side, "configure", "--connector-url", `http://127.0.0.1:${side === "a" ? 18891 : 18892}`);
  }
  const A = profile("a").userId, B = profile("b").userId;
  const fixture = start(["dist/matrix/demo-agent.js"], { HOST: "127.0.0.1", PORT: "18890", PUBLIC_BASE_URL: "http://127.0.0.1:18890",
    ENDPOINT_BEARER_TOKEN_FILE: tokenFile, DEMO_STORE_PATH: join(root, `fixture-${suffix}.sqlite`) });
  await until(async () => (await fetch("http://127.0.0.1:18890/health/live")).ok);
  for (const side of ["a", "b"]) await cli(side, "bind", "http://127.0.0.1:18890/.well-known/agent-card.json", "--endpoint-token-file", tokenFile);
  const a = start(["dist/cli/matrix.js", "connect", "--profile", name("a")]);
  const b = start(["dist/cli/matrix.js", "connect", "--profile", name("b")]); await ready("a"); await ready("b");
  await cli("a", "contact-add", B, "--note", "Editor", "--tag", "writing", "--allow-receive", "--allow-execution");
  await cli("b", "contact-add", A, "--allow-receive");
  assert.deepEqual(await account("a", contactType(B)), { version: 1, address: B, note: "Editor", tags: ["writing"] });
  pass("native_private_contacts_and_local_execution_permissions_are_separate");
  const first = await cli("a", "say", B, "plain hello");
  const bConversation = await until(async () => (await cli("b", "conversations")).data.find((r) => r.room === first.room));
  await until(async () => (await cli("b", "history", first.room)).events.some((e) => e.content.body === "plain hello"));
  assert.equal((await diagnostics()).invocations.length, 0);
  await cli("b", "say", A, "plain reply", "--context-id", bConversation.id);
  await until(async () => (await cli("a", "history", first.room)).events.some((e) => e.content.body === "plain reply"));
  assert.ok((await account("a", "m.direct"))[B].includes(first.room));
  assert.ok((await account("b", "m.direct"))[A].includes(first.room));
  pass("standard_matrix_text_and_direct_rooms_work_bidirectionally_without_execution");
  await cli("b", "profile-set", `Synthetic Editor ${suffix}`);
  assert.equal((await cli("a", "lookup", B)).displayname, `Synthetic Editor ${suffix}`);
  await until(async () => (await cli("a", "find", suffix)).results.some((r) => r.user_id === B));
  pass("native_remote_profile_and_visible_user_directory_search");
  const watch = start(["dist/cli/matrix.js", "watch", "--since", "0", "--room", first.room, "--profile", name("a")]);
  await until(async () => watch.logs().out.includes("plain reply"));
  await cli("b", "say", A, "watch notification", "--context-id", bConversation.id);
  await until(async () => watch.logs().out.includes("watch notification")); await stop(watch);
  await cli("a", "read", first.room);
  const marker = await native("a", `/user/${encodeURIComponent(A)}/rooms/${encodeURIComponent(first.room)}/account_data/m.fully_read`);
  assert.ok(marker.event_id);
  pass("event_watch_and_native_read_marker");
  const memory = await cli("a", "send", B, `remember MEMORY_${suffix}`, "--context-id", first.contextId);
  const pending = await until(async () => (await cli("b", "requests")).data.find((r) => r.request.taskId === memory.id));
  assert.equal((await diagnostics()).invocations.length, 0); await cli("b", "approve", pending.id); await completed("a", B, memory);
  await cli("b", "contact-add", A, "--allow-receive", "--allow-execution");
  const reverse = await cli("b", "send", A, "reverse task", "--context-id", bConversation.id, "--wait", "90");
  assert.equal(artifact(reverse), "echo: reverse task");
  pass("approved_task_and_peer_initiated_task_share_original_matrix_room");
  await cli("c", "login", A, "--homeserver", server("a"), "--password-file", passwordFile);
  await cli("c", "configure", "--connector-url", "http://127.0.0.1:18893");
  const beforeRestore = (await diagnostics()).invocations.length;
  const c = start(["dist/cli/matrix.js", "connect", "--profile", name("c")]); await ready("c");
  const restored = (await cli("c", "contacts")).data.find((r) => r.address === B);
  assert.equal(restored.note, "Editor"); assert.deepEqual(restored.tags, ["writing"]); assert.equal(restored.execution, "ask");
  const cConversation = (await cli("c", "conversations")).data.find((r) => r.room === first.room); assert.ok(cConversation);
  assert.equal((await diagnostics()).invocations.length, beforeRestore);
  assert.ok((await cli("c", "requests")).data.some((r) => r.error === "history_restored_without_execution_state"));
  assert.equal(artifact(await cli("c", "send", B, "recall", "--context-id", cConversation.id, "--wait", "90")), `MEMORY_${suffix}`);
  pass("fresh_device_restores_contacts_and_room_history_without_reexecuting_old_tasks_and_can_resume_peer_context");
  await cli("c", "block", B);
  await until(async () => (await cli("a", "blocked")).data.includes(B));
  assert.ok((await account("a", "m.ignored_user_list")).ignored_users[B]);
  const beforeBlock = (await diagnostics()).invocations.length;
  const blockedTask = await cli("b", "send", A, "blocked task", "--context-id", bConversation.id);
  await until(async () => (await cli("b", "history", first.room)).events.some((e) => e.content.taskId === blockedTask.id));
  await delay(1500); assert.equal((await diagnostics()).invocations.length, beforeBlock);
  await cli("c", "unblock", B); await until(async () => !(await cli("a", "blocked")).data.includes(B));
  assert.equal((await cli("a", "contacts")).data.find((r) => r.address === B).execution, "ask");
  pass("native_blocking_syncs_across_devices_and_unblocking_does_not_grant_execution");
  await cli("c", "contact-remove", B); await until(async () => !(await cli("a", "contacts")).data.some((r) => r.address === B));
  assert.ok((await cli("a", "history", first.room)).events.length > 0);
  await stop(c);
  const invitation = await cli("b", "say", A, "new invitation");
  await until(async () => (await cli("a", "invites")).data.some((r) => r.room === invitation.room));
  await cli("a", "invite-reject", invitation.room);
  await until(async () => !(await cli("a", "invites")).data.some((r) => r.room === invitation.room));
  pass("contact_removal_keeps_history_and_unknown_invitation_can_be_rejected_natively");
  await stop(a); await stop(b); await stop(fixture);
  for (const side of ["a", "b", "c"]) await cli(side, "logout");
  writeFileSync(join(root, "verification.json"), JSON.stringify({ checkedAt: new Date().toISOString(), syntheticDataOnly: true, twoHomeservers: true, passes }, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write("Matrix native client conformance completed.\n");
} finally { for (const child of [...children]) await stop(child).catch(() => {}); }
