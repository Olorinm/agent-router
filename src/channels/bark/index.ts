import { z } from "zod";
import { configFile, connectionFields, defineChannel, notifyPolicy } from "../api.js";
import { account, BarkChannel } from "./channel.js";

export { BarkChannel } from "./channel.js";

/** HTTPS, or plain HTTP on the loopback interface (a local bark-server). */
const server = z.url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
}, "bark_server_requires_https");

export const barkChannel = defineChannel({
  kind: "bark",
  schema: z.object({ ...connectionFields, kind: z.literal("bark"), server, deviceKeyFile: configFile,
    encryptionKeyFile: configFile.optional(), basicAuthFile: configFile.optional(),
    title: z.string().min(1).max(64).default("Agent"), openUrl: z.url().optional(), preview: z.boolean().default(true),
    maxLength: z.number().int().min(20).max(1000).default(300), notify: notifyPolicy.default(notifyPolicy.parse({})) }).strict(),
  // A push channel has no senders: owner, peer and group lists do not apply.
  validate: (config) => config.ownerAddresses.length || config.peerAddresses.length || config.groupIds.length ? ["bark_is_send_only"] : [],
  account: (config, { files }) => account(config.server, files.secret(config.deviceKeyFile)),
  create: (config, { files }) => {
    const key = config.encryptionKeyFile ? files.secret(config.encryptionKeyFile) : undefined;
    if (key && ![16, 24, 32].includes(Buffer.byteLength(key))) throw new Error("bark_encryption_key_length");
    const make = () => new BarkChannel({ server: config.server, deviceKey: files.secret(config.deviceKeyFile), encryptionKey: key,
      basicAuth: config.basicAuthFile ? files.secret(config.basicAuthFile) : undefined, title: config.title, openUrl: config.openUrl,
      preview: config.preview, maxLength: config.maxLength });
    return { adapter: make(), reload: make, notify: config.notify };
  },
  check: async (config, files) => {
    const auth = config.basicAuthFile ? { authorization: `Basic ${Buffer.from(files.secret(config.basicAuthFile)).toString("base64")}` } : undefined;
    const response = await fetch(`${config.server.replace(/\/$/, "")}/ping`, { redirect: "error", signal: AbortSignal.timeout(15_000), ...(auth ? { headers: auth } : {}) });
    const result = await response.json().catch(() => null) as { code?: unknown } | null;
    if (!response.ok || result?.code !== 200) return { status: "needs_action", detail: `Bark server answered HTTP ${response.status}` };
    return { status: "not_verified", detail: "Bark server reachable; delivery to the device is only confirmed by a test notification" };
  },
});
