import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { Bot } from "grammy";
import {
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

interface JobRecord {
  id: string;
  agentId: string;
  kind: string;
  state: string;
  expiresAt: number;
  url?: string;
  error?: string;
  appId?: string | undefined;
  domain?: "feishu" | "lark";
  personalTools?: boolean;
}
interface Job extends JobRecord {
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
const terminal = (job: JobRecord) => ["ready", "failed"].includes(job.state);
const jobsCollection = "connection_setup_jobs";
function safeError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "expired_token") return "feishu_authorization_expired";
    if (error.code === "access_denied") return "feishu_authorization_denied";
    if (error.code === "abort") return "connection_setup_interrupted";
  }
  if (error instanceof Error) {
    if (["AbortError", "TimeoutError"].includes(error.name)) return "connection_setup_interrupted";
    if (/^[a-z][a-z0-9_]{0,100}$/.test(error.message)) return error.message;
  }
  return "connection_setup_failed";
}
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
  private feishuReservations = new Set<string>();
  private telegramReservations = new Set<string>();
  constructor(
    readonly service: ManagedService,
    readonly configuration: ConnectionConfiguration,
  ) {
    // Consent polling belongs to the SDK process. Keep history, but never pretend
    // an interrupted poll can resume from its URL alone.
    for (const { value: job } of service.store.entries<JobRecord>(jobsCollection)) {
      if (terminal(job)) continue;
      const agent = service.agents().find((agent) => agent.id === job.agentId);
      const connected = agent && configuration.configuration(agent)?.connections.some((connection) => connection.kind === job.kind);
      job.state = connected ? "ready" : "failed";
      if (!connected) job.error = "connection_setup_interrupted";
      delete job.url;
      service.store.set(jobsCollection, job.id, job);
    }
  }
  private save(job: Job) {
    const { controller: _controller, operation: _operation, pairingCode: _pairingCode, ...record } = job;
    this.service.store.set(jobsCollection, job.id, record);
  }
  private recovery(job: JobRecord) {
    if (job.kind !== "feishu" || job.state !== "failed") return undefined;
    const directory = join(this.configuration.agentDirectory(job.agentId), "feishu");
    const file = join(directory, "credentials.json");
    let appId = job.appId, domain = job.domain ?? "feishu";
    if (existsSync(file)) {
      try {
        const { credentials } = loadFeishuCredentials(file);
        appId = credentials.appId; domain = credentials.domain;
      } catch { /* Keep the failure visible even when saved credentials need repair. */ }
    }
    const action = existsSync(file) ? "retry_binding"
      : existsSync(join(directory, "creation-pending.json")) || appId ? "authorize_existing_app" : "retry";
    return { action, ...(appId ? { appId } : {}), domain, personalTools: job.personalTools ?? false };
  }
  async close() {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled(
      [...this.jobs.values()].map((job) => job.operation),
    );
  }
  list(owner: string, agentId: string) {
    this.service.owned(agentId, owner);
    return this.service.store.entries<JobRecord>(jobsCollection).map(({ value }) => value)
      .filter((job) => job.agentId === agentId)
      .map((job) => this.status(owner, agentId, job.id));
  }
  status(owner: string, agentId: string, id: string) {
    this.service.owned(agentId, owner);
    const active = this.jobs.get(id);
    const job = active ?? this.service.store.get<JobRecord>(jobsCollection, id);
    if (!job || job.agentId !== agentId)
      throw new WorkError("setup_job_not_found", 404);
    const recovery = this.recovery(job);
    return {
      id,
      kind: job.kind,
      state: job.state,
      expiresAt: new Date(job.expiresAt).toISOString(),
      ...(job.url ? { url: job.url, qr: qrTerminal(job.url) } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(recovery ? { recovery } : {}),
    };
  }
  pairing(owner: string, agentId: string, id: string, code: string) {
    this.status(owner, agentId, id);
    const job = this.jobs.get(id);
    if (
      !job || job.kind !== "weixin" ||
      job.state !== "pairing" ||
      !/^\d{1,12}$/.test(code)
    )
      throw new WorkError("invalid_pairing_code", 400);
    job.pairingCode = code;
    job.state = "waiting";
    this.save(job);
  }
  begin(
    owner: string,
    agentId: string,
    kind: "feishu" | "weixin" | "telegram",
    options: {
      domain?: "feishu" | "lark";
      personalTools?: boolean;
      token?: string;
      appId?: string | undefined;
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
    for (const job of this.jobs.values())
      if (job.expiresAt < Date.now()) {
        job.controller.abort();
        if (!terminal(job)) {
          job.state = "failed";
          job.error = "connection_setup_expired";
          delete job.url;
          this.save(job);
        }
      }
    const prior = [...this.jobs.values()].find(
      (job) =>
        job.agentId === agentId &&
        job.kind === kind &&
        !["ready", "failed"].includes(job.state),
    );
    if (prior) {
      if (kind === "feishu" && ((options.appId && prior.appId !== options.appId) || prior.domain !== (options.domain ?? "feishu") || prior.personalTools !== (options.personalTools ?? false)))
        throw new WorkError("connection_setup_in_progress", 409);
      return this.status(owner, agentId, prior.id);
    }
    if ([...this.jobs.values()].filter((job) => !terminal(job)).length >= 100) throw new WorkError("too_many_setup_jobs", 429);
    const job: Job = {
      id: randomUUID(),
      agentId,
      kind,
      state: "starting",
      expiresAt: Date.now() + 600_000,
      controller: new AbortController(),
      ...(kind === "feishu" ? { domain: options.domain ?? "feishu", personalTools: options.personalTools ?? false, ...(options.appId ? { appId: options.appId } : {}) } : {}),
    };
    this.jobs.set(job.id, job);
    this.save(job);
    // Retain recent owner-visible history without an ever-growing setup log.
    const history = this.service.store.entries<JobRecord>(jobsCollection)
      .filter(({ value }) => value.agentId === agentId && terminal(value));
    for (const old of history.slice(0, Math.max(0, history.length - 100)))
      this.service.store.delete(jobsCollection, old.id);
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
      }).finally(() => {
        this.save(job);
        this.jobs.delete(job.id);
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
    options: { domain?: "feishu" | "lark"; personalTools?: boolean; appId?: string | undefined },
  ) {
    const directory = join(this.configuration.agentDirectory(job.agentId), "feishu"),
      file = join(directory, "credentials.json"), marker = join(directory, "creation-pending.json");
    const domain = options.domain ?? "feishu";
    let reserved: string | undefined;
    const reserve = (appId: string) => {
      this.configuration.assertFeishuAvailable(appId, job.agentId);
      if (this.feishuReservations.has(appId)) throw new Error("feishu_app_setup_in_progress");
      this.feishuReservations.add(appId);
      reserved = appId;
    };
    try {
      if (options.appId && !/^cli_[a-zA-Z0-9_]{1,128}$/.test(options.appId))
        throw new Error("invalid_feishu_app_id");
      if (existsSync(file)) {
        const loaded = loadFeishuCredentials(file);
        if (options.appId && loaded.credentials.appId !== options.appId)
          throw new Error("feishu_saved_app_mismatch");
        if (loaded.credentials.domain !== domain) throw new Error("feishu_saved_domain_mismatch");
        job.appId = loaded.credentials.appId;
        reserve(job.appId);
      } else {
        // An unknown creation outcome must never silently create a second bot.
        if (existsSync(marker) && !options.appId) throw new Error("feishu_creation_outcome_unknown");
        if (options.appId) reserve(options.appId);
        const result = await registerApp({
          source: "agent-router",
          ...(options.appId ? { appId: options.appId } : { createOnly: true }),
          signal: job.controller.signal,
          ...feishuApplication,
          ...(domain === "lark" ? { domain: "accounts.larksuite.com" } : {}),
          onQRCodeReady: (info) => {
            job.controller.signal.throwIfAborted();
            if (!options.appId) privateFile(marker, { startedAt: Date.now() });
            job.url = info.url;
            job.state = "application";
            // The official SDK owns polling and enforces this platform deadline.
            job.expiresAt = Date.now() + (Number.isFinite(info.expireIn) && info.expireIn > 0 ? info.expireIn : 600) * 1000;
            this.save(job);
          },
        });
        job.controller.signal.throwIfAborted();
        if (options.appId && result.client_id !== options.appId) throw new Error("feishu_registered_app_mismatch");
        if (!result.client_id || !result.client_secret) throw new Error("feishu_registration_credentials_missing");
        if (!result.user_info?.open_id) throw new Error("feishu_registration_owner_missing");
        if (result.user_info.tenant_brand && result.user_info.tenant_brand !== domain)
          throw new Error("feishu_registered_domain_mismatch");
        if (!reserved) reserve(result.client_id);
        job.appId = result.client_id;
        // Persist credentials before binding. Retrying a failed binding reuses them.
        privateFile(join(directory, "app-secret"), result.client_secret);
        privateFile(file, { version: 1, appId: result.client_id, appSecretFile: "app-secret",
          domain, ownerOpenId: result.user_info.open_id });
      }
      rmSync(marker, { force: true });
      job.state = "binding";
      delete job.url;
      job.expiresAt = Date.now() + 600_000;
      this.save(job);
      // Personal tools keep stable definitions; personal consent happens on demand.
      await this.configuration.edit(owner, job.agentId, (config) => {
        config.connections.push({ id: "feishu", kind: "feishu", credentialsFile: file,
          personalTools: options.personalTools ?? false, domain,
          ownerAddresses: [], peerAddresses: [], groupIds: [] });
      }, this.signal(job));
    } finally {
      if (reserved) this.feishuReservations.delete(reserved);
    }
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
      this.save(job);
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
      this.save(job);
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
          this.save(job);
          break;
        case "scaned":
          delete job.pairingCode;
          job.state = "waiting";
          this.save(job);
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
