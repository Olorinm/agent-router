import type { MatrixConnector } from "../matrix/connector.js";
import type { RoomEvent } from "../matrix/protocol.js";
import { bindAccount, ChannelSendError, splitText, type ChannelAdapter, type ChannelContext, type ReplyRoute, type AttachmentReference, type ChannelMessage, type ChannelContent } from "../communication/types.js";

/** Uses the existing authenticated Matrix reader and SDK transport; no second /sync client. */
import { digest } from "../execution/protocol.js";
import { mediaContent } from "../communication/media.js";

export class MatrixChannel implements ChannelAdapter {
  readonly kind = "matrix";
  readonly retrySafe = true;
  readonly capabilities = { receive: ["text", "image", "file", "audio", "video", "location", "quote", "reaction", "edit", "redaction"], send: ["text", "image", "file", "audio", "video", "html"], stream: true, buttons: false, native: ["reaction", "edit", "redact", "typing"],
    nativeArguments: { reaction: "emoji, optional messageId", edit: "text, optional messageId", redact: "optional messageId", typing: "no args" } };
  private context!: ChannelContext;
  constructor(readonly connector: MatrixConnector) {}
  async start(context: ChannelContext): Promise<void> {
    this.context = context; bindAccount(context, this.connector.userId);
    if (!context.checkpoint("activation")) context.checkpoint("activation", Date.now());
    this.connector.onTextMessage = (room, event) => this.receive(room, event);
    this.connector.onChannelEvent = (room, event) => this.receive(room, event);
  }
  async stop(): Promise<void> { this.connector.onTextMessage = undefined; this.connector.onChannelEvent = undefined; }
  private receive(room: string, event: RoomEvent): void {
    const timestamp = Number((event as RoomEvent & { origin_server_ts?: number }).origin_server_ts);
    if (!timestamp || timestamp < this.context.checkpoint<number>("activation")!) return;
    const members = this.connector.store.get<{ members: string[] }>("rooms", room)?.members ?? [];
    const direct = members.length === 2 && members.includes(event.sender) && members.includes(this.connector.userId);
    const relation = event.content["m.relates_to"] as { rel_type?: string; event_id?: string; "m.in_reply_to"?: { event_id: string } } | undefined;
    const thread = relation?.rel_type === "m.thread" ? relation.event_id ?? "" : "";
    this.context.receive({ externalId: event.event_id, sender: event.sender, threadId: thread ? `${room}:${thread}` : room, scope: direct ? "direct" : "group",
      ...(direct ? {} : { groupId: room }),
      attachments: typeof event.content.url === "string" ? [{ id: event.content.url, name: String(event.content.body ?? "attachment"), mediaType: String((event.content.info as any)?.mimetype ?? "application/octet-stream"), kind: event.content.msgtype === "m.image" ? "image" : event.content.msgtype === "m.audio" ? "audio" : event.content.msgtype === "m.video" ? "video" : "file" }] : [],
      ...(relation?.["m.in_reply_to"] ? { quoted: { messageId: relation["m.in_reply_to"].event_id } } : {}),
      ...(relation?.rel_type === "m.replace" ? { event: { type: "message-edit", data: event.content } } :
        event.type !== "m.room.message" ? { event: { type: event.type === "m.reaction" ? "reaction" : "message-redaction", data: { ...event.content, ...(event.redacts ? { redacts: event.redacts } : {}) } } } : {}),
      native: { content: event.content }, text: String(event.content.body ?? ""), reply: { target: room, messageId: event.event_id, data: { sender: event.sender, thread } } });
  }
  async readAttachment(_message: ChannelMessage, attachment: AttachmentReference) {
    if (!this.connector.transport.media) throw new Error("matrix_media_transport_unavailable");
    return mediaContent(attachment.name, attachment.mediaType, await this.connector.transport.media.read(attachment.id));
  }
  async sendContent(route: ReplyRoute, content: ChannelContent, sendKey: string) {
    await this.validateRoute(route);
    const ids: string[] = [];
    if (content.html) {
      if (Buffer.byteLength(content.html) > 24_000) throw new ChannelSendError("failed", "matrix_html_too_large");
      ids.push(await this.connector.transport.send(route.target, "m.room.message", { msgtype: "m.text", body: content.text || content.html,
        format: "org.matrix.custom.html", formatted_body: content.html, "m.relates_to": this.replyRelation(route) }, `${sendKey}:html`));
    } else if (content.text) ids.push((await this.send(route, content.text, `${sendKey}:text`)).externalId);
    for (const [index, item] of (content.media ?? []).entries()) {
      if (!this.connector.transport.media) throw new ChannelSendError("failed", "matrix_media_transport_unavailable");
      const checkpoint = `upload:${sendKey}:${index}`;
      let url = this.context.checkpoint<string>(checkpoint);
      if (!url) { url = await this.connector.transport.media.upload(Buffer.from(item.data, "base64"), item.name, item.mediaType); this.context.checkpoint(checkpoint, url); }
      const kind = item.mediaType.startsWith("image/") ? "m.image" : item.mediaType.startsWith("audio/") ? "m.audio" : item.mediaType.startsWith("video/") ? "m.video" : "m.file";
      ids.push(await this.connector.transport.send(route.target, "m.room.message", { msgtype: kind, body: item.name, url, info: { mimetype: item.mediaType, size: Buffer.byteLength(item.data, "base64") }, "m.relates_to": this.replyRelation(route) }, `${sendKey}:media:${index}`));
    }
    return { externalId: ids.join(",") };
  }
  async progress(route: ReplyRoute, text: string, streamKey: string, final: boolean) {
    await this.validateRoute(route);
    const ids: string[] = [];
    const parts = splitText(text, 2000);
    const countKey = `stream-count:${streamKey}`;
    const count = Math.max(parts.length, this.context.checkpoint<number>(countKey) ?? 0);
    for (let index = 0; index < count; index++) {
      const checkpoint = `stream:${streamKey}:${index}`;
      const previous = this.context.checkpoint<string>(checkpoint);
      const content = { msgtype: "m.text", body: parts[index] ?? "…" };
      if (!previous) {
        const id = await this.connector.transport.send(route.target, "m.room.message", { ...content, "m.relates_to": this.replyRelation(route) }, `stream:${streamKey}:${index}`);
        this.context.checkpoint(checkpoint, id); ids.push(id);
      } else {
        await this.connector.transport.send(route.target, "m.room.message", { ...content, "m.new_content": content,
          "m.relates_to": { rel_type: "m.replace", event_id: previous } }, `${streamKey}:${index}:${final ? "final" : digest(content.body).slice(0, 32)}`);
        ids.push(previous);
      }
    }
    this.context.checkpoint(countKey, count); return { externalId: ids.join(",") };
  }
  async native(route: ReplyRoute, operation: string, args: Record<string, unknown>) {
    await this.validateRoute(route);
    const id = String(args.messageId ?? route.messageId);
    if (operation === "typing") return this.connector.transport.typing?.(route.target);
    if (operation === "redact") return this.connector.transport.redact?.(route.target, id);
    if (operation === "reaction") return this.connector.transport.send(route.target, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: id, key: String(args.emoji) } }, String(args.key));
    if (operation === "edit") {
      const content = { msgtype: "m.text", body: String(args.text) };
      return this.connector.transport.send(route.target, "m.room.message", { ...content, "m.new_content": content, "m.relates_to": { rel_type: "m.replace", event_id: id } }, String(args.key));
    }
    throw new Error("matrix_native_operation_unsupported");
  }
  private replyRelation(route: ReplyRoute) { return { "m.in_reply_to": { event_id: route.messageId },
    ...(route.data.thread ? { rel_type: "m.thread", event_id: route.data.thread, is_falling_back: false } : {}) }; }
  private async validateRoute(route: ReplyRoute) {
    const state = await this.connector.transport.state(route.target);
    if (state.some((event) => event.type === "m.room.encryption")) throw new ChannelSendError("failed", "matrix_encrypted_room_not_supported");
    if (!state.some((event) => event.type === "m.room.member" && event.state_key === route.data.sender && event.content.membership === "join")) {
      throw new ChannelSendError("retry", "matrix_waiting_for_recipient");
    }
  }
  async send(route: ReplyRoute, text: string, sendKey: string) {
    await this.validateRoute(route);
    const ids: string[] = [];
    for (const [index, body] of splitText(text, 2000).entries()) ids.push(await this.connector.transport.send(route.target, "m.room.message", { msgtype: "m.text", body,
      "m.relates_to": this.replyRelation(route) }, `${sendKey}-${index}`));
    return { externalId: ids.join(",") };
  }
}
