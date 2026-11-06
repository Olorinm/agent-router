#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { feishuApplication } from "./application.js";
import { loadFeishuCredentials, privateFile, type FeishuCredentials } from "./cli.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  domain: { type: "string", default: "feishu" }, help: { type: "boolean", short: "h" },
} });
if (values.help || positionals.length !== 1) {
  process.stdout.write("Usage: npm run feishu:setup -- PRIVATE_DIRECTORY [--domain feishu|lark]\nOne-time official QR app registration for the Feishu channel.\n");
  process.exit(values.help ? 0 : 1);
}
const directory = resolve(positionals[0]!); mkdirSync(directory, { recursive: true, mode: 0o700 });
const path = join(directory, "credentials.json");
const qr = createRequire(import.meta.url)("qrcode-terminal") as { generate(url: string, options: { small: boolean }): void };
try {
  if (!existsSync(path)) {
    if (!["feishu", "lark"].includes(values.domain!)) throw new Error("invalid_feishu_domain");
    const result = await registerApp({ source: "agent-router", createOnly: true,
      ...(values.domain === "lark" ? { domain: "accounts.larksuite.com" } : {}),
      signal: AbortSignal.timeout(600_000), ...feishuApplication,
      onQRCodeReady: ({ url }) => { process.stdout.write(`用飞书扫码配置机器人：\n${url}\n`); qr.generate(url, { small: true }); },
    });
    if (!result.user_info?.open_id) throw new Error("feishu_registration_owner_missing");
    privateFile(join(directory, "app-secret"), result.client_secret);
    privateFile(path, { version: 1, appId: result.client_id, appSecretFile: "app-secret",
      domain: result.user_info.tenant_brand ?? values.domain as "feishu" | "lark", ownerOpenId: result.user_info.open_id } satisfies FeishuCredentials);
  }
  loadFeishuCredentials(path);
  process.stdout.write(JSON.stringify({ status: "ready", connection: { id: "feishu", kind: "feishu", credentialsFile: path } }, null, 2) + "\n");
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "feishu_setup_failed";
  process.stderr.write(`${code}\n`); process.exitCode = 1;
}
