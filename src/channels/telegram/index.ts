import { z } from "zod";
import { Bot } from "grammy";
import { configFile, connectionFields, defineChannel, digest } from "../api.js";
import { TelegramChannel } from "./channel.js";

export { TelegramChannel } from "./channel.js";

export const telegramChannel = defineChannel({
  kind: "telegram",
  schema: z.object({ ...connectionFields, kind: z.literal("telegram"), botTokenFile: configFile }).strict(),
  account: (config, { files }) => digest(files.secret(config.botTokenFile)),
  create: (config, { files }) => {
    const make = () => new TelegramChannel(files.secret(config.botTokenFile));
    return { adapter: make(), reload: make };
  },
  check: async (config, files) => {
    const bot = new Bot(files.read(config.botTokenFile), { client: { timeoutSeconds: 15 } });
    const signal = AbortSignal.timeout(15_000) as Parameters<typeof bot.api.getWebhookInfo>[0];
    await bot.api.getMe(signal);
    const webhook = await bot.api.getWebhookInfo(signal);
    return { status: webhook.url || !config.ownerAddresses.length ? "needs_action" : "verified",
      detail: webhook.url ? "Remove the existing webhook before using polling" : !config.ownerAddresses.length ? "Bind the owner's numeric Telegram user ID" : "Bot token verified; polling needs exclusive ownership" };
  },
});
