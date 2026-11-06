/**
 * A test-only channel written against the public adapter API alone (`src/channels/api.ts`), as
 * `docs/guides/adding-a-channel.md` describes. `test/channel-boundaries.test.ts` checks it imports nothing else.
 */
import { z } from "zod";
import { bindAccount, configFile, connectionFields, defineChannel, sendChunks, type ChannelAdapter, type ChannelContext,
  type ChannelMessage, type ReplyRoute } from "../../../src/channels/api.js";

/** An in-memory provider: `inbound` is what the platform delivers, `outbound` what the agent sent. */
export class EchoProvider {
  outbound: Array<{ chat: string; text: string }> = [];
  constructor(readonly token: string) {}
}

export class EchoChannel implements ChannelAdapter {
  readonly kind = "echo";
  // Sends are not idempotent on the provider, so an interrupted send becomes `uncertain`, never a blind resend.
  readonly retrySafe = false;
  readonly capabilities = { receive: ["text"], send: ["text"], stream: false, buttons: false, native: [] };
  private context: ChannelContext | undefined;
  constructor(readonly provider: EchoProvider) {}
  async start(context: ChannelContext): Promise<void> { bindAccount(context, `echo:${this.provider.token}`); this.context = context; }
  async stop(): Promise<void> { this.context = undefined; }
  /** Provider webhook/poll: one platform message. Returns after durable receipt. */
  deliver(input: { id: string; from: string; chat: string; text: string }): void {
    if (!this.context) throw new Error("echo_channel_not_started");
    const message: ChannelMessage = { externalId: input.id, sender: input.from, threadId: input.chat, scope: "direct", text: input.text,
      reply: { target: input.chat, messageId: input.id, data: {} } };
    this.context.receive(message);
  }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    return sendChunks(this.context!, sendKey, text, 1000, async (part, index) => {
      this.provider.outbound.push({ chat: route.target, text: part });
      return `${route.messageId}:${index}`;
    });
  }
}

export const echoChannel = defineChannel({
  kind: "echo",
  schema: z.object({ ...connectionFields, kind: z.literal("echo"), tokenFile: configFile }).strict(),
  validate: (config) => config.groupIds.length ? ["echo_supports_direct_chats_only"] : [],
  account: (config, { files }) => files.secret(config.tokenFile),
  create: (config, { files }) => {
    const make = () => new EchoChannel(new EchoProvider(files.secret(config.tokenFile)));
    return { adapter: make(), reload: make };
  },
  check: async (config, files) => ({ status: files.secret(config.tokenFile) ? "verified" : "needs_action", detail: "Token file present" }),
});
