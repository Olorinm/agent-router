export type ChannelKind = "matrix" | "grove-mail" | "feishu" | "telegram" | "weixin";

/** Provider-specific reply data is frozen on receipt, never inferred from the latest chat. */
export interface ReplyRoute {
  connectionId: string;
  target: string;
  messageId: string;
  data: Record<string, string>;
}
export interface AttachmentReference { id: string; name: string; mediaType: string; kind?: "image" | "audio" | "video" | "file" | "sticker" | undefined; data?: Record<string, unknown> | undefined; }
export interface MediaContent { name: string; mediaType: string; data: string; }
export interface ChannelCapabilities {
  receive: string[]; send: string[]; stream: boolean; buttons: boolean; native: string[];
  nativeArguments?: Record<string, string>;
}
export interface ChannelContent { text: string; html?: string; media?: MediaContent[]; card?: Record<string, unknown>; buttons?: Array<{ label: string; token: string }>; }
export interface ChannelMessage {
  externalId: string;
  sender: string;
  threadId: string;
  scope: "direct" | "group";
  groupId?: string | undefined;
  text: string;
  reply: Omit<ReplyRoute, "connectionId">;
  attachments?: AttachmentReference[] | undefined;
  quoted?: { messageId?: string | undefined; text?: string | undefined } | undefined;
  action?: { token: string } | undefined;
  event?: { type: string; data: Record<string, unknown> } | undefined;
  native?: Record<string, unknown> | undefined;
}
export interface ChannelContext {
  /** Returns only after durable receipt; a failed receipt must not advance a provider cursor. */
  receive(message: ChannelMessage): void;
  checkpoint<T>(key: string): T | undefined;
  checkpoint(key: string, value: unknown): void;
  error(code: string): void;
  disconnected?(code: string): void;
}
export interface SendReceipt { externalId: string; }
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** A stable send key can be safely resubmitted, including after a lost response. */
  readonly retrySafe: boolean;
  readonly capabilities?: ChannelCapabilities;
  capabilitiesFor?(route: ReplyRoute): ChannelCapabilities;
  /** Whether a shared conversation accepts all senders or uses the configured group/peer lists. */
  groupPolicy?(message: ChannelMessage): "open" | "allowlist";
  /** Durable, retry-safe activity feedback on the original message. */
  activity?(route: ReplyRoute, active: boolean, activityKey: string): Promise<SendReceipt>;
  start(context: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  send(route: ReplyRoute, text: string, sendKey: string): Promise<SendReceipt>;
  readAttachment?(message: ChannelMessage, attachment: AttachmentReference): Promise<MediaContent>;
  readQuote?(message: ChannelMessage): Promise<string | undefined>;
  sendContent?(route: ReplyRoute, content: ChannelContent, sendKey: string): Promise<SendReceipt>;
  progress?(route: ReplyRoute, text: string, streamKey: string, final: boolean): Promise<SendReceipt>;
  native?(route: ReplyRoute, operation: string, args: Record<string, unknown>): Promise<unknown>;
}
export class ChannelSendError extends Error {
  constructor(readonly disposition: "retry" | "failed" | "uncertain", code: string, readonly retryAfterMs = 0) {
    super(code);
  }
}

export function splitText(text: string, limit: number): string[] {
  const characters = Array.from(text);
  const parts: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) parts.push(characters.slice(offset, offset + limit).join(""));
  return parts.length ? parts : [""];
}

export function bindAccount(context: ChannelContext, identity: string): void {
  const previous = context.checkpoint<string>("account");
  if (previous && previous !== identity) throw new Error("channel_account_changed_use_new_connection_id");
  context.checkpoint("account", identity);
}

/** Resume acknowledged chunks; an unacknowledged non-idempotent chunk is never resent blindly. */
export async function sendChunks(context: ChannelContext, key: string, text: string, limit: number,
  send: (part: string, index: number) => Promise<string>): Promise<SendReceipt> {
  const ids: string[] = [];
  const parts = splitText(text, limit);
  for (const [index, part] of parts.entries()) {
    const name = `send:${key}:${index}`;
    const prior = context.checkpoint<{ state: "submitting" | "accepted" | "retry"; id?: string }>(name);
    if (prior?.state === "accepted") { ids.push(prior.id!); continue; }
    if (prior?.state === "submitting") throw new ChannelSendError("uncertain", "chunk_acceptance_unknown");
    context.checkpoint(name, { state: "submitting" });
    try {
      const id = await send(part, index);
      context.checkpoint(name, { state: "accepted", id }); ids.push(id);
    } catch (error) {
      if (error instanceof ChannelSendError && error.disposition !== "uncertain") context.checkpoint(name, { state: "retry" });
      throw error;
    }
  }
  return { externalId: ids.join(",") };
}
