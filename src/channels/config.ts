import { readFileSync } from "node:fs";
import { z } from "zod";
import { channelEntrySchema } from "./types.js";
import { AgentMailAdapter } from "./agentmail.js";
import type { ChannelRouter } from "./router.js";

export const channelConfigSchema = z.object({ entries: z.array(channelEntrySchema.extend({
  kind: z.literal("agentmail"), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
})).max(50) }).strict();

export function configureChannels(router: ChannelRouter, file: string, validateAgent: (id: string) => void): string[] {
  const config = channelConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return config.entries.map(({ apiKeyEnv, ...entry }) => {
    validateAgent(entry.agentId);
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error("channel_api_key_missing");
    router.register(entry, new AgentMailAdapter({ inbox: entry.account, apiKey,
      known: messageId => router.hasMessage(entry.id, messageId) }));
    return entry.id;
  });
}
