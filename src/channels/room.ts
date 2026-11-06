import { bindAccount, ChannelSendError, type ChannelAdapter, type ChannelContent, type ChannelContext, type ChannelMessage, type ReplyRoute } from "../communication/types.js";
import type { CommunicationCore } from "../communication/core.js";
import { digest } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import type { HubRooms, RoomDelivery } from "../ledger/rooms.js";

/** The connection id of the hub room channel on every agent's channel core (ADR 0005 phase 5). */
export const ROOM_CONNECTION = "room";

/**
 * Owner hub rooms as a channel adapter (ADR 0005 section 17). The fan-out worker hands the owner's addressed room
 * messages to `deliver`, which enters the normal ingress → claim → pending input → turn path in the agent's room
 * session. Replies are appended to the room transcript, so the room event id is the platform message id.
 */
export class RoomChannel implements ChannelAdapter, RoomDelivery {
  readonly kind = "room";
  readonly retrySafe = true;
  readonly capabilities = { receive: ["text", "quote"], send: ["text", "html"], stream: false, buttons: false, native: [] };
  private context: ChannelContext | undefined;
  constructor(readonly core: CommunicationCore, readonly agentId: string, readonly ownerId: string,
    private readonly rooms: () => HubRooms | undefined) {}
  async start(context: ChannelContext): Promise<void> { bindAccount(context, digest(["room", this.ownerId])); this.context = context; }
  async stop(): Promise<void> { this.context = undefined; }
  private hub(): HubRooms {
    const rooms = this.rooms();
    if (!rooms) throw new WorkError("room_channel_unavailable", 503);
    return rooms;
  }
  /** Fan-out ingress. Redelivery is harmless: the claim `(room, <roomId>:<seq>)` returns the stored receipt. */
  deliver(message: ChannelMessage): void {
    if (!this.context) throw new Error("room_channel_not_started");
    this.core.receive(ROOM_CONNECTION, message);
  }
  turnContext(message: ChannelMessage) {
    const roomId = message.reply.data.roomId, seq = Number(message.externalId.slice(message.externalId.lastIndexOf(":") + 1));
    if (!roomId || !Number.isSafeInteger(seq)) return undefined;
    return this.rooms()?.context(roomId, this.agentId, seq);
  }
  private post(route: ReplyRoute, content: { text: string; html?: string | undefined }, sendKey: string) {
    const ledger = this.core.ledger, delivery = ledger?.delivery(sendKey), event = delivery?.eventId ? ledger!.event(delivery.eventId) : undefined;
    const roomId = route.data.roomId ?? route.target;
    if (!this.hub().room(roomId)) throw new ChannelSendError("failed", "room_not_found");
    const eventId = this.hub().reply(this.agentId, roomId, sendKey, { kind: event?.kind === "notice" ? "notice" : "message", text: content.text, html: content.html,
      turnId: event?.turnId, final: event?.body.final === true, replyTo: route.messageId || undefined, createdAt: event?.createdAt });
    return { externalId: eventId };
  }
  async send(route: ReplyRoute, text: string, sendKey: string) { return this.post(route, { text }, sendKey); }
  /** Media needs the blob store (phase 4); until then HTML and text only. */
  async sendContent(route: ReplyRoute, content: ChannelContent, sendKey: string) {
    if (content.media?.length || content.card || content.buttons?.length) throw new ChannelSendError("failed", "channel_content_unsupported");
    return this.post(route, { text: content.text, html: content.html }, sendKey);
  }
}
