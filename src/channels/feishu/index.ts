import { z } from "zod";
import { Client, Domain } from "@larksuiteoapi/node-sdk";
import { configFile, connectionFields, defineChannel, key, type ChannelCheckResult } from "../api.js";
import { loadFeishuCredentials } from "../../services/feishu/cli.js";
import { FeishuChannel } from "./channel.js";

export { FeishuChannel } from "./channel.js";
export { feishuActivity } from "./activity.js";
export { FEISHU_EMOJIS } from "./emojis.js";

const ownerMismatch = (addresses: string[], ownerOpenId: string) => addresses.length && (addresses.length !== 1 || addresses[0] !== ownerOpenId);

export const feishuChannel = defineChannel({
  kind: "feishu",
  schema: z.object({ ...connectionFields, kind: z.literal("feishu"), appId: z.string().min(1).optional(), appSecretFile: configFile.optional(),
    credentialsFile: configFile.optional(),
    /** Deprecated and ignored: personal (user-identity) tools are no longer part of Router. Accepted so existing files still load. */
    personalTools: z.boolean().optional(),
    domain: z.enum(["feishu", "lark"]).default("feishu") }).strict(),
  validate: (config) => [
    ...(config.credentialsFile ? config.appId || config.appSecretFile : !config.appId || !config.appSecretFile) ? ["feishu_credentials_file_or_application_pair_required"] : [],
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
    const { credentials, appSecret } = loadFeishuCredentials(credentialsFile);
    if (ownerMismatch(config.ownerAddresses, credentials.ownerOpenId)) throw new Error("feishu_owner_binding_mismatch");
    return {
      adapter: new FeishuChannel({ appId: credentials.appId, appSecret, domain: credentials.domain }),
      reload: () => {
        const loaded = loadFeishuCredentials(credentialsFile);
        if (loaded.credentials.ownerOpenId !== credentials.ownerOpenId) throw new Error("feishu_owner_binding_mismatch");
        return new FeishuChannel({ appId: loaded.credentials.appId, appSecret: loaded.appSecret, domain: loaded.credentials.domain });
      },
      ownerAddresses: [credentials.ownerOpenId], namespace: credentials.appId,
    };
  },
  check: async (config, files) => {
    const loaded = config.credentialsFile ? loadFeishuCredentials(files.path(config.credentialsFile)) : undefined;
    const appId = loaded?.credentials.appId ?? config.appId!, appSecret = loaded?.appSecret ?? files.read(config.appSecretFile!);
    const client = new Client({ appId, appSecret, domain: (loaded?.credentials.domain ?? config.domain) === "lark" ? Domain.Lark : Domain.Feishu,
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
    const result = await client.request({ method: "GET", url: "/open-apis/bot/v3/info", timeout: 15_000 });
    if (result.code !== 0 || !result.bot?.open_id) throw new Error("feishu_bot_unavailable");
    const check: ChannelCheckResult = { status: "verified", detail: "Bot identity verified" };
    if (!(loaded?.credentials.ownerOpenId || config.ownerAddresses.length)) { check.status = "needs_action"; check.detail = "Bind the owner's Feishu open_id"; }
    return check;
  },
});
