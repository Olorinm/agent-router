import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Bot } from "grammy";
import { Client, Domain } from "@larksuiteoapi/node-sdk";
import { ServiceHttp } from "../channels/http.js";
import { FeishuAccount, loadFeishuCredentials } from "../services/feishu/cli.js";
import { loadWeixinCredentials, type ChannelConfiguration } from "./channels.js";

export interface Check { agentId: string; connectionId?: string; kind: string; status: "verified" | "needs_action" | "not_verified"; detail: string; }
/** Checks access without starting consumers, consuming messages, sending replies or running a model. */
export async function checkChannels(configuration: ChannelConfiguration, node?: ServiceHttp): Promise<Check[]> {
  const checks: Check[] = [], file = (path: string) => readFileSync(resolve(configuration.directory, path), "utf8").trim();
  for (const agent of configuration.agents) {
    if (agent.host) {
      try {
        const host = new ServiceHttp(agent.host.url, file(agent.host.tokenFile));
        const health = await host.request("/v1/health"), runtimes = await host.request("/v1/runtimes");
        if (health.protocolVersion !== 1 || !runtimes.runtimes?.some((item: { id: string }) => item.id === agent.host!.runtimeId)) throw new Error("host_runtime_not_found");
        checks.push({ agentId: agent.agentId, kind: "host", status: "verified", detail: "HTTP service and runtime exist; model execution has not been tested" });
      } catch { checks.push({ agentId: agent.agentId, kind: "host", status: "needs_action", detail: "Host address/token/runtime check failed" }); }
    } else checks.push({ agentId: agent.agentId, kind: "host", status: "not_verified", detail: "No direct Host configured; an external worker is required" });
    let live: any;
    if (node) try { live = await node.request(`/_agent-router/v1/agents/${encodeURIComponent(agent.agentId)}/communication`); } catch { /* Each channel will report unverified service state. */ }
    for (const connection of agent.connections) {
      const check: Check = { agentId: agent.agentId, connectionId: connection.id, kind: connection.kind, status: "not_verified", detail: "" };
      try {
        switch (connection.kind) {
          case "feishu": {
            const loaded = connection.credentialsFile ? loadFeishuCredentials(resolve(configuration.directory, connection.credentialsFile)) : undefined;
            const appId = loaded?.credentials.appId ?? connection.appId!, appSecret = loaded?.appSecret ?? file(connection.appSecretFile!);
            const client = new Client({ appId, appSecret, domain: (loaded?.credentials.domain ?? connection.domain) === "lark" ? Domain.Lark : Domain.Feishu,
              logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
            const result = await client.request({ method: "GET", url: "/open-apis/bot/v3/info", timeout: 15_000 });
            if (result.code !== 0 || !result.bot?.open_id) throw new Error("feishu_bot_unavailable");
            if (connection.personalTools && loaded) {
              const user = await new FeishuAccount(loaded.credentials, loaded.directory).status(true);
              check.status = user.authorized && user.verified ? "verified" : "needs_action";
              check.detail = user.authorized && user.verified ? "Bot and linked personal identity verified" : "Complete the linked owner's personal authorization";
            } else { check.status = "verified"; check.detail = "Bot identity verified; personal tools are not configured"; }
            if (!(loaded?.credentials.ownerOpenId || connection.ownerAddresses.length)) { check.status = "needs_action"; check.detail = "Bind the owner's Feishu open_id"; }
            break;
          }
          case "telegram": {
            const bot = new Bot(file(connection.botTokenFile), { client: { timeoutSeconds: 15 } });
            const signal = AbortSignal.timeout(15_000) as Parameters<typeof bot.api.getWebhookInfo>[0];
            await bot.api.getMe(signal);
            const webhook = await bot.api.getWebhookInfo(signal);
            check.status = webhook.url || !connection.ownerAddresses.length ? "needs_action" : "verified";
            check.detail = webhook.url ? "Remove the existing webhook before using polling" : !connection.ownerAddresses.length ? "Bind the owner's numeric Telegram user ID" : "Bot token verified; polling needs exclusive ownership";
            break;
          }
          case "grove-mail": {
            const mail = new ServiceHttp(connection.url, file(connection.apiKeyFile));
            const inbox = await mail.request(`/v0/inboxes/${encodeURIComponent(connection.inboxId)}`);
            if (inbox.inbox_id !== connection.inboxId) throw new Error("mail_inbox_mismatch");
            check.status = connection.ownerAddresses.length ? "verified" : "needs_action";
            check.detail = connection.ownerAddresses.length ? "Grove Mail inbox access verified; external SMTP delivery has not been tested" : "Bind the owner's sender email address";
            break;
          }
          case "weixin": {
            loadWeixinCredentials(resolve(configuration.directory, connection.credentialsFile));
            check.detail = "Credential file validated; login is verified by the running Tencent poller, not by a second consumer"; break;
          }
          case "matrix": check.detail = "Uses the managed node's Application Service identity; provide node status to verify startup"; break;
        }
        const running = live?.connections?.find((item: { id: string }) => item.id === connection.id);
        if (node && (!running?.started || running?.error)) { check.status = "needs_action"; check.detail += "; Router connection is not running cleanly"; }
        else if (running && ["matrix", "weixin"].includes(connection.kind)) { check.status = "verified"; check.detail += "; Router reports successful startup (send/receive still needs a real message)"; }
      } catch { check.status = "needs_action"; check.detail = `${connection.kind} credential/access check failed`; }
      checks.push(check);
    }
  }
  return checks;
}
