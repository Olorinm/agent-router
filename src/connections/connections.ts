import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { Bot } from "grammy";
import {
  FeishuAccount,
  loadFeishuCredentials,
  privateFile,
} from "../services/feishu/cli.js";
import { feishuApplication } from "../services/feishu/application.js";
import { apiGetFetch, apiPostFetch } from "../channels/weixin/vendor/api.js";
import { loadWeixinCredentials } from "../service/channels.js";
import { key } from "../matrix/protocol.js";
import type { ManagedService } from "../matrix/managed.js";
import { WorkError } from "../matrix/cli-work.js";
import type { ConnectionConfiguration } from "./configuration.js";

interface Job {
  id: string;
  agentId: string;
  kind: string;
  state: string;
  expiresAt: number;
  url?: string;
  error?: string;
  controller: AbortController;
  pairingCode?: string;
  operation?: Promise<void>;
}
export function qrTerminal(url: string): string {
  const parsed = new URL(url);
  if (url.length > 4096 || parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("invalid_authorization_url");
  const QRCode = createRequire(import.meta.url)(
    "qrcode-terminal/vendor/QRCode",
  ) as new (
    version: number,
    level: number,
  ) => {
    addData(text: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  };
  const qr = new QRCode(-1, 1);
  qr.addData(url);
  qr.make();
  const size = qr.getModuleCount(), lines: string[] = [];
  const dark = (row: number, col: number) => row >= 0 && row < size && col >= 0 && col < size && qr.isDark(row, col);
  // Two pixels per terminal cell, with a white quiet zone and no ANSI escapes.
  for (let y = -4; y < size + 4; y += 2) {
    let line = "";
    for (let x = -4; x < size + 4; x++) {
      const top = dark(y, x), bottom = dark(y + 1, x);
      line += top ? (bottom ? " " : "▄") : (bottom ? "▀" : "█");
    }
    lines.push(line);
  }
  return lines.join("\n");
}
const safeError = (error: unknown) =>
  error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(error.message)
    ? error.message
    : "connection_setup_failed";
const weixinOrigin = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".weixin.qq.com") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error("invalid_weixin_api_origin");
  return url.origin;
};

/** Connection credentials remain on the server. Jobs return only consent links and sanitized progress. */
export class ConnectionSetup {
  private jobs = new Map<string, Job>();
  private telegramReservations = new Set<string>();
  constructor(
    readonly service: ManagedService,
    readonly configuration: ConnectionConfiguration,
  ) {}
  async close() {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled(
      [...this.jobs.values()].map((job) => job.operation),
    );
  }
  list(owner: string, agentId: string) {
    this.service.owned(agentId, owner);
    return [...this.jobs.values()]
      .filter((job) => job.agentId === agentId)
      .map((job) => this.status(owner, agentId, job.id));
  }
  status(owner: string, agentId: string, id: string) {
    this.service.owned(agentId, owner);
    const job = this.jobs.get(id);
    if (!job || job.agentId !== agentId)
      throw new WorkError("setup_job_not_found", 404);
    return {
      id,
      kind: job.kind,
      state: job.state,
      expiresAt: new Date(job.expiresAt).toISOString(),
      ...(job.url ? { url: job.url, qr: qrTerminal(job.url) } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }
  pairing(owner: string, agentId: string, id: string, code: string) {
    this.status(owner, agentId, id);
    const job = this.jobs.get(id)!;
    if (
      job.kind !== "weixin" ||
      job.state !== "pairing" ||
      !/^\d{1,12}$/.test(code)
    )
      throw new WorkError("invalid_pairing_code", 400);
    job.pairingCode = code;
    job.state = "waiting";
  }
  begin(
    owner: string,
    agentId: string,
    kind: "feishu" | "weixin" | "telegram",
    options: {
      domain?: "feishu" | "lark";
      personalTools?: boolean;
      token?: string;
    },
  ) {
    const agent = this.service.owned(agentId, owner);
    if (
      this.configuration
        .configuration(agent)
        ?.connections.some((connection) => connection.kind === kind)
    )
      throw new WorkError("platform_already_connected", 409);
    if (this.configuration.configuration(agent)?.connections.some(connection => connection.id === kind))
      throw new WorkError("connection_id_already_used", 409);
    if (
      kind === "feishu" &&
      options.personalTools &&
      !this.configuration.configuration(agent)?.host
    )
      throw new WorkError("select_host_before_personal_tools", 409);
    for (const [id, job] of this.jobs)
      if (job.expiresAt < Date.now()) {
        job.controller.abort();
        this.jobs.delete(id);
      }
    const prior = [...this.jobs.values()].find(
      (job) =>
        job.agentId === agentId &&
        job.kind === kind &&
        !["ready", "failed"].includes(job.state),
    );
    if (prior) return this.status(owner, agentId, prior.id);
    if (this.jobs.size >= 100) throw new WorkError("too_many_setup_jobs", 429);
    const job: Job = {
      id: randomUUID(),
      agentId,
      kind,
      state: "starting",
      expiresAt: Date.now() + 600_000,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    const operation =
      kind === "feishu"
        ? this.feishu(owner, job, options)
        : kind === "weixin"
          ? this.weixin(owner, job)
          : this.telegram(owner, job, options.token ?? "");
    job.operation = operation
      .then(() => {
        job.state = "ready";
        delete job.url;
      })
      .catch((error) => {
        job.state = "failed";
        job.error = safeError(error);
        delete job.url;
      });
    return this.status(owner, agentId, job.id);
  }
  private signal(job: Job) {
    return AbortSignal.any([
      job.controller.signal,
      AbortSignal.timeout(Math.max(1, job.expiresAt - Date.now())),
    ]);
  }
  private async feishu(
    owner: string,
    job: Job,
    options: { domain?: "feishu" | "lark"; personalTools?: boolean },
  ) {
    const directory = join(
        this.configuration.agentDirectory(job.agentId),
        "feishu",
      ),
      file = join(directory, "credentials.json");
    const signal = this.signal(job);
    if (!existsSync(file)) {
      const marker = join(directory, "creation-pending.json");
      if (existsSync(marker))
        throw new Error("feishu_creation_outcome_unknown");
      const result = await registerApp({
        source: "agent-router",
        createOnly: true,
        signal,
        ...feishuApplication,
        ...(options.domain === "lark"
          ? { domain: "accounts.larksuite.com" }
          : {}),
        onQRCodeReady: (info) => {
          privateFile(marker, { startedAt: Date.now() });
          job.url = info.url;
          job.state = "application";
        },
      });
      if (!result.user_info?.open_id)
        throw new Error("feishu_registration_owner_missing");
      privateFile(join(directory, "app-secret"), result.client_secret);
      privateFile(file, {
        version: 1,
        appId: result.client_id,
        appSecretFile: "app-secret",
        domain: result.user_info.tenant_brand ?? options.domain ?? "feishu",
        ownerOpenId: result.user_info.open_id,
      });
    }
    if (options.personalTools) {
      const loaded = loadFeishuCredentials(file),
        account = new FeishuAccount(loaded.credentials, loaded.directory);
      let status = await account.status(true);
      if (!status.authorized || !status.verified) {
        const authorization = await account.authorizationLink();
        job.url = authorization;
        job.state = "authorization";
        while (!status.authorized || !status.verified) {
          signal.throwIfAborted();
          try {
            status = await account.complete();
          } catch (error) {
            if (
              !(error instanceof Error) ||
              ![
                "feishu_authorization_not_completed",
                "lark_cli_execution_interrupted",
              ].includes(error.message)
            )
              throw error;
          }
          if (!status.authorized || !status.verified)
            await sleep(1500, undefined, { signal });
        }
      }
    }
    signal.throwIfAborted();
    await this.configuration.edit(
      owner,
      job.agentId,
      (config) => {
        config.connections.push({
          id: "feishu",
          kind: "feishu",
          credentialsFile: file,
          personalTools: options.personalTools ?? false,
          domain: options.domain ?? "feishu",
          ownerAddresses: [],
          peerAddresses: [],
          groupIds: [],
        });
      },
      signal,
    );
  }
  private async telegram(owner: string, job: Job, token: string) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))
      throw new Error("invalid_telegram_token");
    this.configuration.assertTelegramAvailable(token);
    const account = token.split(":")[0]!;
    if (this.telegramReservations.has(account))
      throw new Error("telegram_bot_setup_in_progress");
    this.telegramReservations.add(account);
    try {
      const bot = new Bot(token, { client: { timeoutSeconds: 15 } }),
        signal = this.signal(job);
      const [me, webhook] = await Promise.all([
        bot.api.getMe(),
        bot.api.getWebhookInfo(),
      ]);
      if (webhook.url) throw new Error("telegram_webhook_conflict");
      if (!me.username) throw new Error("telegram_bot_username_missing");
      const nonce = randomBytes(24).toString("hex");
      job.url = "https://t.me/" + me.username + "?start=" + nonce;
      job.state = "telegram_pairing";
      let offset = 0;
      for (;;) {
        signal.throwIfAborted();
        const updates = await bot.api.getUpdates(
          { offset, timeout: 10, allowed_updates: ["message"] },
          signal as Parameters<typeof bot.api.getUpdates>[1],
        );
        offset = Math.max(
          offset,
          ...updates.map((update) => update.update_id + 1),
        );
        const proof = updates.find(
          (update) =>
            update.message?.chat.type === "private" &&
            !update.message.from?.is_bot &&
            update.message.text === "/start " + nonce,
        )?.message;
        if (!proof?.from) continue;
        signal.throwIfAborted();
        const file = join(
          this.configuration.agentDirectory(job.agentId),
          "telegram-token",
        );
        privateFile(file, token);
        const runtime = await this.service.runtime(job.agentId);
        runtime.connector.store.set(
          "communication_checkpoints",
          key("telegram", "update"),
          offset - 1,
        );
        await this.configuration.edit(
          owner,
          job.agentId,
          (config) => {
            config.connections.push({
              id: "telegram",
              kind: "telegram",
              botTokenFile: file,
              ownerAddresses: [String(proof.from!.id)],
              peerAddresses: [],
              groupIds: [],
            });
          },
          signal,
        );
        return;
      }
    } finally {
      this.telegramReservations.delete(account);
    }
  }
  private async connectWeixin(owner: string, job: Job, file: string, signal: AbortSignal) {
    loadWeixinCredentials(file);
    await this.configuration.edit(owner, job.agentId, (config) => {
      config.connections.push({id: "weixin", kind: "weixin", credentialsFile: file,
        ownerAddresses: [], peerAddresses: [], groupIds: []});
    }, signal);
  }
  private async weixin(owner: string, job: Job) {
    const signal = this.signal(job),
      base = "https://ilinkai.weixin.qq.com",
      saved = join(this.configuration.agentDirectory(job.agentId), "weixin.json");
    // A prior confirmed scan may have failed while replacing a busy runtime.
    // Keep that consent instead of creating another login for the same account.
    if (existsSync(saved)) { await this.connectWeixin(owner, job, saved, signal); return; }
    let qrcode = "",
      origin = base,
      refreshes = 0;
    const refresh = async () => {
      if (++refreshes > 3) throw new Error("weixin_qr_expired");
      const value = JSON.parse(
        await apiPostFetch({
          baseUrl: base,
          endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
          body: JSON.stringify({ local_token_list: [] }),
          timeoutMs: 15_000,
          abortSignal: signal,
          label: "onboarding_qr",
        }),
      );
      if (
        typeof value.qrcode !== "string" ||
        typeof value.qrcode_img_content !== "string"
      )
        throw new Error("weixin_qr_unavailable");
      qrcode = value.qrcode;
      job.url = value.qrcode_img_content;
      job.state = "waiting";
      origin = base;
    };
    await refresh();
    while (Date.now() < job.expiresAt) {
      signal.throwIfAborted();
      if (job.state === "pairing") {
        await sleep(500, undefined, { signal });
        continue;
      }
      let value: Record<string, string>;
      try {
        value = JSON.parse(
          await apiGetFetch({
            baseUrl: origin,
            endpoint:
              "ilink/bot/get_qrcode_status?qrcode=" +
              encodeURIComponent(qrcode) +
              (job.pairingCode
                ? "&verify_code=" + encodeURIComponent(job.pairingCode)
                : ""),
            timeoutMs: 35_000,
            label: "onboarding_qr_status",
          }),
        );
      } catch {
        await sleep(1000, undefined, { signal });
        continue;
      }
      signal.throwIfAborted();
      switch (value.status) {
        case "expired":
        case "verify_code_blocked":
          delete job.pairingCode;
          await refresh();
          break;
        case "need_verifycode":
          delete job.pairingCode;
          job.state = "pairing";
          break;
        case "scaned":
          delete job.pairingCode;
          job.state = "waiting";
          break;
        case "scaned_but_redirect":
          if (value.redirect_host)
            origin = weixinOrigin("https://" + value.redirect_host);
          break;
        case "binded_redirect":
          throw new Error("weixin_already_bound_reuse_credentials");
        case "confirmed": {
          if (!value.bot_token || !value.ilink_bot_id || !value.ilink_user_id)
            throw new Error("weixin_credentials_missing");
          const file = join(
            this.configuration.agentDirectory(job.agentId),
            "weixin.json",
          );
          privateFile(file, {
            accountId: value.ilink_bot_id,
            userId: value.ilink_user_id,
            token: value.bot_token,
            baseUrl: weixinOrigin(value.baseurl || base),
          });
          await this.connectWeixin(owner, job, file, signal);
          return;
        }
      }
      await sleep(1000, undefined, { signal });
    }
    throw new Error("weixin_qr_expired");
  }
}
