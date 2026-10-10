import type { MatrixConnector } from "../matrix/connector.js";
import type { RoomEvent } from "../matrix/protocol.js";
import { bindAccount, ChannelSendError, splitText, type ChannelAdapter, type ChannelContext, type ReplyRoute } from "../communication/types.js";

/** Uses the existing authenticated Matrix reader and SDK transport; no second /sync client. */
export class MatrixChannel implements ChannelAdapter {
  readonly kind = "matrix";
  readonly retrySafe = true;
  private context!: ChannelContext;
  constructor(readonly connector: MatrixConnector) {}
  async start(context: ChannelContext): Promise<void> {
    this.context = context; bindAccount(context, this.connector.userId);
    if (!context.checkpoint("activation")) context.checkpoint("activation", Date.now());
    this.connector.onTextMessage = (room, event) => this.receive(room, event);
  }
  async stop(): Promise<void> { this.connector.onTextMessage = undefined; }
  private receive(room: string, event: RoomEvent): void {
    const timestamp = Number((event as RoomEvent & { origin_server_ts?: number }).origin_server_ts);
    if (!timestamp || timestamp < this.context.checkpoint<number>("activation")!) return;
    const members = this.connector.store.get<{ members: string[] }>("rooms", room)?.members ?? [];
    const direct = members.length === 2 && members.includes(event.sender) && members.includes(this.connector.userId);
    const relation = event.content["m.relates_to"] as { rel_type?: string; event_id?: string } | undefined;
    const thread = relation?.rel_type === "m.thread" ? relation.event_id ?? "" : "";
    this.context.receive({ externalId: event.event_id, sender: event.sender, threadId: thread ? `${room}:${thread}` : room, scope: direct ? "direct" : "group",
      ...(direct ? {} : { groupId: room }), text: String(event.content.body), reply: { target: room, messageId: event.event_id, data: { sender: event.sender, thread } } });
  }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    const state = await this.connector.transport.state(route.target);
    if (state.some((event) => event.type === "m.room.encryption")) throw new ChannelSendError("failed", "matrix_encrypted_room_not_supported");
    if (!state.some((event) => event.type === "m.room.member" && event.state_key === route.data.sender && event.content.membership === "join")) {
      throw new ChannelSendError("retry", "matrix_waiting_for_recipient");
    }
    const ids: string[] = [];
    for (const [index, body] of splitText(text, 2000).entries()) ids.push(await this.connector.transport.send(route.target, "m.room.message", { msgtype: "m.text", body,
      "m.relates_to": { "m.in_reply_to": { event_id: route.messageId },
        ...(route.data.thread ? { rel_type: "m.thread", event_id: route.data.thread, is_falling_back: false } : {}) } }, `${sendKey}-${index}`));
    return { externalId: ids.join(",") };
  }
}
