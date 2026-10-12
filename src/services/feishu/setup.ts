#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { setTimeout as sleep } from "node:timers/promises";
import { FeishuAccount, loadFeishuCredentials, privateFile, runOfficialCli, type FeishuCredentials } from "./cli.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  domain: { type: "string", default: "feishu" }, domains: { type: "string", default: "all" },
  complete: { type: "boolean" }, "no-wait": { type: "boolean" }, help: { type: "boolean", short: "h" },
} });
if (values.help || positionals.length !== 1) {
  process.stdout.write("Usage: npm run feishu:setup -- PRIVATE_DIRECTORY [--domain feishu|lark] [--domains all|calendar,docs,drive] [--no-wait | --complete]\nOne-time official QR app registration followed by personal authorization. --complete resumes after confirmation.\n");
  process.exit(values.help ? 0 : 1);
}
const directory = resolve(positionals[0]!); mkdirSync(directory, { recursive: true, mode: 0o700 });
const path = join(directory, "credentials.json");
const qr = createRequire(import.meta.url)("qrcode-terminal") as { generate(url: string, options: { small: boolean }): void };
try {
  if ((await runOfficialCli(["--version"], { cwd: directory, env: process.env, timeout: 10_000 })).code !== 0) throw new Error("official_lark_cli_not_installed");
  if (!existsSync(path)) {
    if (values.complete) throw new Error("feishu_application_not_configured");
    if (!["feishu", "lark"].includes(values.domain!)) throw new Error("invalid_feishu_domain");
    const result = await registerApp({ source: "agent-router", createOnly: true,
      ...(values.domain === "lark" ? { domain: "accounts.larksuite.com" } : {}),
      signal: AbortSignal.timeout(600_000), appPreset: { name: "{user} 的 Agent", desc: "个人 Agent 的飞书对话与工具" },
      addons: { scopes: { tenant: ["im:message", "im:message:send_as_bot", "im:resource", "cardkit:card:write", "drive:drive"] }, events: { items: { tenant: ["im.message.receive_v1", "card.action.trigger", "im.message.reaction.created_v1", "im.message.reaction.deleted_v1", "drive.notice.comment_add_v1"] } } },
      onQRCodeReady: ({ url }) => { process.stdout.write(`用飞书扫码配置机器人：\n${url}\n`); qr.generate(url, { small: true }); },
    });
    if (!result.user_info?.open_id) throw new Error("feishu_registration_owner_missing");
    privateFile(join(directory, "app-secret"), result.client_secret);
    privateFile(path, { version: 1, appId: result.client_id, appSecretFile: "app-secret",
      domain: result.user_info.tenant_brand ?? values.domain as "feishu" | "lark", ownerOpenId: result.user_info.open_id } satisfies FeishuCredentials);
  }
  const { credentials } = loadFeishuCredentials(path), account = new FeishuAccount(credentials, directory);
  let status = await account.status(true);
  if (!status.authorized || !status.verified) {
    if (values.complete) status = await account.complete();
    else {
      const authorization = await account.begin(values.domains!.split(","));
      process.stdout.write(`请确认个人资源授权：\n${authorization.verificationUrl}\n`);
      const png = await account.qr(authorization.verificationUrl);
      process.stdout.write(`授权二维码：${png}\n`); qr.generate(authorization.verificationUrl, { small: true });
      if (values["no-wait"] || !process.stdin.isTTY) {
        process.stdout.write("确认授权后，再执行相同命令并加 --complete。\n"); process.exit(0);
      }
      // Poll only in an interactive terminal, where the user has already received the URL/QR.
      for (;;) {
        try { status = await account.complete(); break; }
        catch (error) {
          if (!(error instanceof Error) || !["feishu_authorization_not_completed", "lark_cli_execution_interrupted"].includes(error.message)) throw error;
          if (Date.parse(authorization.expiresAt) <= Date.now()) throw new Error("feishu_authorization_expired");
          process.stdout.write("仍在等待个人授权确认…\n"); await sleep(1000);
        }
      }
    }
  }
  process.stdout.write(JSON.stringify({ status: "ready", user: status.userName, connection: {
    id: "feishu", kind: "feishu", credentialsFile: path, personalTools: true,
  } }, null, 2) + "\n");
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "feishu_setup_failed";
  process.stderr.write(`${code}\n`); process.exitCode = 1;
}
