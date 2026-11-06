import { z } from "zod";
import { Client, Domain } from "@larksuiteoapi/node-sdk";
import { configFile, connectionFields, defineChannel, key, type ChannelCheckResult, type ChannelTool } from "../api.js";
// Personal tools stay in `src/services/feishu` until they move to connectors; only this module uses them.
import { FeishuAccount, loadFeishuCredentials } from "../../services/feishu/cli.js";
import { FeishuTools } from "../../services/feishu/tools.js";
import { FeishuChannel } from "./channel.js";

export { FeishuChannel } from "./channel.js";
export { feishuActivity } from "./activity.js";
export { FEISHU_EMOJIS } from "./emojis.js";

const ownerMismatch = (addresses: string[], ownerOpenId: string) => addresses.length && (addresses.length !== 1 || addresses[0] !== ownerOpenId);
function personalTool(id: string, account: FeishuAccount): ChannelTool {
  return { definition: new FeishuTools(id, account).definition,
    execute: (call, transfer) => new FeishuTools(id, account, (_call, item) => transfer(item)).execute(call) };
}

export const feishuChannel = defineChannel({
  kind: "feishu",
  schema: z.object({ ...connectionFields, kind: z.literal("feishu"), appId: z.string().min(1).optional(), appSecretFile: configFile.optional(),
    credentialsFile: configFile.optional(), personalTools: z.boolean().default(false), domain: z.enum(["feishu", "lark"]).default("feishu") }).strict(),
  validate: (config, agent) => [
    ...(config.credentialsFile ? config.appId || config.appSecretFile : !config.appId || !config.appSecretFile) ? ["feishu_credentials_file_or_application_pair_required"] : [],
    ...config.personalTools && (!config.credentialsFile || !agent.host) ? ["feishu_personal_tools_require_credentials_and_host"] : [],
  ],
  account: (config, { files }) => {
    const credentials = config.credentialsFile ? loadFeishuCredentials(files.path(config.credentialsFile)).credentials : undefined;
    if (credentials && ownerMismatch(config.ownerAddresses, credentials.ownerOpenId)) throw new Error("feishu_owner_binding_mismatch");
    return key(credentials?.domain ?? config.domain, credentials?.appId ?? config.appId!);
  },
  create: (config, { files }) => {
    if (!config.credentialsFile) {
      const make = () => new FeishuChannel({ appId: config.appId!, appSecret: files.secret(config.appSecretFile!), domain: config.domain });
      return { adapter: make(), reload: make, namespace: config.appId ?? "" };
    }
    const credentialsFile = files.path(config.credentialsFile);
    const { credentials, appSecret, directory } = loadFeishuCredentials(credentialsFile);
    if (ownerMismatch(config.ownerAddresses, credentials.ownerOpenId)) throw new Error("feishu_owner_binding_mismatch");
    const account = new FeishuAccount(credentials, directory);
    return {
      adapter: new FeishuChannel({ appId: credentials.appId, appSecret, domain: credentials.domain }),
      reload: () => {
        const loaded = loadFeishuCredentials(credentialsFile);
        if (loaded.credentials.ownerOpenId !== credentials.ownerOpenId) throw new Error("feishu_owner_binding_mismatch");
        return new FeishuChannel({ appId: loaded.credentials.appId, appSecret: loaded.appSecret, domain: loaded.credentials.domain });
      },
      ownerAddresses: [credentials.ownerOpenId], namespace: credentials.appId,
      authorization: { begin: () => account.begin(), complete: () => account.complete(), status: (verify) => account.status(verify), poll: () => account.pollAuthorization() },
      ...(config.personalTools ? { tools: [personalTool(config.id, account)] } : {}),
    };
  },
  check: async (config, files) => {
    const loaded = config.credentialsFile ? loadFeishuCredentials(files.path(config.credentialsFile)) : undefined;
    const appId = loaded?.credentials.appId ?? config.appId!, appSecret = loaded?.appSecret ?? files.read(config.appSecretFile!);
    const client = new Client({ appId, appSecret, domain: (loaded?.credentials.domain ?? config.domain) === "lark" ? Domain.Lark : Domain.Feishu,
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
    const result = await client.request({ method: "GET", url: "/open-apis/bot/v3/info", timeout: 15_000 });
    if (result.code !== 0 || !result.bot?.open_id) throw new Error("feishu_bot_unavailable");
    const check: ChannelCheckResult = { status: "verified", detail: "Bot identity verified", extra: [] };
    if (config.personalTools && loaded) {
      const personal: NonNullable<ChannelCheckResult["extra"]>[number] = { kind: "feishu_personal", status: "needs_action", detail: "Personal authorization check failed; bot messaging is independent" };
      try {
        const user = await new FeishuAccount(loaded.credentials, loaded.directory).status(true);
        personal.status = user.authorized && user.verified ? "verified" : "needs_action";
        personal.detail = user.authorized && user.verified ? "Linked personal identity verified" : "Authorize personal tools when needed; see the separate bot check";
      } catch { /* Personal tool credentials do not determine bot availability. */ }
      check.extra!.push(personal);
    }
    if (!(loaded?.credentials.ownerOpenId || config.ownerAddresses.length)) { check.status = "needs_action"; check.detail = "Bind the owner's Feishu open_id"; }
    return check;
  },
});
