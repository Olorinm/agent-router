import { readFileSync } from "node:fs";
import { z } from "zod";
import { configFile, connectionFields, defineChannel } from "../api.js";
import { WeixinChannel } from "./channel.js";

export { WeixinChannel, type WeixinCredentials } from "./channel.js";
/** Tencent iLink HTTP helpers for the QR login flow of connection setup. */
export { apiGetFetch, apiPostFetch } from "./vendor/api.js";

const credentialsSchema = z.object({ accountId: z.string().min(1), userId: z.string().min(1), token: z.string().min(1), baseUrl: z.url() }).strict();
export function loadWeixinCredentials(path: string) {
  const credentials = credentialsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const url = new URL(credentials.baseUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".weixin.qq.com") || url.username || url.password || url.search || url.hash) throw new Error("invalid_weixin_api_origin");
  return credentials;
}

export const weixinChannel = defineChannel({
  kind: "weixin",
  schema: z.object({ ...connectionFields, kind: z.literal("weixin"), credentialsFile: configFile }).strict(),
  runningVerifies: true,
  validate: (config) => config.groupIds.length ? ["weixin_bot_api_supports_private_conversations_only"] : [],
  account: (config, { files }) => loadWeixinCredentials(files.path(config.credentialsFile)).accountId,
  create: (config, { files }) => {
    const credentials = loadWeixinCredentials(files.path(config.credentialsFile));
    return { adapter: new WeixinChannel(credentials), reload: () => new WeixinChannel(loadWeixinCredentials(files.path(config.credentialsFile))),
      ownerAddresses: config.ownerAddresses.length ? config.ownerAddresses : [credentials.userId] };
  },
  check: async (config, files) => {
    loadWeixinCredentials(files.path(config.credentialsFile));
    return { status: "not_verified", detail: "Credential file validated; login is verified by the running Tencent poller, not by a second consumer" };
  },
});
