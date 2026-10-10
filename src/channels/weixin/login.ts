#!/usr/bin/env node
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { displayQRCode, startWeixinLoginWithQr, waitForWeixinLogin } from "./vendor/login-qr.js";

const file = process.argv[2];
if (file === "--help" || file === "-h") { process.stdout.write("Usage: npm run weixin:login -- CREDENTIALS_FILE\n"); process.exit(0); }
if (!file) throw new Error("Usage: node dist/channels/weixin/login.js CREDENTIALS_FILE");
const baseUrl = "https://ilinkai.weixin.qq.com";
const started = await startWeixinLoginWithQr({ apiBaseUrl: baseUrl, force: true });
if (!started.qrcodeUrl || !started.sessionKey) throw new Error("weixin_qr_login_failed");
process.stdout.write("用微信扫描二维码：\n");
await displayQRCode(started.qrcodeUrl);
const result = await waitForWeixinLogin({ apiBaseUrl: baseUrl, sessionKey: started.sessionKey, timeoutMs: 240_000 });
if (!result.connected || !result.accountId || !result.botToken || !result.userId) throw new Error("weixin_login_not_completed");
const output = resolve(file);
const origin = new URL(result.baseUrl || baseUrl);
if (origin.protocol !== "https:" || !origin.hostname.endsWith(".weixin.qq.com") || origin.username || origin.password || origin.search || origin.hash) throw new Error("invalid_weixin_api_origin");
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(`${output}.partial`, JSON.stringify({ accountId: result.accountId, userId: result.userId,
  token: result.botToken, baseUrl: result.baseUrl || baseUrl }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
renameSync(`${output}.partial`, output);
process.stdout.write(`微信连接凭据已保存到 ${output}\n`);
