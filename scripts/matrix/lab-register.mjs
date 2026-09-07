import { readFileSync, writeFileSync, existsSync, chownSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
const dir = process.env.MATRIX_LAB_DIR ?? "/lab";
for (const side of ["a", "b"]) {
  const path = `${dir}/secrets-${side}/matrix`;
  if (existsSync(path)) {
    if (process.getuid?.() === 0) chownSync(path, 1000, 1000);
    process.stdout.write(`Matrix ${side}: existing token retained\n`); continue;
  }
  const url = `https://matrix-${side}.test:8448/_synapse/admin/v1/register`;
  const nonceResponse = await fetch(url); if (!nonceResponse.ok) throw new Error(`nonce_http_${nonceResponse.status}`);
  const { nonce } = await nonceResponse.json();
  const username = "agent", password = randomBytes(32).toString("hex");
  const secret = readFileSync(`${dir}/secrets-${side}/registration`, "utf8").trim();
  const mac = createHmac("sha1", secret).update([nonce, username, password, "notadmin"].join("\0")).digest("hex");
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, username, password, admin: false, mac }) });
  const body = await response.json(); if (!response.ok) throw new Error(`register_${side}_${response.status}_${body.errcode}`);
  writeFileSync(path, body.access_token, { mode: 0o600, flag: "wx" });
  if (process.getuid?.() === 0) chownSync(path, 1000, 1000);
  process.stdout.write(`Matrix ${side}: registered ${body.user_id}; credential saved to secret file\n`);
}
