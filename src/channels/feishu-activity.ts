import { randomInt } from "node:crypto";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { ChannelContext, ReplyRoute } from "../communication/types.js";
import { FEISHU_EMOJIS } from "./feishu-emojis.js";

interface ReactionState {
  emoji: string;
  phase: "selected" | "adding" | "active" | "removing" | "removed";
  reactionId?: string;
  owned?: boolean;
}

/** Resolve uncertain API responses by emoji and app identity, without touching anyone else's reactions. */
async function findReaction(channel: LarkChannel, appId: string, messageId: string, emoji: string) {
  let pageToken: string | undefined;
  const seen = new Set<string>();
  do {
    const result = await channel.rawClient.im.v1.messageReaction.list({ path: { message_id: messageId },
      params: { reaction_type: emoji, page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) } });
    if (result.code || !result.data) throw new Error("feishu_activity_lookup_failed");
    const mine = result.data.items?.find(item => item.operator?.operator_type === "app" && item.operator.operator_id === appId);
    if (mine?.reaction_id) return mine.reaction_id;
    if (!result.data.has_more) return undefined;
    pageToken = result.data.page_token;
    if (!pageToken || seen.has(pageToken)) throw new Error("feishu_activity_invalid_cursor");
    seen.add(pageToken);
  } while (pageToken);
  return undefined;
}

export async function feishuActivity(channel: LarkChannel, context: ChannelContext, appId: string,
  route: ReplyRoute, active: boolean, activityKey: string,
  chooseEmoji: () => string = () => FEISHU_EMOJIS[randomInt(FEISHU_EMOJIS.length)]!): Promise<{ externalId: string }> {
  const key = `activity:${activityKey}`;
  let saved = context.checkpoint<ReactionState>(key);
  const save = (value: ReactionState) => { context.checkpoint(key, value); saved = value; };
  if (!saved && active) save({ emoji: chooseEmoji(), phase: "selected" });
  if (!saved || saved.phase === "removed") return { externalId: saved?.reactionId ?? "" };
  if (active) {
    if (saved.phase === "active" || saved.phase === "removing") return { externalId: saved.reactionId ?? "" };
    const found = await findReaction(channel, appId, route.messageId, saved.emoji);
    if (found) save({ ...saved, reactionId: found, owned: saved.phase === "adding", phase: "active" });
    else {
      save({ ...saved, phase: "adding", owned: true });
      const reactionId = await channel.addReaction(route.messageId, saved.emoji);
      save({ ...saved, phase: "active", reactionId });
    }
  } else {
    if (saved.owned) {
      const reactionId = saved.phase === "active" ? saved.reactionId : await findReaction(channel, appId, route.messageId, saved.emoji);
      if (reactionId) {
        save({ ...saved, phase: "removing", reactionId });
        // SDK removeReaction discards API error codes. Check the raw response before recording cleanup.
        const result = await channel.rawClient.im.v1.messageReaction.delete({ path: { message_id: route.messageId, reaction_id: reactionId } });
        if (result.code) throw new Error("feishu_activity_cleanup_failed");
      }
    }
    save({ ...saved, phase: "removed" });
  }
  return { externalId: saved.reactionId ?? "" };
}
