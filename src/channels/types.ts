import { z } from "zod";
import { invocationRuleSchema } from "./policy.js";

export const channelEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  agentId: z.string().uuid(),
  kind: z.string().min(1).max(48),
  account: z.string().min(1).max(320),
  rules: z.array(invocationRuleSchema).max(100).default([]),
  accessMode: z.enum(["read-only", "workspace-write"]).default("read-only"),
  enabled: z.boolean().default(true),
}).strict();
export type ChannelEntry = z.infer<typeof channelEntrySchema>;

// Only trusted, operator-configured adapters construct these events. No public
// endpoint accepts a caller's assertion that a sender passed authentication.
export const channelMessageSchema = z.object({
  id: z.string().min(1).max(1024), conversation: z.string().min(1).max(1024),
  subject: z.string().min(1).max(320), subjectDomain: z.string().max(253).optional(),
  authentication: z.enum(["provider-screened", "unverified"]),
  text: z.string().min(1).max(24000), receivedAt: z.string().datetime(),
}).strict();
export type ChannelMessage = z.infer<typeof channelMessageSchema>;
export interface ChannelPage { messages: ChannelMessage[]; cursor: string; more: boolean; }
export interface ChannelAdapter {
  poll(cursor: string | undefined, startedAt: string): Promise<ChannelPage>;
  reply(message: ChannelMessage, text: string, deliveryId: string): Promise<string>;
  close?(): void;
}
export class ChannelError extends Error {
  constructor(readonly code: string, readonly permanent = false, readonly retryAfterMs = 60_000) { super(code); }
}
