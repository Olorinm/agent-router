import { z } from "zod";
import type { MatrixConnector, Contact, Conversation } from "./connector.js";
import { digest, key, mxid, ROOM_EVENT, type RoomEvent } from "./protocol.js";
import type { AccountEvent, MatrixDataTransport } from "./transport.js";

export const CONTACT_PREFIX = "io.agentrouter.contact.";
export const contactType = (address: string) => CONTACT_PREFIX + digest(address);
const savedContact = z.object({ version: z.literal(1), address: mxid, note: z.string().max(500),
  tags: z.array(z.string().max(80)).max(32).default([]), deleted: z.boolean().optional() }).strict();
export interface TimelineEntry { cursor: number; room: string; event: RoomEvent; }

/** Standard Matrix client data. Local execution policies never come from account_data. */
export class MatrixSocial {
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(readonly host: MatrixConnector, readonly api: MatrixDataTransport) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutations.catch(() => {}).then(work);
    this.mutations = result; return result;
  }
  async bootstrap(): Promise<void> {
    for (const type of ["m.direct", "m.ignored_user_list"]) {
      this.account({ type, content: await this.api.get(type) ?? {} });
    }
  }
  account(event: AccountEvent): void {
    const store = this.host.store;
    if (event.type.startsWith(CONTACT_PREFIX)) {
      const parsed = savedContact.safeParse(event.content);
      if (!parsed.success || event.type !== contactType(parsed.data.address)) return;
      const data = parsed.data;
      if (data.deleted) {
        store.delete("contacts", data.address);
        store.delete("policies", data.address);
      } else {
        store.set("contacts", data.address, { address: data.address, note: data.note, tags: data.tags });
      }
    } else if (event.type === "m.ignored_user_list") {
      const ignored = record(event.content.ignored_users);
      for (const address of Object.keys(ignored)) {
        if (mxid.safeParse(address).success) store.set("policies", address, { receive: "ask", execution: "ask" });
      }
      for (const { id, value } of store.entries<{ sender: string }>("invites")) {
        if (Object.hasOwn(ignored, value.sender)) store.delete("invites", id);
      }
      store.set("account_data", event.type, { ignored_users: ignored });
    } else if (event.type === "m.direct") {
      const direct: Record<string, string[]> = {};
      for (const [address, rooms] of Object.entries(event.content)) {
        if (mxid.safeParse(address).success && Array.isArray(rooms)) direct[address] = rooms.filter((r): r is string => typeof r === "string" && r.startsWith("!"));
      }
      store.set("account_data", event.type, direct);
    }
  }
  ignored(address: string): boolean {
    return Object.hasOwn(record(this.host.store.get<{ ignored_users?: unknown }>("account_data", "m.ignored_user_list")?.ignored_users), address);
  }
  blocked(): string[] {
    return Object.keys(record(this.host.store.get<{ ignored_users?: unknown }>("account_data", "m.ignored_user_list")?.ignored_users));
  }
  async saveContact(contact: Contact): Promise<void> {
    const data = savedContact.parse({ version: 1, address: contact.address, note: contact.note, tags: contact.tags ?? [] });
    await this.serial(async () => {
      await this.api.put(contactType(data.address), data);
      this.account({ type: contactType(data.address), content: data });
    });
  }
  async removeContact(address: string): Promise<void> {
    mxid.parse(address);
    await this.serial(async () => {
      const content = { version: 1, address, note: "", tags: [], deleted: true };
      await this.api.put(contactType(address), content);
      this.account({ type: contactType(address), content });
    });
  }
  async block(address: string, blocked: boolean): Promise<void> {
    mxid.parse(address);
    await this.serial(async () => {
      const current = await this.api.get("m.ignored_user_list") ?? {};
      const ignored = { ...record(current.ignored_users) };
      if (blocked) ignored[address] = {}; else delete ignored[address];
      const content = { ...current, ignored_users: ignored };
      await this.api.put("m.ignored_user_list", content);
      this.host.store.set("policies", address, { receive: "ask", execution: "ask" });
      this.account({ type: "m.ignored_user_list", content });
    });
  }
  async direct(address: string, room: string): Promise<void> {
    await this.serial(async () => {
      const content = await this.api.get("m.direct") ?? {};
      const rooms = Array.isArray(content[address]) ? content[address].filter((x): x is string => typeof x === "string") : [];
      if (!rooms.includes(room)) {
        content[address] = [...rooms, room];
        await this.api.put("m.direct", content);
      }
      this.account({ type: "m.direct", content });
    });
  }
  /** Called inside the connector's receipt transaction, before the /sync checkpoint advances. */
  room(room: string, state: RoomEvent[], events: RoomEvent[], data?:
    { account_data?: { events: AccountEvent[] }; unread_notifications?: { notification_count?: number } }): void {
    const members = state.filter((e) => e.type === "m.room.member" && ["join", "invite"].includes(String(e.content.membership)))
      .map((e) => e.state_key).filter((id): id is string => Boolean(id));
    const peers = [...new Set(members)].filter((id) => id !== this.host.userId);
    const own = state.find((e) => e.type === "m.room.member" && e.state_key === this.host.userId);
    const previous = this.host.store.get<Record<string, unknown>>("room_info", room) ?? {};
    this.host.store.set("room_info", room, { ...previous, room, joined: own?.content.membership === "join", members,
      encrypted: state.some((e) => e.type === "m.room.encryption"),
      name: state.find((e) => e.type === "m.room.name")?.content.name ?? "",
      ...(data?.unread_notifications ? { notifications: data.unread_notifications.notification_count ?? 0 } : {}) });
    // Membership is authoritative: an account-data mapping alone cannot claim another user's room.
    const direct = this.host.store.get<Record<string, string[]>>("account_data", "m.direct") ?? {};
    const directRoom = state.some((e) => e.type === ROOM_EVENT && e.content.purpose === "a2a") || (peers[0] && direct[peers[0]]?.includes(room));
    if (directRoom && own?.content.membership === "join" && peers.length === 1 && mxid.safeParse(peers[0]).success) {
      const found = this.host.store.entries<Conversation>("conversations").some((r) => r.value.room === room && r.value.peer === peers[0]);
      if (!found) this.host.store.set("conversations", room, { id: room, room, peer: peers[0] });
    }
    for (const event of events) this.observe(room, event);
    for (const event of data?.account_data?.events ?? []) {
      if (event.type === "m.fully_read" && typeof event.content.event_id === "string") this.host.store.set("read_markers", room, event.content.event_id);
    }
  }
  observe(room: string, event: RoomEvent): void {
    if (!event.event_id || event.state_key !== undefined) return;
    if (this.host.store.get("timeline", key(room, event.event_id))) return;
    if (event.type === "m.room.redaction") {
      const target = typeof event.content.redacts === "string" ? event.content.redacts : event.redacts;
      const old = target ? this.host.store.get<TimelineEntry>("timeline", key(room, target)) : undefined;
      if (old) this.host.store.set("timeline", key(room, target!), { ...old, event: { ...old.event, content: {} } });
    }
    const cursor = (this.host.store.get<number>("meta", "timeline_cursor") ?? 0) + 1;
    this.host.store.set("timeline", key(room, event.event_id), { cursor, room, event });
    this.host.store.set("meta", "timeline_cursor", cursor);
  }
  entries(after = 0, room?: string, limit = 100): TimelineEntry[] {
    return this.host.store.entries<TimelineEntry>("timeline").map((r) => r.value)
      .filter((r) => r.cursor > after && (!room || r.room === room) && !this.ignored(r.event.sender)).slice(0, limit);
  }
  conversations() {
    return this.host.store.entries<Conversation>("conversations").map(({ value }) => {
      const info = this.host.store.get<Record<string, unknown>>("room_info", value.room);
      const entries = this.entries(0, value.room, Number.MAX_SAFE_INTEGER);
      const readId = this.host.store.get<string>("read_markers", value.room);
      const read = entries.find((e) => e.event.event_id === readId)?.cursor ?? 0;
      return { ...value, ...info, unread: entries.filter((e) => e.cursor > read && e.event.sender !== this.host.userId).length,
        latestEvent: entries.at(-1)?.event.event_id ?? null };
    });
  }
  async accept(room: string): Promise<void> {
    const invite = this.host.store.get<{ sender: string }>("invites", room);
    if (!invite) throw new Error("invite_not_found");
    if (this.ignored(invite.sender)) throw new Error("sender_blocked");
    await this.host.transport.join(room);
    await this.direct(invite.sender, room);
    this.host.store.delete("invites", room);
  }
  async leave(room: string): Promise<void> {
    await this.api.leave(room);
    this.host.store.delete("invites", room);
    const info = this.host.store.get<Record<string, unknown>>("room_info", room) ?? {};
    this.host.store.set("room_info", room, { ...info, room, joined: false });
    await this.serial(async () => {
      const content = await this.api.get("m.direct") ?? {};
      for (const [peer, rooms] of Object.entries(content)) if (Array.isArray(rooms)) content[peer] = rooms.filter((r) => r !== room);
      await this.api.put("m.direct", content); this.account({ type: "m.direct", content });
    });
  }
  async history(room: string, from?: string) {
    const page = await this.host.transport.history(room, from);
    return { room, events: page.events.filter((e) => !this.ignored(e.sender)), next: page.end ?? null };
  }
  async read(room: string, eventId?: string): Promise<void> {
    const id = eventId ?? this.entries(0, room, Number.MAX_SAFE_INTEGER).at(-1)?.event.event_id;
    if (!id) throw new Error("room_has_no_cached_events");
    await this.api.read(room, id); this.host.store.set("read_markers", room, id);
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
