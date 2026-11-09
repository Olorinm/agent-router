/**
 * Channel registry: maps a connection `kind` to its adapter module. This is the only Router file that imports adapter
 * modules; Router builds adapters through it (`src/service/channels.ts`). Adding a channel is one import and one entry
 * in `channelModules` and `connectionSchema` (see `docs/guides/adding-a-channel.md`).
 */
import { z } from "zod";
import type { ChannelModule } from "./api.js";
import { matrixChannel } from "./matrix/index.js";
import { feishuChannel } from "./feishu/index.js";
import { telegramChannel } from "./telegram/index.js";
import { groveMailChannel } from "./grove-mail/index.js";
import { weixinChannel } from "./weixin/index.js";
import { barkChannel } from "./bark/index.js";

/** Configurable connection kinds, in configuration order. */
export const channelModules = [matrixChannel, feishuChannel, telegramChannel, groveMailChannel, weixinChannel, barkChannel] as const;
/** One connection entry of the operator's channel configuration. */
export const connectionSchema = z.discriminatedUnion("kind", [matrixChannel.schema, feishuChannel.schema, telegramChannel.schema,
  groveMailChannel.schema, weixinChannel.schema, barkChannel.schema]);
export type ConnectionConfig = z.infer<typeof connectionSchema>;

const modules = new Map<string, ChannelModule>(channelModules.map((module) => [module.kind, module as ChannelModule]));
export const findChannelModule = (kind: string): ChannelModule | undefined => modules.get(kind);
export function channelModule(kind: string): ChannelModule {
  const module = modules.get(kind);
  if (!module) throw new Error("channel_kind_unknown");
  return module;
}

/** Built-in owner surfaces; Router registers them itself (not part of the connection configuration). */
export { WebChannel } from "./web/index.js";
export { RoomChannel } from "./room/index.js";
