// Operator-only bootstrap/invitations, using Synapse's native admin APIs.
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = process.env.MATRIX_HOMESERVER_STATE ?? "state/matrix-homeserver";
const base = process.env.MATRIX_ADMIN_URL ?? "http://matrix-homeserver:8008";
const credentials = join(root, "secrets/operator.json");
const [command, name] = process.argv.slice(2);
async function request(path, body, accessToken) {
  const response = await fetch(base + path, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Synapse admin HTTP ${response.status}`);
  return response.json();
}
if (command === "bootstrap") {
  if (existsSync(credentials)) {
    const current = JSON.parse(readFileSync(credentials, "utf8"));
    const identity = await request("/_matrix/client/v3/account/whoami", undefined, current.access_token);
    if (identity.user_id !== current.user_id) throw new Error("Operator identity mismatch");
    process.stdout.write("Existing operator credential verified.\n");
  } else {
    const { nonce } = await request("/_synapse/admin/v1/register");
    const username = `operator_${randomBytes(8).toString("hex")}`, password = randomBytes(32).toString("hex");
    const secret = readFileSync(join(root, "secrets/registration"), "utf8").trim();
    const mac = createHmac("sha1", secret).update([nonce, username, password, "admin"].join("\0")).digest("hex");
    const result = await request("/_synapse/admin/v1/register", { nonce, username, password, admin: true, mac });
    writeFileSync(credentials, JSON.stringify({ user_id: result.user_id, access_token: result.access_token }), { mode: 0o600, flag: "wx" });
    process.stdout.write("Synapse operator credential saved privately.\n");
  }
} else if (command === "invite") {
  if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Usage: homeserver-admin.mjs invite FILE_NAME [USES=1] [HOURS=24]");
  const uses = Number(process.argv[4] ?? "1"), hours = Number(process.argv[5] ?? "24");
  if (!Number.isSafeInteger(uses) || uses < 1 || uses > 100 || !Number.isFinite(hours) || hours <= 0 || hours > 720) throw new Error("Invalid invitation usage count or lifetime");
  const path = join(root, "invitations", name);
  if (existsSync(path)) throw new Error("Invitation file already exists; choose a new name.");
  const { access_token } = JSON.parse(readFileSync(credentials, "utf8"));
  const token = randomBytes(24).toString("base64url");
  await request("/_synapse/admin/v1/registration_tokens/new", { token, uses_allowed: uses, expiry_time: Date.now() + hours * 3600000 }, access_token);
  writeFileSync(path, token + "\n", { mode: 0o600, flag: "wx" });
  process.stdout.write(`Invitation saved to ${path}; ${uses} use(s), valid for ${hours} hours.\n`);
} else throw new Error("Usage: homeserver-admin.mjs bootstrap | invite FILE_NAME [USES] [HOURS]");
