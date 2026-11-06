import type { SQLInputValue } from "node:sqlite";
import { digest } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import type { ChannelMessage } from "../communication/types.js";
import type { Actor, ChatEvent, ChatSummary, EventPage, HistoryQuery, HubDirectory, HubSocket, Inflight, OwnerHub } from "./hub.js";
import { ulid, type AgentLedger, type LedgerSession } from "./ledger.js";

/**
 * Phase 5 hub schema (ADR 0005 section 17.8, `OWNER_HUB_V3`). It has its own version counter
 * (`hub_rooms_schema_version`) so it does not depend on the order in which other hub steps land.
 */
export const HUB_ROOMS_V1 = `
CREATE TABLE hub_room_cursors(room_id TEXT NOT NULL, agent_id TEXT NOT NULL, context_seq INTEGER NOT NULL,
  PRIMARY KEY(room_id, agent_id));
CREATE INDEX hub_fanout_due ON hub_fanout(next_at) WHERE status = 'queued';
CREATE INDEX hub_room_members_agent ON hub_room_members(member_id) WHERE member_type = 'agent';
CREATE INDEX hub_room_events_turn ON hub_room_events(room_id, turn_id) WHERE turn_id IS NOT NULL;`;

/** Limits of section 17 (tunable here, as 17.10 asks). */
export const ROOM_LIMITS = {
  roomsPerOwner: 100, agentsPerRoom: 20, titleChars: 64,
  contextMessages: 30, contextBytes: 8 * 1024, contextMessageBytes: 1024,
  failAfterMs: 24 * 3600_000, backoffMaxMs: 5 * 60_000,
  pageEvents: 200, pageBytes: 1024 * 1024, deltaGap: 1000, socketReplayEvents: 500, socketReplayBytes: 1024 * 1024,
};
export const isRoomChat = (chatId: string) => chatId.startsWith("room:");
export const roomChatId = (roomId: string) => `room:${roomId}`;
const roomIdPattern = /^rm_[0-9A-Za-z]{10,40}$/;
const fields: Record<string, string[]> = {
  message: ["text", "html", "attachments", "mentions", "replyTo", "final", "agentId", "notice", "redacted", "truncated"],
  notice: ["text", "level", "agentId"], card: ["card", "agentId"], "card.update": ["cardId", "status", "answeredBy", "summary", "agentId"],
  turn: ["agentId", "state", "inputEventIds", "error"], redaction: ["targetEventId"], edit: ["targetEventId", "text"],
  reaction: ["targetEventId", "key", "removed"], window: ["window", "reason"], member: ["action", "member", "title"],
};
const iso = (ms: number) => new Date(ms).toISOString();
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const cut = (text: string, bytes: number) => {
  if (Buffer.byteLength(text) <= bytes) return text;
  // Cut on a code point boundary.
  let out = "", used = 0;
  for (const char of text) { const n = Buffer.byteLength(char); if (used + n > bytes - 3) break; out += char; used += n; }
  return `${out}…`;
};
type Row = Record<string, SQLInputValue>;
export interface RoomEventRow {
  roomId: string; seq: number; eventId: string; kind: string; role: string; senderType: string; senderId: string;
  turnId: string | null; refEventId: string | null; idempotencyKey: string | null; createdAt: number; body: Record<string, unknown>;
}
export interface RoomAppend {
  kind: string; role: "user" | "assistant" | "system"; senderType: "person" | "agent" | "system" | "external"; senderId: string;
  turnId?: string | null | undefined; refEventId?: string | null | undefined; idempotencyKey: string; createdAt?: number | undefined; body: Record<string, unknown>;
}
export interface Addressed { agentId: string; state: "queued" | "delivered" | "failed" | "not_addressed" }
export interface RoomSendInput { idempotencyKey: string; text: string; mentions?: { agentIds: string[]; all?: boolean | undefined } | undefined; replyTo?: string | undefined }
/** What the fan-out worker hands to an agent's `RoomChannel`. */
export interface RoomDelivery { deliver(message: ChannelMessage): void }
function eventRow(row: Row): RoomEventRow {
  return { roomId: row.room_id as string, seq: Number(row.seq), eventId: row.event_id as string, kind: row.kind as string, role: row.role as string,
    senderType: row.sender_type as string, senderId: row.sender_id as string, turnId: (row.turn_id as string | null) ?? null,
    refEventId: (row.ref_event_id as string | null) ?? null, idempotencyKey: (row.idempotency_key as string | null) ?? null,
    createdAt: Number(row.created_at), body: JSON.parse(row.body as string) as Record<string, unknown> };
}

/**
 * Native groups of one owner (ADR 0005 sections 6.5 and 17): hub rooms, members, the canonical room transcript,
 * fan-out of the owner's addressed messages to agents, group context and the mirror of agent turns into the room.
 */
export class HubRooms {
  private dirty = new Set<string>();
  private scheduled = false;
  constructor(private readonly hub: OwnerHub, private readonly directory: HubDirectory) {
    hub.store.migrate(1, HUB_ROOMS_V1, "hub_rooms_schema_version");
  }
  private get db() { return this.hub.store.db; }
  private row(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).get(...args) as Row | undefined; }
  private rows(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).all(...args) as Row[]; }
  private run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  private atomic<T>(work: () => T): T { return this.db.isTransaction ? work() : this.hub.store.transaction(work); }
  get enabled(): boolean { return Boolean(this.directory.groups); }

  /** The room behind a `room:` chat id; unknown ids are `chat_not_found`. */
  roomOf(chatId: string): string {
    const roomId = chatId.slice("room:".length);
    if (!isRoomChat(chatId) || !roomIdPattern.test(roomId) || !this.room(roomId)) throw new WorkError("chat_not_found", 404);
    return roomId;
  }
  room(roomId: string) { return this.row("SELECT * FROM hub_rooms WHERE room_id=?", roomId); }
  /** Room ids of every room the owner has (any state). */
  roomIds(): string[] { return this.rows("SELECT room_id FROM hub_rooms ORDER BY created_at").map((row) => row.room_id as string); }
  agentIds(roomId: string): string[] {
    return this.rows("SELECT member_id FROM hub_room_members WHERE room_id=? AND member_type='agent' AND left_at IS NULL ORDER BY joined_at, rowid", roomId)
      .map((row) => row.member_id as string);
  }
  roomsOfAgent(agentId: string): string[] {
    return this.rows("SELECT room_id FROM hub_room_members WHERE member_type='agent' AND member_id=? AND left_at IS NULL", agentId).map((row) => row.room_id as string);
  }
  actor(senderType: string, senderId: string): Actor {
    if (senderType === "agent") return { type: "agent", id: senderId, name: this.directory.agentName(senderId) };
    if (senderType === "person") return { type: "person", id: senderId, name: this.directory.personName(senderId) ?? senderId };
    if (senderType === "system") return { type: "system", id: senderId, name: senderId === "router" ? "Router" : senderId };
    return { type: "external", id: senderId, name: senderId };
  }
  members(roomId: string): Actor[] {
    return this.rows(`SELECT member_type, member_id FROM hub_room_members WHERE room_id=? AND left_at IS NULL
      ORDER BY CASE member_type WHEN 'person' THEN 0 ELSE 1 END, joined_at, rowid`, roomId)
      .map((row) => this.actor(row.member_type as string, row.member_id as string));
  }

  // ---- transcript -------------------------------------------------------------------------------------------
  event(roomId: string, eventId: string): RoomEventRow | undefined {
    const row = this.row("SELECT * FROM hub_room_events WHERE room_id=? AND event_id=?", roomId, eventId);
    return row ? eventRow(row) : undefined;
  }
  eventByKey(roomId: string, idempotencyKey: string): RoomEventRow | undefined {
    const row = this.row("SELECT * FROM hub_room_events WHERE room_id=? AND idempotency_key=?", roomId, idempotencyKey);
    return row ? eventRow(row) : undefined;
  }
  events(roomId: string, options: { after?: number; before?: number; limit?: number; latest?: boolean } = {}): RoomEventRow[] {
    const limit = options.limit ?? 200;
    if (options.latest || options.before !== undefined)
      return this.rows("SELECT * FROM hub_room_events WHERE room_id=? AND seq<? ORDER BY seq DESC LIMIT ?", roomId, options.before ?? Number.MAX_SAFE_INTEGER, limit).map(eventRow).reverse();
    return this.rows("SELECT * FROM hub_room_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?", roomId, options.after ?? 0, limit).map(eventRow);
  }
  /** Append with a gapless room seq. An idempotency key returns the stored event. Sockets are told after the commit. */
  append(roomId: string, input: RoomAppend): { event: RoomEventRow; duplicate: boolean } {
    return this.atomic(() => {
      const prior = this.eventByKey(roomId, input.idempotencyKey);
      if (prior) return { event: prior, duplicate: true };
      const room = this.room(roomId); if (!room) throw new WorkError("chat_not_found", 404);
      const at = input.createdAt ?? Date.now(), seq = Number(room.last_seq) + 1, eventId = `ev_${ulid(at)}`;
      this.run(`INSERT INTO hub_room_events(room_id,seq,event_id,kind,role,sender_type,sender_id,turn_id,ref_event_id,idempotency_key,created_at,body)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, roomId, seq, eventId, input.kind, input.role, input.senderType, input.senderId, input.turnId ?? null,
        input.refEventId ?? null, input.idempotencyKey, at, JSON.stringify(input.body));
      this.run("UPDATE hub_rooms SET last_seq=? WHERE room_id=?", seq, roomId);
      this.index(roomId);
      this.touch(roomId);
      return { event: this.event(roomId, eventId)!, duplicate: false };
    });
  }
  private cardStatus(roomId: string, cardId: string): string {
    const row = this.row(`SELECT json_extract(body,'$.status') AS status FROM hub_room_events WHERE room_id=? AND kind='card.update'
      AND json_extract(body,'$.cardId')=? ORDER BY seq DESC LIMIT 1`, roomId, cardId);
    return (row?.status as string | undefined) ?? "pending";
  }
  render(roomId: string, event: RoomEventRow, history: boolean): ChatEvent {
    const body = event.body, picked: Record<string, unknown> = {};
    for (const name of fields[event.kind] ?? []) if (body[name] !== undefined && body[name] !== null) picked[name] = body[name];
    if (event.kind === "message") picked.role = event.role === "user" ? "user" : "assistant";
    if (event.kind === "card" && picked.card) {
      const card = picked.card as Record<string, unknown>;
      picked.card = { ...card, status: history ? this.cardStatus(roomId, String(card.cardId)) : String(card.status ?? "pending") };
    }
    const prefix = `web:${event.senderId}:`;
    const own = event.senderType === "person" && event.idempotencyKey?.startsWith(prefix) ? event.idempotencyKey.slice(prefix.length) : undefined;
    const channel = typeof body.channel === "string" ? body.channel : undefined;
    return { chatId: roomChatId(roomId), seq: event.seq, generation: Number(this.room(roomId)?.generation ?? 1), eventId: event.eventId, at: iso(event.createdAt),
      sender: this.actor(event.senderType, event.senderId), ...(channel ? { channel: { kind: channel } } : {}), ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(own && event.kind === "message" ? { idempotencyKey: own } : {}), kind: event.kind, ...picked };
  }

  // ---- chat index -------------------------------------------------------------------------------------------
  private activeTurns(roomId: string): number {
    return Number(this.row(`SELECT COUNT(*) AS n FROM (SELECT turn_id, json_extract(body,'$.state') AS state, MAX(seq) FROM hub_room_events
      WHERE room_id=? AND kind='turn' AND turn_id IS NOT NULL GROUP BY turn_id) WHERE state IN ('queued','running','waiting')`, roomId)!.n);
  }
  private pendingCards(roomId: string): number {
    return Number(this.row(`SELECT COUNT(*) AS n FROM hub_room_events c WHERE c.room_id=? AND c.kind='card' AND NOT EXISTS (SELECT 1 FROM hub_room_events u
      WHERE u.room_id=c.room_id AND u.kind='card.update' AND json_extract(u.body,'$.cardId')=json_extract(c.body,'$.card.cardId'))`, roomId)!.n);
  }
  /** Refresh the room's `hub_chats` row (kind `group`). */
  index(roomId: string): void {
    const room = this.room(roomId); if (!room) return;
    const last = this.row("SELECT * FROM hub_room_events WHERE room_id=? AND kind IN ('message','notice','card') ORDER BY seq DESC LIMIT 1", roomId);
    const event = last ? eventRow(last) : undefined;
    const preview = event ? { eventId: event.eventId, at: iso(event.createdAt), sender: this.actor(event.senderType, event.senderId),
      preview: Array.from(String((event.body.card as { text?: unknown } | undefined)?.text ?? event.body.text ?? "")).slice(0, 140).join("") } : null;
    const updated = Number(this.row("SELECT MAX(created_at) AS at FROM hub_room_events WHERE room_id=?", roomId)?.at ?? 0) || Number(room.created_at);
    this.run(`INSERT INTO hub_chats(chat_id,kind,agent_id,session_key,room_id,title,last_seq,generation,last_event,active_turns,pending_cards,archived,updated_at)
      VALUES(?,'group',NULL,NULL,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, last_seq=excluded.last_seq,
      generation=excluded.generation, last_event=excluded.last_event, active_turns=excluded.active_turns, pending_cards=excluded.pending_cards,
      archived=excluded.archived, updated_at=excluded.updated_at`, roomChatId(roomId), roomId, room.title as string, Number(room.last_seq),
      Number(room.generation), preview ? JSON.stringify(preview) : null, this.activeTurns(roomId), this.pendingCards(roomId), Number(room.archived), updated);
  }
  position(chatId: string): { lastSeq: number; generation: number } {
    const room = this.room(this.roomOf(chatId))!;
    return { lastSeq: Number(room.last_seq), generation: Number(room.generation) };
  }
  readSeq(chatId: string, personId: string): number {
    return Number(this.row("SELECT read_seq FROM hub_read_markers WHERE chat_id=? AND person_id=?", chatId, personId)?.read_seq ?? 0);
  }
  private unread(roomId: string, afterSeq: number, personId: string): number {
    return Number(this.row(`SELECT COUNT(*) AS n FROM hub_room_events WHERE room_id=? AND seq>? AND kind IN ('message','card')
      AND NOT (sender_type='person' AND sender_id=?)`, roomId, afterSeq, personId)!.n);
  }
  summary(chatId: string, personId: string): ChatSummary | undefined {
    let roomId: string; try { roomId = this.roomOf(chatId); } catch { return undefined; }
    if (!this.row("SELECT 1 FROM hub_chats WHERE chat_id=?", chatId)) this.index(roomId);
    const room = this.room(roomId)!, row = this.row("SELECT * FROM hub_chats WHERE chat_id=?", chatId)!;
    const readSeq = this.readSeq(chatId, personId);
    return { chatId, kind: "group", title: room.title as string, agentIds: this.agentIds(roomId), readOnly: !this.enabled || Boolean(room.archived),
      lastSeq: Number(room.last_seq), generation: Number(room.generation), readSeq, unread: this.unread(roomId, readSeq, personId),
      lastEvent: row.last_event ? JSON.parse(String(row.last_event)) : null, activeTurns: Number(row.active_turns), pendingCards: Number(row.pending_cards),
      updatedAt: iso(Number(row.updated_at)) };
  }
  read(chatId: string, personId: string, seq: number): { readSeq: number; unread: number } {
    const roomId = this.roomOf(chatId), lastSeq = Number(this.room(roomId)!.last_seq);
    this.run(`INSERT INTO hub_read_markers(chat_id,person_id,read_seq,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(chat_id,person_id) DO UPDATE SET read_seq=MAX(read_seq,excluded.read_seq), updated_at=excluded.updated_at`,
      chatId, personId, Math.min(Math.max(0, seq), lastSeq), Date.now());
    const readSeq = this.readSeq(chatId, personId);
    for (const socket of this.hub.sockets) if (socket.personId === personId) socket.send({ type: "event", event: "chat.read", data: { chatId, readSeq } });
    return { readSeq, unread: this.unread(roomId, readSeq, personId) };
  }
  /** The member agents' room sessions with running turns contribute their cached text (never stored partials). */
  private inflight(roomId: string, lastSeq: number): Inflight[] {
    return this.agentIds(roomId).flatMap((agentId) => {
      const ledger = this.directory.ledger(agentId), sessionKey = ledger ? roomSession(ledger, roomId) : undefined;
      return ledger && sessionKey ? this.hub.inflight(agentId, sessionKey, ledger, lastSeq) : [];
    });
  }
  /** History paging, as for DMs (ADR 8.3). */
  page(chatId: string, query: HistoryQuery): EventPage {
    const roomId = this.roomOf(chatId), { lastSeq, generation } = this.position(chatId);
    const limit = Math.min(query.limit ?? 50, ROOM_LIMITS.pageEvents);
    const empty = { chatId, generation, lastSeq, events: [] as ChatEvent[], olderCursor: null, newerCursor: null, inflight: [] as Inflight[] };
    const reset = (reason: NonNullable<EventPage["reset"]>["reason"]): EventPage => ({ ...empty, mode: "reset", reset: { reason } });
    if (query.after !== undefined) {
      if (query.generation !== undefined && query.generation !== generation) return reset("generation_changed");
      if (query.after > lastSeq) return reset("not_found");
      if (lastSeq - query.after > ROOM_LIMITS.deltaGap) return reset("gap_too_large");
      const events: ChatEvent[] = []; let bytes = 0;
      for (const event of this.events(roomId, { after: query.after, limit })) {
        const rendered = this.render(roomId, event, true); bytes += size(rendered);
        if (bytes > ROOM_LIMITS.pageBytes && events.length) break;
        events.push(rendered);
      }
      const end = events.at(-1)?.seq ?? query.after;
      if (end < lastSeq && query.strict) return reset("gap_too_large");
      return { ...empty, mode: "delta", events, olderCursor: events[0] && events[0].seq > 1 ? events[0].seq : null,
        newerCursor: end < lastSeq ? end : null, inflight: end < lastSeq ? [] : this.inflight(roomId, lastSeq) };
    }
    const rows = query.before !== undefined ? this.events(roomId, { before: query.before, limit }) : this.events(roomId, { latest: true, limit });
    const events: ChatEvent[] = []; let bytes = 0;
    for (const event of rows.reverse()) {
      const rendered = this.render(roomId, event, true); bytes += size(rendered);
      if (bytes > ROOM_LIMITS.pageBytes && events.length) break;
      events.unshift(rendered);
    }
    const end = events.at(-1)?.seq ?? 0;
    return { ...empty, mode: "page", events, olderCursor: events[0] && events[0].seq > 1 ? events[0].seq : null,
      newerCursor: query.before !== undefined && end < lastSeq ? end : null, inflight: query.before === undefined ? this.inflight(roomId, lastSeq) : [] };
  }
  /** `GET /chats/room:<id>/turns/:turnId` resolves through the turn's agent (17.4). */
  turn(chatId: string, turnId: string) {
    const roomId = this.roomOf(chatId);
    const row = this.row("SELECT sender_type, sender_id, body FROM hub_room_events WHERE room_id=? AND turn_id=? ORDER BY seq LIMIT 1", roomId, turnId);
    const agentId = row ? (row.sender_type === "agent" ? row.sender_id as string : String((JSON.parse(row.body as string) as { agentId?: unknown }).agentId ?? "")) : "";
    const ledger = agentId ? this.directory.ledger(agentId) : undefined, turn = ledger?.turn(turnId);
    if (!ledger || !turn || ledger.session(turn.sessionKey)?.roomId !== roomId) throw new WorkError("turn_not_found", 404);
    // Room event ids, not the agent's own transcript ids.
    const origin = (turn.replyRoute as { messageId?: string } | null)?.messageId;
    const final = this.row("SELECT event_id FROM hub_room_events WHERE room_id=? AND turn_id=? AND kind='message' AND json_extract(body,'$.final')=1 ORDER BY seq DESC LIMIT 1", roomId, turnId);
    return { turnId, chatId, agentId, state: turn.state, admission: turn.admission, ...this.hub.turnDetail(ledger, turnId),
      inputEventIds: origin ? [origin] : [], finalEventId: (final?.event_id as string | undefined) ?? null };
  }

  // ---- sockets ----------------------------------------------------------------------------------------------
  private touch(roomId: string): void {
    this.dirty.add(roomId);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false; const ids = [...this.dirty]; this.dirty = new Set();
      for (const id of ids) try { this.publish(id); } catch { /* Sockets catch up on the next event or a snapshot. */ }
    });
  }
  /** Push new room events to subscribed sockets and the index update to index sockets. */
  publish(roomId: string): void {
    const chatId = roomChatId(roomId), room = this.room(roomId); if (!room) return;
    const generation = Number(room.generation);
    for (const socket of this.hub.sockets) {
      const subscription = socket.subscriptions.get(chatId);
      if (subscription) {
        if (subscription.generation !== generation) {
          socket.subscriptions.set(chatId, { cursor: Number(room.last_seq), generation });
          socket.send({ type: "event", event: "snapshot_required", data: { chatId, reason: "generation_changed" } });
        } else this.replay(socket, chatId, subscription.cursor);
      }
      if (socket.index) { const summary = this.summary(chatId, socket.personId); if (summary) socket.send({ type: "event", event: "chats.updated", data: summary }); }
    }
  }
  replay(socket: HubSocket, chatId: string, cursor: number): void {
    const roomId = this.roomOf(chatId), { lastSeq, generation } = this.position(chatId);
    if (lastSeq <= cursor) return;
    const snapshot = () => {
      socket.subscriptions.set(chatId, { cursor: lastSeq, generation });
      socket.send({ type: "event", event: "snapshot_required", data: { chatId, reason: "gap_too_large" } });
    };
    if (lastSeq - cursor > ROOM_LIMITS.socketReplayEvents) { snapshot(); return; }
    let bytes = 0;
    for (const event of this.events(roomId, { after: cursor, limit: ROOM_LIMITS.socketReplayEvents })) {
      const frame = this.render(roomId, event, false); bytes += size(frame);
      if (bytes > ROOM_LIMITS.socketReplayBytes) { snapshot(); return; }
      socket.send({ type: "event", event: "chat.event", data: frame });
      socket.subscriptions.set(chatId, { cursor: event.seq, generation });
    }
  }

  // ---- commands ---------------------------------------------------------------------------------------------
  /** Idempotent HTTP command through `hub_commands`: the same key and body return the stored response. */
  private command<T>(personId: string, idempotencyKey: string, request: unknown, work: () => T): { response: T; duplicate: boolean } {
    return this.atomic(() => {
      const hash = digest(request), prior = this.row("SELECT request_hash, response FROM hub_commands WHERE person_id=? AND idempotency_key=?", personId, idempotencyKey);
      if (prior) {
        if (prior.request_hash !== hash) throw new WorkError("idempotency_key_reused", 409);
        return { response: JSON.parse(prior.response as string) as T, duplicate: true };
      }
      const response = work();
      this.run("INSERT INTO hub_commands(person_id,idempotency_key,request_hash,response,created_at) VALUES(?,?,?,?,?)", personId, idempotencyKey, hash, JSON.stringify(response), Date.now());
      return { response, duplicate: false };
    });
  }
  /** `POST /groups` (17.1). `active` maps the owner's active agents to their names. */
  create(personId: string, input: { idempotencyKey: string; title: string; agentIds: string[] }, active: Map<string, string>, at = Date.now()): { roomId: string; duplicate: boolean } {
    const title = input.title.trim();
    if (!title || Array.from(title).length > ROOM_LIMITS.titleChars) throw new WorkError("invalid_request", 400);
    const agentIds = [...new Set(input.agentIds)];
    if (!agentIds.length || agentIds.length !== input.agentIds.length || agentIds.length > ROOM_LIMITS.agentsPerRoom) throw new WorkError("invalid_request", 400);
    const { response, duplicate } = this.command(personId, `group:${input.idempotencyKey}`, ["group.create", title, agentIds], () => {
      if (agentIds.some((id) => !active.has(id) || !this.directory.owns(this.hub.ownerId, id))) throw new WorkError("agent_not_found", 422);
      if (Number(this.row("SELECT COUNT(*) AS n FROM hub_rooms")!.n) >= ROOM_LIMITS.roomsPerOwner) throw new WorkError("room_limit_reached", 429);
      const roomId = `rm_${ulid(at)}`;
      this.run("INSERT INTO hub_rooms(room_id,title,created_by,created_at) VALUES(?,?,?,?)", roomId, title, personId, at);
      this.run("INSERT INTO hub_room_members(room_id,member_type,member_id,role,joined_at) VALUES(?,'person',?,'owner',?)", roomId, personId, at);
      for (const agentId of agentIds) this.join(roomId, personId, agentId, at);
      this.index(roomId);
      return { roomId };
    });
    return { roomId: response.roomId, duplicate };
  }
  private join(roomId: string, by: string, agentId: string, at: number): void {
    this.run(`INSERT INTO hub_room_members(room_id,member_type,member_id,role,joined_at,left_at) VALUES(?,'agent',?,'agent',?,NULL)
      ON CONFLICT(room_id,member_type,member_id) DO UPDATE SET left_at=NULL, joined_at=excluded.joined_at`, roomId, agentId, at);
    this.archiveSession(agentId, roomId, false);
    this.append(roomId, { kind: "member", role: "system", senderType: "person", senderId: by, idempotencyKey: `member:add:${agentId}:${at}:${ulid(at)}`,
      createdAt: at, body: { action: "add", member: this.actor("agent", agentId) } });
  }
  private archiveSession(agentId: string, roomId: string, archived: boolean): void {
    const ledger = this.directory.ledger(agentId);
    try { ledger?.store.db.prepare("UPDATE ledger_sessions SET archived=? WHERE room_id=? AND kind='room'").run(archived ? 1 : 0, roomId); }
    catch { /* The session is archived again on the next membership change. */ }
  }
  /** `PATCH /groups/:roomId`: a title change appends `member{action:"rename"}`. */
  update(roomId: string, personId: string, patch: { title?: string | undefined; archived?: boolean | undefined }, at = Date.now()): void {
    const room = this.room(roomId); if (!room) throw new WorkError("chat_not_found", 404);
    const title = patch.title?.trim();
    if (patch.title !== undefined && (!title || Array.from(title).length > ROOM_LIMITS.titleChars)) throw new WorkError("invalid_request", 400);
    this.atomic(() => {
      if (title !== undefined && title !== room.title) {
        this.run("UPDATE hub_rooms SET title=? WHERE room_id=?", title, roomId);
        this.append(roomId, { kind: "member", role: "system", senderType: "person", senderId: personId, idempotencyKey: `member:rename:${ulid(at)}`,
          createdAt: at, body: { action: "rename", title } });
      }
      if (patch.archived !== undefined) this.run("UPDATE hub_rooms SET archived=? WHERE room_id=?", patch.archived ? 1 : 0, roomId);
      this.index(roomId);
    });
    this.touch(roomId);
  }
  addMember(roomId: string, personId: string, agentId: string, active: Map<string, string>, at = Date.now()): Actor[] {
    if (!this.room(roomId)) throw new WorkError("chat_not_found", 404);
    if (!active.has(agentId) || !this.directory.owns(this.hub.ownerId, agentId)) throw new WorkError("agent_not_found", 422);
    this.atomic(() => {
      const members = this.agentIds(roomId);
      if (members.includes(agentId)) return;
      if (members.length >= ROOM_LIMITS.agentsPerRoom) throw new WorkError("too_many_members", 422);
      this.join(roomId, personId, agentId, at);
    });
    return this.members(roomId);
  }
  /** Removal deletes the agent's queued fan-out rows and archives its room session (17.1). */
  removeMember(roomId: string, by: { type: "person" | "system"; id: string }, agentId: string, at = Date.now()): Actor[] {
    if (!this.room(roomId)) throw new WorkError("chat_not_found", 404);
    this.atomic(() => {
      if (!this.agentIds(roomId).includes(agentId)) return;
      this.run("UPDATE hub_room_members SET left_at=? WHERE room_id=? AND member_type='agent' AND member_id=?", at, roomId, agentId);
      this.run("DELETE FROM hub_fanout WHERE room_id=? AND agent_id=? AND status='queued'", roomId, agentId);
      this.archiveSession(agentId, roomId, true);
      this.append(roomId, { kind: "member", role: "system", senderType: by.type, senderId: by.id, idempotencyKey: `member:remove:${agentId}:${ulid(at)}`,
        createdAt: at, body: { action: "remove", member: this.actor("agent", agentId) } });
    });
    return this.members(roomId);
  }
  /** A deleted agent leaves every room (a `member` event each). */
  forgetAgent(agentId: string): void {
    for (const roomId of this.roomsOfAgent(agentId)) this.removeMember(roomId, { type: "system", id: "router" }, agentId);
  }

  // ---- send and fan-out -------------------------------------------------------------------------------------
  private addressed(roomId: string, seq: number): Addressed[] {
    const states = new Map(this.rows("SELECT agent_id, status FROM hub_fanout WHERE room_id=? AND seq=?", roomId, seq)
      .map((row) => [row.agent_id as string, row.status as Addressed["state"]]));
    const agents = [...new Set([...this.agentIds(roomId), ...states.keys()])];
    return agents.map((agentId) => ({ agentId, state: states.get(agentId) ?? "not_addressed" }));
  }
  /**
   * `POST /chats/room:<id>/messages` (17.1, 17.2): one hub transaction appends the owner's message and one fan-out
   * row per addressed agent. The client resolves mentions; the text is never parsed for `@`.
   */
  send(roomId: string, personId: string, input: RoomSendInput, at = Date.now()): { duplicate: boolean; event: ChatEvent; addressed: Addressed[] } {
    const mentions = { agentIds: [...new Set(input.mentions?.agentIds ?? [])].sort(), all: Boolean(input.mentions?.all) };
    const key = `web:${personId}:${input.idempotencyKey}`, requestHash = digest(["room-send", input.text, mentions, input.replyTo ?? null]);
    const result = this.atomic(() => {
      const prior = this.eventByKey(roomId, key);
      if (prior) {
        if (prior.body.requestHash !== requestHash) throw new WorkError("idempotency_key_reused", 409);
        return { duplicate: true, event: prior };
      }
      const members = this.agentIds(roomId);
      if (mentions.agentIds.some((id) => !members.includes(id))) throw new WorkError("mention_not_member", 422);
      if (input.replyTo && !this.event(roomId, input.replyTo)) throw new WorkError("reply_target_not_found", 422);
      const { event } = this.append(roomId, { kind: "message", role: "user", senderType: "person", senderId: personId, idempotencyKey: key,
        refEventId: input.replyTo ?? null, createdAt: at,
        body: { text: input.text, mentions, ...(input.replyTo ? { replyTo: input.replyTo } : {}), channel: "web", requestHash } });
      // Only the owner's messages fan out (decision 4d); agent messages never reach this path.
      const targets = mentions.all ? members : mentions.agentIds;
      for (const agentId of targets) this.run("INSERT OR IGNORE INTO hub_fanout(room_id,seq,agent_id,status,attempts,next_at) VALUES(?,?,?,'queued',0,?)", roomId, event.seq, agentId, at);
      return { duplicate: false, event };
    });
    return { duplicate: result.duplicate, event: this.render(roomId, result.event, true), addressed: this.addressed(roomId, result.event.seq) };
  }
  /** The agent ingress message for one fan-out row (17.2). */
  private message(roomId: string, event: RoomEventRow): ChannelMessage {
    const room = this.room(roomId)!, mentions = event.body.mentions as { all?: boolean } | undefined;
    const replyTo = typeof event.body.replyTo === "string" ? this.event(roomId, event.body.replyTo) : undefined;
    return { externalId: `${roomId}:${event.seq}`, sender: this.hub.ownerId, scope: "group", groupId: roomChatId(roomId),
      threadId: roomChatId(roomId), text: String(event.body.text ?? ""),
      mentions: { self: true, all: Boolean(mentions?.all) }, privateGroup: true,
      ...(replyTo ? { quoted: { messageId: replyTo.eventId, ...(typeof replyTo.body.text === "string" && replyTo.body.text ? { text: cut(replyTo.body.text, ROOM_LIMITS.contextMessageBytes) } : {}) } } : {}),
      reply: { target: roomId, messageId: event.eventId, data: { roomId } } };
  }
  /** Due fan-out rows in `(room, agent, seq)` order. */
  private queued() {
    return this.rows(`SELECT f.room_id, f.seq, f.agent_id, f.attempts, f.next_at, e.created_at FROM hub_fanout f
      JOIN hub_room_events e ON e.room_id=f.room_id AND e.seq=f.seq WHERE f.status='queued' ORDER BY f.room_id, f.agent_id, f.seq`);
  }
  hasQueued(): boolean { return Boolean(this.row("SELECT 1 FROM hub_fanout WHERE status='queued' LIMIT 1")); }
  /**
   * The fan-out worker (17.2): one agent's rows strictly in order; a failing row blocks that agent's later rows in
   * the room. Backoff 1 s × 2ⁿ up to 5 min; after 24 h the row fails and the room gets a warning notice.
   */
  async deliver(channel: (agentId: string) => Promise<RoomDelivery | undefined>, now = Date.now()): Promise<number> {
    const blocked = new Set<string>(); let delivered = 0;
    for (const row of this.queued()) {
      const roomId = row.room_id as string, agentId = row.agent_id as string, seq = Number(row.seq), lane = `${roomId}\n${agentId}`;
      if (blocked.has(lane)) continue;
      if (Number(row.next_at) > now) { blocked.add(lane); continue; }
      const current = this.row("SELECT status FROM hub_fanout WHERE room_id=? AND seq=? AND agent_id=?", roomId, seq, agentId);
      if (current?.status !== "queued") continue;
      try {
        const target = await channel(agentId);
        if (!target) throw new Error("agent_channels_not_configured");
        const event = this.events(roomId, { after: seq - 1, limit: 1 })[0]!;
        try { target.deliver(this.message(roomId, event)); }
        catch (error) {
          // The claim exists with another body (the quoted text changed): the input was already received.
          if (!(error instanceof Error && error.message === "channel_event_id_reused_with_different_payload")) throw error;
        }
        this.run("UPDATE hub_fanout SET status='delivered', attempts=attempts+1, error=NULL WHERE room_id=? AND seq=? AND agent_id=?", roomId, seq, agentId);
        delivered++; this.touch(roomId);
      } catch (error) {
        blocked.add(lane);
        const attempts = Number(row.attempts) + 1, code = error instanceof Error && /^[a-z0-9_:-]+$/.test(error.message) ? error.message : "delivery_failed";
        if (now - Number(row.created_at) >= ROOM_LIMITS.failAfterMs) this.atomic(() => {
          this.run("UPDATE hub_fanout SET status='failed', attempts=?, error=? WHERE room_id=? AND seq=? AND agent_id=?", attempts, code, roomId, seq, agentId);
          this.append(roomId, { kind: "notice", role: "system", senderType: "system", senderId: "router", idempotencyKey: `fanout-failed:${seq}:${agentId}`,
            createdAt: now, body: { text: `未能送达 ${this.directory.agentName(agentId)}：${code}`, level: "warning", agentId } });
        });
        else this.run("UPDATE hub_fanout SET attempts=?, next_at=?, error=? WHERE room_id=? AND seq=? AND agent_id=?",
          attempts, now + Math.min(ROOM_LIMITS.backoffMaxMs, 1000 * 2 ** Math.min(attempts - 1, 20)), code, roomId, seq, agentId);
      }
    }
    return delivered;
  }

  // ---- group context (17.3) ---------------------------------------------------------------------------------
  cursor(roomId: string, agentId: string): number {
    return Number(this.row("SELECT context_seq FROM hub_room_cursors WHERE room_id=? AND agent_id=?", roomId, agentId)?.context_seq ?? 0);
  }
  moveCursor(roomId: string, agentId: string, seq: number): void {
    this.run(`INSERT INTO hub_room_cursors(room_id,agent_id,context_seq) VALUES(?,?,?)
      ON CONFLICT(room_id,agent_id) DO UPDATE SET context_seq=MAX(context_seq,excluded.context_seq)`, roomId, agentId, seq);
  }
  /**
   * Room messages the agent has not seen since its previous turn: `context_seq < seq < originSeq`, without redacted
   * messages, the agent's own messages and inputs addressed to it. Newest 30 messages and 8 KB, each cut to 1 KB.
   * `commit` moves the cursor to `originSeq` once the turn has started.
   */
  context(roomId: string, agentId: string, originSeq: number): { text: string; commit(): void } | undefined {
    if (!this.room(roomId)) return undefined;
    const from = this.cursor(roomId, agentId);
    const rows = this.rows(`SELECT * FROM hub_room_events e WHERE e.room_id=? AND e.kind='message' AND e.seq>? AND e.seq<?
      AND NOT (e.sender_type='agent' AND e.sender_id=?)
      AND NOT EXISTS (SELECT 1 FROM hub_fanout f WHERE f.room_id=e.room_id AND f.seq=e.seq AND f.agent_id=?) ORDER BY e.seq`,
      roomId, from, originSeq, agentId, agentId).map(eventRow).filter((event) => !event.body.redacted);
    const commit = () => this.moveCursor(roomId, agentId, originSeq);
    if (!rows.length) return { text: "", commit };
    const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    const lines: string[] = []; let bytes = 0;
    for (const event of [...rows].reverse()) {
      if (lines.length >= ROOM_LIMITS.contextMessages) break;
      const name = event.senderType === "person" ? "主人" : event.senderType === "agent" ? this.directory.agentName(event.senderId) : event.senderId;
      const attachments = Array.isArray(event.body.attachments) ? (event.body.attachments as Array<{ name?: unknown }>).map((item) => `[附件: ${String(item.name ?? "attachment")}]`) : [];
      const line = [`[${time.format(event.createdAt)}] ${name}: ${cut(String(event.body.text ?? ""), ROOM_LIMITS.contextMessageBytes)}`, ...attachments].join("\n");
      const n = Buffer.byteLength(line) + 1;
      if (bytes + n > ROOM_LIMITS.contextBytes) break;
      lines.unshift(line); bytes += n;
    }
    const omitted = rows.length - lines.length;
    return { text: `群聊上下文（自你上次参与以来 ${rows.length} 条${omitted ? `，省略 ${omitted} 条` : ""}）：\n${lines.join("\n")}`, commit };
  }

  // ---- replies and mirror (17.4) ----------------------------------------------------------------------------
  /**
   * `RoomChannel.send`: the agent's message (or notice) for one delivery, idempotent on `delivery:<agentId>:<deliveryId>`.
   * The returned room event id is the platform message id.
   */
  reply(agentId: string, roomId: string, deliveryId: string, input: { kind: "message" | "notice"; text: string; html?: string | undefined;
    turnId?: string | null | undefined; final?: boolean | undefined; replyTo?: string | undefined; createdAt?: number | undefined }): string {
    if (!this.room(roomId)) throw new Error("room_not_found");
    const replyTo = input.replyTo && this.event(roomId, input.replyTo) ? input.replyTo : undefined;
    return this.append(roomId, { kind: input.kind, role: input.kind === "message" ? "assistant" : "system", senderType: "agent", senderId: agentId,
      turnId: input.turnId ?? null, refEventId: replyTo ?? null, idempotencyKey: `delivery:${agentId}:${deliveryId}`, createdAt: input.createdAt,
      body: input.kind === "message" ? { text: input.text, ...(input.html ? { html: input.html } : {}), ...(replyTo ? { replyTo } : {}), ...(input.final ? { final: true } : {}), agentId }
        : { text: input.text, level: "info", agentId } }).event.eventId;
  }
  /**
   * Publication of an agent's room session: its `turn`, `card` and `card.update` events, and its replies to room
   * turns, are mirrored into the room in ledger order (idempotent keys of 17.4). Returns the last mirrored seq.
   */
  mirror(agentId: string, ledger: AgentLedger, session: LedgerSession): void {
    const roomId = session.roomId; if (!roomId || !this.room(roomId)) return;
    let after = session.publishedSeq;
    for (;;) {
      const batch = ledger.events(session.sessionKey, { after, limit: 500 });
      if (!batch.length) break;
      this.atomic(() => {
        for (const event of batch) {
          const body = event.body;
          if (event.kind === "turn" && event.turnId) {
            const state = String(body.state ?? ""), origin = (ledger.turn(event.turnId)?.replyRoute as { messageId?: string } | null)?.messageId;
            this.append(roomId, { kind: "turn", role: "system", senderType: "system", senderId: "router", turnId: event.turnId, refEventId: origin ?? null,
              idempotencyKey: `turn:${event.turnId}:${state}`, createdAt: event.createdAt,
              body: { agentId, state, inputEventIds: origin ? [origin] : [], ...(body.error ? { error: body.error } : {}) } });
          } else if (event.kind === "card" && body.card) {
            const card = body.card as Record<string, unknown>;
            this.append(roomId, { kind: "card", role: "assistant", senderType: "agent", senderId: agentId, turnId: event.turnId,
              idempotencyKey: `card:${String(card.cardId)}`, createdAt: event.createdAt, body: { card, agentId } });
          } else if (event.kind === "card.update") {
            this.append(roomId, { kind: "card.update", role: "system", senderType: "system", senderId: "router", turnId: event.turnId,
              idempotencyKey: `card.update:${String(body.cardId)}:${String(body.status)}`, createdAt: event.createdAt,
              body: { cardId: body.cardId, status: body.status, ...(body.summary ? { summary: body.summary } : {}), agentId } });
          } else if ((event.kind === "message" || event.kind === "notice") && event.senderType !== "person") {
            const delivery = ledger.deliveriesFor(event.eventId).find((item) => item.connectionId === "room");
            const route = delivery?.route as { target?: string; messageId?: string } | undefined;
            if (delivery && route?.target === roomId) this.reply(agentId, roomId, delivery.deliveryId, { kind: event.kind, text: String(body.text ?? ""),
              html: typeof body.html === "string" ? body.html : undefined, turnId: event.turnId, final: body.final === true, replyTo: route.messageId, createdAt: event.createdAt });
          }
        }
      });
      after = batch.at(-1)!.seq;
    }
  }
}
/** The agent's session for a room (created on the first fan-out, or by the import). */
export function roomSession(ledger: AgentLedger, roomId: string): string | undefined {
  return ledger.store.db.prepare("SELECT session_key FROM ledger_sessions WHERE room_id=? AND kind='room' ORDER BY created_at LIMIT 1").get(roomId)?.session_key as string | undefined;
}
