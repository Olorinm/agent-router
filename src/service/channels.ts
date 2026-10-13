import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { ManagedAgent, ServiceExtension } from "../matrix/managed.js";
import type { MatrixConnector } from "../matrix/connector.js";
import { CommunicationCore } from "../communication/core.js";
import { MatrixChannel } from "../channels/matrix.js";
import { FeishuChannel } from "../channels/feishu.js";
import { TelegramChannel } from "../channels/telegram.js";
import { GroveMailChannel } from "../channels/grove-mail.js";
import { ServiceHttp } from "../channels/http.js";
import { WeixinChannel } from "../channels/weixin/index.js";
import { HttpAgentHost } from "../execution/host.js";
import { HostWorker } from "../execution/host-worker.js";
import type { ChannelAdapter } from "../communication/types.js";
import { digest, key } from "../execution/protocol.js";
import { FeishuAccount, loadFeishuCredentials } from "../services/feishu/cli.js";
import { ChannelTools } from "../communication/tools.js";
import { FeishuTools } from "../services/feishu/tools.js";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const file = z.string().min(1);
const addresses = z.array(z.string().min(1).max(512)).max(100).default([]);
const common = { id, ownerAddresses: addresses, peerAddresses: addresses, groupIds: addresses };
const connection = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("matrix") }).strict(),
  z.object({ ...common, kind: z.literal("feishu"), appId: z.string().min(1).optional(), appSecretFile: file.optional(),
    credentialsFile: file.optional(), personalTools: z.boolean().default(false), domain: z.enum(["feishu", "lark"]).default("feishu") }).strict(),
  z.object({ ...common, kind: z.literal("telegram"), botTokenFile: file }).strict(),
  z.object({ ...common, kind: z.literal("grove-mail"), url: z.url(), inboxId: z.email(), apiKeyFile: file, initialCursor: z.number().int().nonnegative().default(0), attachmentOrigins: z.array(z.url()).default([]) }).strict(),
  z.object({ ...common, kind: z.literal("weixin"), credentialsFile: file }).strict(),
]);
export const agentChannelConfigSchema = z.object({ agentId: z.uuid(), connections: z.array(connection).max(20),
  host: z.object({ url: z.url(), tokenFile: file, runtimeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/),
    instanceName: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/).default("channel-host"), instructions: z.string().max(200_000).default("") }).strict().optional() }).strict();
export const channelConfigSchema = z.object({ agents: z.array(agentChannelConfigSchema).min(1).max(100) }).strict().superRefine((config, context) => {
  if (new Set(config.agents.map((agent) => agent.agentId)).size !== config.agents.length) context.addIssue({ code: "custom", message: "duplicate_agent_id" });
  for (const agent of config.agents) {
    if (new Set(agent.connections.map((item) => item.id)).size !== agent.connections.length) context.addIssue({ code: "custom", message: "duplicate_connection_id" });
    if (agent.connections.filter((item) => item.kind === "matrix").length > 1) context.addIssue({ code: "custom", message: "one_matrix_connection_per_agent" });
    for (const item of agent.connections) if (item.kind === "weixin" && item.groupIds.length)
      context.addIssue({ code: "custom", message: "weixin_bot_api_supports_private_conversations_only" });
    for (const item of agent.connections) if (item.kind === "feishu") {
      if (item.credentialsFile ? item.appId || item.appSecretFile : !item.appId || !item.appSecretFile)
        context.addIssue({ code: "custom", message: "feishu_credentials_file_or_application_pair_required" });
      if (item.personalTools && (!item.credentialsFile || !agent.host))
        context.addIssue({ code: "custom", message: "feishu_personal_tools_require_credentials_and_host" });
    }
  }
});
export type AgentChannelConfig = z.infer<typeof agentChannelConfigSchema>;
export interface ChannelConfiguration { agents: AgentChannelConfig[]; directory: string; }
export function loadChannelConfiguration(path: string): ChannelConfiguration {
  const config = { ...channelConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))), directory: dirname(resolve(path)) };
  const accounts = new Set<string>();
  for (const agent of config.agents) for (const item of agent.connections) {
    const feishu = item.kind === "feishu" && item.credentialsFile ? loadFeishuCredentials(resolve(config.directory, item.credentialsFile)).credentials : undefined;
    if (feishu && item.ownerAddresses.length && (item.ownerAddresses.length !== 1 || item.ownerAddresses[0] !== feishu.ownerOpenId)) throw new Error("feishu_owner_binding_mismatch");
    const account = item.kind === "matrix" ? agent.agentId : item.kind === "feishu" ? key(feishu?.domain ?? item.domain, feishu?.appId ?? item.appId!) :
      item.kind === "telegram" ? digest(secret(config.directory, item.botTokenFile)) :
        item.kind === "grove-mail" ? key(item.url.replace(/\/$/, ""), item.inboxId) :
          loadWeixinCredentials(resolve(config.directory, item.credentialsFile)).accountId;
    const identity = key(item.kind, account);
    if (accounts.has(identity)) throw new Error("channel_account_configured_more_than_once");
    accounts.add(identity);
  }
  return config;
}
function secret(directory: string, path: string): string {
  const value = readFileSync(resolve(directory, path), "utf8").trim();
  if (!value) throw new Error("empty_channel_credential");
  return value;
}
const credentialsSchema = z.object({ accountId: z.string().min(1), userId: z.string().min(1), token: z.string().min(1), baseUrl: z.url() }).strict();
export function loadWeixinCredentials(path: string) {
  const credentials = credentialsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const url = new URL(credentials.baseUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".weixin.qq.com") || url.username || url.password || url.search || url.hash) throw new Error("invalid_weixin_api_origin");
  return credentials;
}

export async function createChannelRuntime(agent: ManagedAgent, connector: MatrixConnector, config: AgentChannelConfig,
  directory: string, issue: (name: string) => { id: string; validate: () => void }): Promise<ServiceExtension> {
  if (!connector.cli) throw new Error("channels_require_durable_work_queue");
  const core = new CommunicationCore(agent.id, connector.store, connector.cli, () => connector.assertLease());
  const accounts = new Map<string, FeishuAccount>(), personalTools = new Map<string, FeishuTools>();
  for (const definition of config.connections) {
    let adapter: ChannelAdapter;
    let ownerAddresses = definition.ownerAddresses;
    switch (definition.kind) {
      case "matrix": adapter = new MatrixChannel(connector); if (!ownerAddresses.length) ownerAddresses = [agent.owner]; break;
      case "feishu": {
        if (definition.credentialsFile) {
          const loaded = loadFeishuCredentials(resolve(directory, definition.credentialsFile));
          const { credentials } = loaded;
          if (ownerAddresses.length && (ownerAddresses.length !== 1 || ownerAddresses[0] !== credentials.ownerOpenId)) throw new Error("feishu_owner_binding_mismatch");
          ownerAddresses = [credentials.ownerOpenId];
          adapter = new FeishuChannel({ appId: credentials.appId, appSecret: loaded.appSecret, domain: credentials.domain });
          const account = new FeishuAccount(credentials, loaded.directory); accounts.set(definition.id, account);
          if (definition.personalTools) { const tools = new FeishuTools(definition.id, account); personalTools.set(tools.definition.name, tools); }
        } else adapter = new FeishuChannel({ appId: definition.appId!, appSecret: secret(directory, definition.appSecretFile!),
          domain: definition.domain });
        break;
      }
      case "telegram": adapter = new TelegramChannel(secret(directory, definition.botTokenFile)); break;
      case "grove-mail": adapter = new GroveMailChannel(definition.inboxId,
        new ServiceHttp(definition.url, secret(directory, definition.apiKeyFile)), definition.initialCursor, definition.attachmentOrigins); break;
      case "weixin": {
        const credentials = loadWeixinCredentials(resolve(directory, definition.credentialsFile));
        adapter = new WeixinChannel(credentials); if (!ownerAddresses.length) ownerAddresses = [credentials.userId]; break;
      }
    }
    core.register({ id: definition.id, ownerAddresses, peerAddresses: definition.peerAddresses, groupIds: definition.groupIds }, adapter, () => {
      if (definition.kind === "matrix") return adapter;
      if (definition.kind === "telegram") return new TelegramChannel(secret(directory, definition.botTokenFile));
      if (definition.kind === "weixin") return new WeixinChannel(loadWeixinCredentials(resolve(directory, definition.credentialsFile)));
      if (definition.kind === "grove-mail") return new GroveMailChannel(definition.inboxId, new ServiceHttp(definition.url, secret(directory, definition.apiKeyFile)), definition.initialCursor, definition.attachmentOrigins);
      if (!definition.credentialsFile) return new FeishuChannel({ appId: definition.appId!, appSecret: secret(directory, definition.appSecretFile!), domain: definition.domain });
      const loaded = loadFeishuCredentials(resolve(directory, definition.credentialsFile));
      if (loaded.credentials.ownerOpenId !== ownerAddresses[0]) throw new Error("feishu_owner_binding_mismatch");
      return new FeishuChannel({ appId: loaded.credentials.appId, appSecret: loaded.appSecret, domain: loaded.credentials.domain });
    });
    // Install the synchronous Matrix receipt hook before its first /sync transaction.
    if (adapter.kind === "matrix") await adapter.start(core.context(definition.id));
  }
  let worker: HostWorker | undefined;
  if (config.host) {
    const instance = issue(config.host.instanceName);
    const host = new HttpAgentHost(new ServiceHttp(config.host.url, secret(directory, config.host.tokenFile)));
    const channelTools = new ChannelTools(core, host);
    worker = new HostWorker(agent.id, instance.id, connector.store, connector.cli,
      host, config.host.runtimeId,
      config.host.instructions, () => { connector.assertLease(); instance.validate(); }, (taskId, answer) => core.saveResult(taskId, answer),
      { definitions: [channelTools.definition, ...[...personalTools.values()].map((tools) => tools.definition)],
        instructions: "\nUse the channel tool to inspect native communication capabilities and send files or supported native content. Use the Feishu product tool for the owner's calendar, documents and other linked resources. Read its official skills/schema/help before unfamiliar commands. Personal authorization is managed by the communication service; never ask for tokens in chat or change CLI identity/configuration. If authorization is required, tell the owner to complete the connection's authorization flow. Follow official CLI confirmation requirements. Never automatically repeat an operation with an uncertain outcome.\n",
        allowed: (_conversationId, taskId) => Boolean(core.input(taskId)),
        execute: async (call) => {
          if (call.name === channelTools.definition.name) return channelTools.execute(call);
          const binding = worker!.status().runs.find((run) => run.runId === call.runId);
          if (!binding || !core.isOwnerTask(binding.conversationId, binding.taskId)) return { success: false, contentItems: [{ type: "inputText", text: "personal_tools_require_owner_conversation" }] };
          const original = personalTools.get(call.name)!;
          const tools = new FeishuTools(original.id, original.account, async (_call, item) => {
            const path = `.agent-host/attachments/${call.runId}/${digest(item.data)}/${item.name.replace(/[^\p{L}\p{N}_.-]/gu, "_")}`;
            await host.writeFile!(binding.sessionId, path, item.data); return path;
          });
          return tools.execute(call);
        } }, core);
    core.control = (input) => worker!.handleInput(input);
  }
  const controller = new AbortController();
  let loops: Promise<void>[] = [];
  const loop = async (operation: () => Promise<void>, interval: number) => {
    while (!controller.signal.aborted) {
      try { await operation(); } catch { /* Durable records remain pending; status exposes channel/Host failures. */ }
      try { await sleep(interval, undefined, { signal: controller.signal }); } catch { break; }
    }
  };
  return {
    start: async () => { await core.start(); loops = [loop(async () => { await core.reconnect(); await core.dispatch(); await core.flush(); }, 250),
      ...(worker ? [loop(() => worker!.tick(), 1000)] : []),
      ...(accounts.size ? [loop(async () => { await Promise.allSettled([...accounts.values()].map((account) => account.pollAuthorization())); }, 5000)] : [])]; },
    stop: async () => { controller.abort(); await core.stop(); await Promise.allSettled(loops); },
    status: () => ({ ...core.status(), host: worker?.status() ?? null }),
    resolve: async (callId, result) => { if (!worker) throw new Error("host_not_configured"); await worker.resolve(callId, result); },
    reconcile: async (claimId, runId) => { if (!worker) throw new Error("host_not_configured"); await worker.reconcile(claimId, runId); },
    closeUnknown: async (claimId) => { if (!worker) throw new Error("host_not_configured"); await worker.closeUnknown(claimId); },
    authorization: async (connectionId, action) => {
      connector.assertLease(); const account = accounts.get(connectionId);
      if (!account) throw new Error("connection_personal_authorization_not_configured");
      if (action === "begin") return account.begin();
      if (action === "complete") return account.complete();
      return account.status(true);
    },
  };
}
