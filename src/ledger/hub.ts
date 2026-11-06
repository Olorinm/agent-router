import { join } from "node:path";
import { OWNER_HUB_V2 } from "./schema.js";
import { DurableStore } from "../communication/store.js";
import { digest } from "../execution/protocol.js";
import type { RunBinding } from "../execution/host-worker.js";
import { WorkError } from "../execution/work.js";
import { cardSource, conversationKey, legacySession, ulid, type AgentLedger, type LedgerEvent, type LedgerSession } from "./ledger.js";
import { WEB_CONNECTION, webAccount, webTarget } from "../channels/web.js";
import { OWNER_HUB_V1 } from "./schema.js";
import { HubRooms, isRoomChat } from "./rooms.js";

export interface Actor { type: "person" | "agent" | "system" | "external"; id: string; name: string }
export interface ChatSummary {
  chatId: string; kind: "dm" | "group" | "observed"; title: string; agentIds: string[]; readOnly: boolean; lastSeq: number; generation: number;
  readSeq: number; unread: number; lastEvent: { eventId: string; at: string; preview: string; sender: Actor } | null;
  activeTurns: number; pendingCards: number; updatedAt: string;
}
export type ChatEvent = { chatId: string; seq: number; generation: number; eventId: string; at: string; sender: Actor;
  channel?: { kind: string; label?: string }; turnId?: string; kind: string } & Record<string, unknown>;
export interface Inflight { turnId: string; agentId: string; text: string; updatedAt: string; afterSeq: number }
export interface EventPage {
  chatId: string; generation: number; lastSeq: number; mode: "page" | "delta" | "reset";
  reset?: { reason: "generation_changed" | "gap_too_large" | "not_found" }; events: ChatEvent[];
  olderCursor: number | null; newerCursor: number | null; inflight: Inflight[];
}
export interface HistoryQuery { before?: number | undefined; after?: number | undefined; generation?: number | undefined; limit?: number | undefined; strict?: boolean | undefined }
/** What a hub may look up outside its own file. Agent ledgers stay in their agent stores. */
export interface HubDirectory {
  owns(ownerId: string, agentId: string): boolean;
  agentName(agentId: string): string;
  ledger(agentId: string): AgentLedger | undefined;
  personName(personId: string): string | undefined;
  /** ADR 0005 `groups` (phase 5): room commands are accepted; without it room chats are read-only. */
  groups?: boolean | undefined;
}
/** A connected event socket as the hub sees it: a send function and per-chat cursors. */
export interface HubSocket {
  personId: string; index: boolean;
  subscriptions: Map<string, { cursor: number; generation: number }>;
  send(frame: { type: "event"; event: string; data: unknown } | { type: "res"; id: string; ok: boolean; result?: unknown; error?: { code: string } }): void;
}
export const LIMITS = { pageEvents: 200, pageBytes: 1024 * 1024, deltaGap: 1000, socketReplayEvents: 500, socketReplayBytes: 1024 * 1024, subscriptions: 200 };
const fields: Record<string, string[]> = {
  message: ["text", "html", "attachments", "mentions", "replyTo", "final", "possibleDuplicate", "quoted", "media", "event", "truncated", "redacted", "steer"],
  notice: ["text", "level"], action: ["targetCardId", "label"], card: ["card"], "card.update": ["cardId", "status", "answeredBy", "summary"],
  turn: ["agentId", "state", "inputEventIds", "error"], delivery: ["targetEventId", "delivery"], edit: ["targetEventId", "text"],
  redaction: ["targetEventId"], reaction: ["targetEventId", "key", "removed"], window: ["window", "reason"], member: ["action", "member", "title"],
};
const iso = (ms: number) => new Date(ms).toISOString();
/** Host run bindings filtered in SQLite, so history reads never parse the whole run collection in JS. */
function runBindings(ledger: AgentLedger, filter: { taskId?: string; phase?: RunBinding["phase"] }): RunBinding[] {
  const clauses = ["collection='communication_runs'"], args: string[] = [];
  if (filter.taskId !== undefined) { clauses.push("json_extract(value,'$.taskId')=?"); args.push(filter.taskId); }
  if (filter.phase !== undefined) { clauses.push("json_extract(value,'$.phase')=?"); args.push(filter.phase); }
  return ledger.store.db.prepare(`SELECT value FROM documents WHERE ${clauses.join(" AND ")} ORDER BY rowid`).all(...args)
    .map((row) => JSON.parse(String(row.value)) as RunBinding);
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * One owner's hub (ADR 0005 section 4.2): chat index, read markers, rooms and socket fan-out. Events of DM and
 * observed chats stay in the agent ledgers; the hub indexes them and pushes them to sockets.
 */
export class OwnerHub {
  readonly store: DurableStore;
  readonly sockets = new Set<HubSocket>();
  private readonly streams = new Map<string, { at: number; timer?: ReturnType<typeof setTimeout>; text: string }>();
  /** Native groups (phase 5, `rooms.ts`). */
  readonly rooms: HubRooms;
  constructor(readonly ownerId: string, path: string, private readonly directory: HubDirectory) {
    this.store = new DurableStore(path, ownerId);
    this.store.migrate(1, OWNER_HUB_V1);
    this.store.migrate(2, OWNER_HUB_V2);
    this.rooms = new HubRooms(this, directory);
  }
  chatId(agentId: string, session: Pick<LedgerSession, "kind" | "sessionKey"> & Partial<Pick<LedgerSession, "roomId">>) {
    if (session.kind === "room" && session.roomId) return `room:${session.roomId}`;
    return session.kind === "owner_main" ? `dm:${agentId}` : `obs:${agentId}:${session.sessionKey}`;
  }
  /** Resolve an owner-scoped chat id to its agent ledger and session. Unknown or foreign chats are not found. */
  resolve(chatId: string): { agentId: string; kind: "dm" | "observed"; sessionKey: string; ledger: AgentLedger } {
    const match = /^(dm|obs):([^:]+)(?::(.+))?$/.exec(chatId);
    const agentId = match?.[2];
    if (!match || !agentId || !this.directory.owns(this.ownerId, agentId) || (match[1] === "dm") !== (match[3] === undefined)) throw new WorkError("chat_not_found", 404);
    const ledger = this.directory.ledger(agentId);
    if (!ledger) throw new WorkError("agent_ledger_unavailable", 503);
    const sessionKey = match[1] === "dm" ? legacySession(agentId, "owner-main") : match[3]!;
    if (match[1] === "obs" && !ledger.session(sessionKey)) throw new WorkError("chat_not_found", 404);
    return { agentId, kind: match[1] === "dm" ? "dm" : "observed", sessionKey, ledger };
  }
  private actor(agentId: string, event: Pick<LedgerEvent, "senderType" | "senderId">): Actor {
    if (event.senderType === "agent") return { type: "agent", id: event.senderId, name: this.directory.agentName(event.senderId) };
    if (event.senderType === "person") return { type: "person", id: event.senderId, name: this.directory.personName(event.senderId) ?? event.senderId };
    if (event.senderType === "system") return { type: "system", id: event.senderId, name: event.senderId === "router" ? "Router" : event.senderId };
    void agentId; return { type: "external", id: event.senderId, name: event.senderId };
  }
  /** Ledger event → API ChatEvent. History responses carry current card and delivery state. */
  render(chatId: string, agentId: string, ledger: AgentLedger, generation: number, event: LedgerEvent, history: boolean): ChatEvent {
    const body = event.body, picked: Record<string, unknown> = {};
    for (const name of fields[event.kind] ?? []) if (body[name] !== undefined && body[name] !== null) picked[name] = body[name];
    if (Array.isArray(picked.attachments)) picked.attachments = (picked.attachments as Array<Record<string, unknown>>).map((item) =>
      ({ ...item, url: `/_agent-router/v1/web/attachments/${String(item.attachmentId)}` }));
    if (event.kind === "message") picked.role = event.role === "user" ? "user" : "assistant";
    if (event.kind === "delivery" && picked.delivery) picked.delivery = deliveryState(picked.delivery as Record<string, unknown>);
    if (event.kind === "card" && picked.card) {
      const card = picked.card as Record<string, unknown>, current = history ? ledger.card(String(card.cardId)) : undefined;
      picked.card = { ...card, source: card.source ?? cardSource(String(card.callId ?? "")), status: current?.status ?? "pending" };
    }
    if (event.kind === "card.update" && typeof picked.answeredBy === "string")
      picked.answeredBy = this.actor(agentId, { senderType: "person", senderId: picked.answeredBy });
    if (history && event.kind === "message") {
      const deliveries = ledger.deliveriesFor(event.eventId).filter((item) => item.purpose !== "activity");
      if (deliveries.length) picked.deliveries = deliveries.map((item) => deliveryState({ deliveryId: item.deliveryId, connectionId: item.connectionId,
        channel: (item.route as { channel?: string } | null)?.channel, status: item.status, error: item.error ?? undefined }));
    }
    const channel = body.origin === "schedule" ? "schedule" : typeof body.channel === "string" ? body.channel : undefined;
    // The client's key, on the sender's own web messages only (chats are owner-only, so the reader is the sender).
    const own = event.senderType === "person" && event.idempotencyKey?.startsWith(`${WEB_CONNECTION}:${event.senderId}:`)
      ? event.idempotencyKey.slice(WEB_CONNECTION.length + event.senderId.length + 2) : undefined;
    return { chatId, seq: event.seq, generation, eventId: event.eventId, at: iso(event.createdAt), sender: this.actor(agentId, event),
      ...(channel ? { channel: { kind: channel } } : {}), ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(own && event.kind === "message" ? { idempotencyKey: own } : {}), kind: event.kind, ...picked };
  }
  /** Publication (ADR 6.6): refresh the index from the ledger, push new events, then acknowledge. */
  publish(agentId: string, sessionKey: string): void {
    const ledger = this.directory.ledger(agentId);
    const session = ledger?.session(sessionKey);
    if (!ledger || !session || !this.directory.owns(this.ownerId, agentId)) return;
    // A room session is not a chat of its own: its turns, cards and replies are mirrored into the room.
    if (session.kind === "room" && session.roomId) { this.rooms.mirror(agentId, ledger, session); ledger.markPublished(sessionKey, session.lastSeq); return; }
    const chatId = this.chatId(agentId, session);
    const prior = this.store.db.prepare("SELECT generation FROM hub_chats WHERE chat_id=?").get(chatId);
    const last = ledger.latestVisible(sessionKey);
    const preview = last ? { eventId: last.eventId, at: iso(last.createdAt), sender: this.actor(agentId, last),
      preview: Array.from(String((last.body.card as { text?: unknown } | undefined)?.text ?? last.body.text ?? "")).slice(0, 140).join("") } : null;
    this.store.db.prepare(`INSERT INTO hub_chats(chat_id,kind,agent_id,session_key,title,last_seq,generation,last_event,active_turns,pending_cards,archived,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, last_seq=excluded.last_seq, generation=excluded.generation,
      last_event=excluded.last_event, active_turns=excluded.active_turns, pending_cards=excluded.pending_cards, archived=excluded.archived, updated_at=excluded.updated_at`)
      .run(chatId, session.kind === "owner_main" ? "dm" : "observed", agentId, sessionKey,
        session.kind === "owner_main" ? this.directory.agentName(agentId) : session.title ?? session.label, session.lastSeq, session.generation,
        preview ? JSON.stringify(preview) : null, ledger.activeTurns(sessionKey), ledger.pendingCards(sessionKey), session.archived ? 1 : 0, session.updatedAt);
    const changed = prior !== undefined && Number(prior.generation) !== session.generation;
    for (const socket of this.sockets) {
      const subscription = socket.subscriptions.get(chatId);
      if (subscription) {
        if (changed || subscription.generation !== session.generation) {
          socket.subscriptions.set(chatId, { cursor: session.lastSeq, generation: session.generation });
          socket.send({ type: "event", event: "snapshot_required", data: { chatId, reason: "generation_changed" } });
        } else this.replay(socket, chatId, subscription.cursor);
      }
      if (socket.index) { const summary = this.summary(chatId, socket.personId); if (summary) socket.send({ type: "event", event: "chats.updated", data: summary }); }
    }
    ledger.markPublished(sessionKey, session.lastSeq);
  }
  /**
   * `POST /chats/dm`: create the owner-main session and the person's web conversation (its `primary`) when they do
   * not exist yet, then index the chat. Idempotent.
   */
  openDm(agentId: string, personId: string, at = Date.now()): void {
    const { sessionKey, ledger } = this.resolve(`dm:${agentId}`);
    const conversation = { connectionId: WEB_CONNECTION, channel: "web", accountId: webAccount(this.ownerId), kind: "direct" as const,
      peerId: webTarget(personId), sessionKey, personId, replyRoute: { connectionId: WEB_CONNECTION, target: webTarget(personId), messageId: "", data: {} }, at };
    ledger.store.transaction(() => {
      ledger.ensureSession(sessionKey, "owner_main", "owner-main", at);
      if (!ledger.conversationSession(conversationKey(conversation))) ledger.ensureConversation(conversation, "primary");
    });
    this.publish(agentId, sessionKey);
  }
  /** Publish every session of an agent whose ledger is ahead of the hub (startup and recovery). */
  sync(agentId: string): void {
    const ledger = this.directory.ledger(agentId); if (!ledger) return;
    for (const session of ledger.sessions()) {
      if (session.kind === "room") { if (session.lastSeq > session.publishedSeq) this.publish(agentId, session.sessionKey); continue; }
      const indexed = this.store.db.prepare("SELECT last_seq, generation FROM hub_chats WHERE chat_id=?").get(this.chatId(agentId, session));
      if (session.lastSeq > session.publishedSeq || !indexed || Number(indexed.last_seq) !== session.lastSeq || Number(indexed.generation) !== session.generation)
        this.publish(agentId, session.sessionKey);
    }
  }
  forget(agentId: string): void {
    const chats = this.store.db.prepare("SELECT chat_id FROM hub_chats WHERE agent_id=?").all(agentId).map((row) => row.chat_id as string);
    this.store.transaction(() => {
      for (const chatId of chats) {
        this.store.db.prepare("DELETE FROM hub_chats WHERE chat_id=?").run(chatId);
        this.store.db.prepare("DELETE FROM hub_read_markers WHERE chat_id=?").run(chatId);
      }
    });
    for (const socket of this.sockets) for (const chatId of chats) socket.subscriptions.delete(chatId);
    this.rooms.forgetAgent(agentId);
  }
  private replay(socket: HubSocket, chatId: string, cursor: number): void {
    if (isRoomChat(chatId)) { this.rooms.replay(socket, chatId, cursor); return; }
    const { agentId, sessionKey, ledger } = this.resolve(chatId);
    const session = ledger.session(sessionKey); if (!session || session.lastSeq <= cursor) return;
    if (session.lastSeq - cursor > LIMITS.socketReplayEvents) {
      socket.subscriptions.set(chatId, { cursor: session.lastSeq, generation: session.generation });
      socket.send({ type: "event", event: "snapshot_required", data: { chatId, reason: "gap_too_large" } }); return;
    }
    let bytes = 0;
    for (const event of ledger.events(sessionKey, { after: cursor, limit: LIMITS.socketReplayEvents })) {
      const frame = this.render(chatId, agentId, ledger, session.generation, event, false);
      bytes += size(frame);
      if (bytes > LIMITS.socketReplayBytes) {
        socket.subscriptions.set(chatId, { cursor: session.lastSeq, generation: session.generation });
        socket.send({ type: "event", event: "snapshot_required", data: { chatId, reason: "gap_too_large" } }); return;
      }
      socket.send({ type: "event", event: "chat.event", data: frame });
      socket.subscriptions.set(chatId, { cursor: event.seq, generation: session.generation });
    }
  }
  /**
   * Subscribe (ADR 8.4). Chats that do not resolve are listed in `errors` and are not subscribed; the others are.
   * The response goes first; `then()` sends the replay or `snapshot_required` frames.
   */
  subscribe(socket: HubSocket, chats: Array<{ chatId: string; afterSeq?: number | undefined; generation?: number | undefined }>, index?: boolean) {
    if (new Set([...socket.subscriptions.keys(), ...chats.map((chat) => chat.chatId)]).size > LIMITS.subscriptions) throw new WorkError("too_many_subscriptions", 429);
    const errors: Array<{ chatId: string; code: string }> = [], resolved = [];
    for (const chat of chats) {
      try { resolved.push({ chat, position: isRoomChat(chat.chatId) ? this.rooms.position(chat.chatId) : this.position(chat.chatId) }); }
      catch (error) { socket.subscriptions.delete(chat.chatId); errors.push({ chatId: chat.chatId, code: error instanceof WorkError ? error.message : "operation_failed" }); }
    }
    if (index !== undefined) socket.index = index;
    const after: Array<() => void> = [];
    const result = resolved.map(({ chat, position: { lastSeq, generation } }) => {
      if (chat.afterSeq === undefined) { socket.subscriptions.set(chat.chatId, { cursor: lastSeq, generation }); return { chatId: chat.chatId, mode: "live", lastSeq, generation }; }
      const reason = chat.generation !== undefined && chat.generation !== generation ? "generation_changed" :
        chat.afterSeq > lastSeq ? "not_found" : lastSeq - chat.afterSeq > LIMITS.socketReplayEvents ? "gap_too_large" : undefined;
      if (reason) {
        socket.subscriptions.set(chat.chatId, { cursor: lastSeq, generation });
        after.push(() => socket.send({ type: "event", event: "snapshot_required", data: { chatId: chat.chatId, reason } }));
        return { chatId: chat.chatId, mode: "reset", lastSeq, generation };
      }
      socket.subscriptions.set(chat.chatId, { cursor: chat.afterSeq, generation });
      after.push(() => this.replay(socket, chat.chatId, chat.afterSeq!));
      return { chatId: chat.chatId, mode: "delta", lastSeq, generation };
    });
    return { result: { chats: result, errors }, then: () => { for (const send of after) send(); } };
  }
  private position(chatId: string): { lastSeq: number; generation: number } {
    const { sessionKey, ledger } = this.resolve(chatId), session = ledger.session(sessionKey);
    return { lastSeq: session?.lastSeq ?? 0, generation: session?.generation ?? 1 };
  }
  unsubscribe(socket: HubSocket, chatIds: string[]) { for (const chatId of chatIds) socket.subscriptions.delete(chatId); }
  /**
   * Streaming partials are never stored; at most one frame per chat and turn every 250 ms, the latest text wins.
   * Throttle entries idle for a minute are dropped, so finished turns do not accumulate.
   */
  stream(agentId: string, sessionKey: string, turnId: string, text: string): void {
    const ledger = this.directory.ledger(agentId), session = ledger?.session(sessionKey);
    if (!ledger || !session) return;
    const now = Date.now();
    for (const [key, entry] of this.streams) if (!entry.timer && now - entry.at > 60_000) this.streams.delete(key);
    const chatId = this.chatId(agentId, session), id = `${chatId}\n${turnId}`;
    const send = () => {
      const entry = this.streams.get(id); if (!entry) return;
      entry.at = Date.now(); delete entry.timer;
      const data = { chatId, turnId, agentId, state: "delta", text: entry.text, afterSeq: ledger.session(sessionKey)?.lastSeq ?? session.lastSeq };
      for (const socket of this.sockets) if (socket.subscriptions.has(chatId)) socket.send({ type: "event", event: "chat.stream", data });
    };
    const entry = this.streams.get(id) ?? { at: 0, text };
    entry.text = text; this.streams.set(id, entry);
    if (entry.timer) return;
    const wait = entry.at + 250 - Date.now();
    if (wait <= 0) send(); else { entry.timer = setTimeout(send, wait); entry.timer.unref?.(); }
  }
  readSeq(chatId: string, personId: string): number {
    return Number(this.store.db.prepare("SELECT read_seq FROM hub_read_markers WHERE chat_id=? AND person_id=?").get(chatId, personId)?.read_seq ?? 0);
  }
  summary(chatId: string, personId: string): ChatSummary | undefined {
    if (isRoomChat(chatId)) return this.rooms.summary(chatId, personId);
    let target; try { target = this.resolve(chatId); } catch { return undefined; }
    const row = this.store.db.prepare("SELECT * FROM hub_chats WHERE chat_id=?").get(chatId);
    const session = target.ledger.session(target.sessionKey);
    const readSeq = this.readSeq(chatId, personId);
    return { chatId, kind: target.kind, title: row ? String(row.title) : target.kind === "dm" ? this.directory.agentName(target.agentId) : session?.label ?? chatId,
      agentIds: [target.agentId], readOnly: target.kind === "observed", lastSeq: session?.lastSeq ?? 0, generation: session?.generation ?? 1, readSeq,
      unread: session ? target.ledger.unread(target.sessionKey, readSeq, personId) : 0,
      lastEvent: row?.last_event ? JSON.parse(String(row.last_event)) : null,
      activeTurns: row ? Number(row.active_turns) : 0, pendingCards: row ? Number(row.pending_cards) : 0,
      updatedAt: iso(row ? Number(row.updated_at) : session?.updatedAt ?? 0) };
  }
  chats(personId: string, options: { archived?: boolean; cursor?: string | undefined; limit?: number } = {}): { data: ChatSummary[]; next: string | null } {
    const offset = Number(options.cursor ?? 0), limit = options.limit ?? 50;
    const rows = this.store.db.prepare("SELECT chat_id, kind, agent_id FROM hub_chats WHERE archived=? ORDER BY updated_at DESC, chat_id LIMIT ? OFFSET ?")
      .all(options.archived ? 1 : 0, limit + 1, offset);
    const data = rows.slice(0, limit).filter((row) => row.kind === "group" || this.directory.owns(this.ownerId, String(row.agent_id)))
      .map((row) => this.summary(String(row.chat_id), personId)).filter((item): item is ChatSummary => Boolean(item));
    return { data, next: rows.length > limit ? String(offset + limit) : null };
  }
  /** History paging (ADR 8.3): latest page, `before=` for older pages, `after=`+`generation=` for catch-up. */
  page(chatId: string, query: HistoryQuery): EventPage {
    if (isRoomChat(chatId)) return this.rooms.page(chatId, query);
    const { agentId, sessionKey, ledger } = this.resolve(chatId);
    const session = ledger.session(sessionKey);
    const generation = session?.generation ?? 1, lastSeq = session?.lastSeq ?? 0, limit = Math.min(query.limit ?? 50, LIMITS.pageEvents);
    const empty = { chatId, generation, lastSeq, events: [] as ChatEvent[], olderCursor: null, newerCursor: null, inflight: [] as Inflight[] };
    const reset = (reason: NonNullable<EventPage["reset"]>["reason"]): EventPage => ({ ...empty, mode: "reset", reset: { reason } });
    const render = (event: LedgerEvent) => this.render(chatId, agentId, ledger, generation, event, true);
    if (query.after !== undefined) {
      if (query.generation !== undefined && query.generation !== generation) return reset("generation_changed");
      if (query.after > lastSeq) return reset("not_found");
      if (lastSeq - query.after > LIMITS.deltaGap) return reset("gap_too_large");
      const events: ChatEvent[] = []; let bytes = 0;
      for (const event of ledger.events(sessionKey, { after: query.after, limit })) {
        const rendered = render(event); bytes += size(rendered);
        if (bytes > LIMITS.pageBytes && events.length) break;
        events.push(rendered);
      }
      const end = events.at(-1)?.seq ?? query.after;
      if (end < lastSeq && query.strict) return reset("gap_too_large");
      return { ...empty, mode: "delta", events, olderCursor: events[0] && events[0].seq > 1 ? events[0].seq : null,
        newerCursor: end < lastSeq ? end : null, inflight: end < lastSeq ? [] : this.inflight(agentId, sessionKey, ledger, lastSeq) };
    }
    const rows = query.before !== undefined ? ledger.events(sessionKey, { before: query.before, limit }) : ledger.events(sessionKey, { latest: true, limit });
    const events: ChatEvent[] = []; let bytes = 0;
    for (const event of rows.reverse()) {
      const rendered = render(event); bytes += size(rendered);
      if (bytes > LIMITS.pageBytes && events.length) break;
      events.unshift(rendered);
    }
    const end = events.at(-1)?.seq ?? 0;
    return { ...empty, mode: "page", events, olderCursor: events[0] && events[0].seq > 1 ? events[0].seq : null,
      newerCursor: query.before !== undefined && end < lastSeq ? end : null,
      inflight: query.before === undefined ? this.inflight(agentId, sessionKey, ledger, lastSeq) : [] };
  }
  /** In-flight text of running turns comes from the Host run cache, never from stored partials. */
  inflight(agentId: string, sessionKey: string, ledger: AgentLedger, afterSeq: number): Inflight[] {
    if (!ledger.activeTurns(sessionKey)) return [];
    return runBindings(ledger, { phase: "running" })
      .filter((run) => run.runId && (ledger.sessionForContext(run.contextId) ?? run.contextId) === sessionKey)
      .flatMap((run) => {
        const cached = ledger.store.get<{ text: string }>("communication_run_events", run.runId!);
        return cached?.text ? [{ turnId: run.taskId, agentId, text: cached.text, updatedAt: iso(Date.now()), afterSeq }] : [];
      });
  }
  /** Monotonic read marker; other tabs of the same person get `chat.read`. */
  read(chatId: string, personId: string, seq: number): { readSeq: number; unread: number } {
    if (isRoomChat(chatId)) return this.rooms.read(chatId, personId, seq);
    const { sessionKey, ledger } = this.resolve(chatId);
    const lastSeq = ledger.session(sessionKey)?.lastSeq ?? 0;
    this.store.db.prepare(`INSERT INTO hub_read_markers(chat_id,person_id,read_seq,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(chat_id,person_id) DO UPDATE SET read_seq=MAX(read_seq,excluded.read_seq), updated_at=excluded.updated_at`)
      .run(chatId, personId, Math.min(Math.max(0, seq), lastSeq), Date.now());
    const readSeq = this.readSeq(chatId, personId);
    for (const socket of this.sockets) if (socket.personId === personId) socket.send({ type: "event", event: "chat.read", data: { chatId, readSeq } });
    return { readSeq, unread: ledger.unread(sessionKey, readSeq, personId) };
  }
  turn(chatId: string, turnId: string) {
    if (isRoomChat(chatId)) return this.rooms.turn(chatId, turnId);
    const { agentId, sessionKey, ledger } = this.resolve(chatId);
    const turn = ledger.turn(turnId);
    if (!turn || turn.sessionKey !== sessionKey) throw new WorkError("turn_not_found", 404);
    return { turnId, chatId, agentId, state: turn.state, admission: turn.admission, ...this.turnDetail(ledger, turnId) };
  }
  turnDetail(ledger: AgentLedger, turnId: string) {
    return { inputEventIds: ledger.turnInputs(turnId), finalEventId: ledger.turn(turnId)?.finalEventId ?? null, cardIds: ledger.cardsForTurn(turnId),
      runs: runBindings(ledger, { taskId: turnId }).map((run) => ({ claimId: run.claimId, runId: run.runId ?? null, phase: run.phase, error: run.error ?? null })) };
  }
  /** Imported `ai.mau.room` groups (backfill). Served from phase 5; the id is derived so every agent imports the same room. */
  importRoom(matrixRoomId: string, title: string, members: Array<{ type: "person" | "agent"; id: string }>, at = Date.now()): string {
    const roomId = `rm_${digest(["matrix-room", matrixRoomId]).slice(0, 26)}`;
    this.store.db.prepare("INSERT OR IGNORE INTO hub_rooms(room_id,title,created_by,created_at,matrix_room_id) VALUES(?,?,?,?,?)")
      .run(roomId, title, this.ownerId, at, matrixRoomId);
    for (const member of members) this.store.db.prepare(`INSERT OR IGNORE INTO hub_room_members(room_id,member_type,member_id,role,joined_at) VALUES(?,?,?,?,?)`)
      .run(roomId, member.type, member.id, member.type === "person" ? "owner" : "agent", at);
    return roomId;
  }
  appendRoomEvent(roomId: string, input: { kind: string; role: string; senderType: string; senderId: string; refEventId?: string | null | undefined;
    idempotencyKey: string; createdAt: number; body: Record<string, unknown> }): { eventId: string; duplicate: boolean } {
    const prior = this.store.db.prepare("SELECT event_id FROM hub_room_events WHERE room_id=? AND idempotency_key=?").get(roomId, input.idempotencyKey);
    if (prior) return { eventId: String(prior.event_id), duplicate: true };
    const seq = Number(this.store.db.prepare("SELECT last_seq FROM hub_rooms WHERE room_id=?").get(roomId)!.last_seq) + 1, eventId = `ev_${ulid(input.createdAt)}`;
    this.store.db.prepare(`INSERT INTO hub_room_events(room_id,seq,event_id,kind,role,sender_type,sender_id,ref_event_id,idempotency_key,created_at,body)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(roomId, seq, eventId, input.kind, input.role, input.senderType, input.senderId, input.refEventId ?? null,
      input.idempotencyKey, input.createdAt, JSON.stringify(input.body));
    this.store.db.prepare("UPDATE hub_rooms SET last_seq=? WHERE room_id=?").run(seq, roomId);
    return { eventId, duplicate: false };
  }
  roomEventByKey(roomId: string, idempotencyKey: string): string | undefined {
    return this.store.db.prepare("SELECT event_id FROM hub_room_events WHERE room_id=? AND idempotency_key=?").get(roomId, idempotencyKey)?.event_id as string | undefined;
  }
  /** Idempotent HTTP commands other than send (ADR 4.2 `hub_commands`): card answers, steer, reset, purge. */
  command(personId: string, idempotencyKey: string): { hash: string; response: Record<string, unknown> } | undefined {
    const row = this.store.db.prepare("SELECT request_hash, response FROM hub_commands WHERE person_id=? AND idempotency_key=?").get(personId, idempotencyKey);
    return row ? { hash: String(row.request_hash), response: JSON.parse(String(row.response)) as Record<string, unknown> } : undefined;
  }
  saveCommand(personId: string, idempotencyKey: string, hash: string, response: Record<string, unknown>, at = Date.now()): void {
    this.store.db.prepare(`INSERT INTO hub_commands(person_id,idempotency_key,request_hash,response,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(person_id,idempotency_key) DO UPDATE SET response=excluded.response WHERE request_hash=excluded.request_hash`)
      .run(personId, idempotencyKey, hash, JSON.stringify(response), at);
  }
  /** After a purge the chat restarts at seq 1: read markers of the old generation are dropped. */
  clearRead(chatId: string): void { this.store.db.prepare("DELETE FROM hub_read_markers WHERE chat_id=?").run(chatId); }
  close(): void { for (const entry of this.streams.values()) clearTimeout(entry.timer); this.store.close(); }
}
function deliveryState(value: Record<string, unknown>) {
  return { deliveryId: String(value.deliveryId), channel: { kind: String(value.channel ?? "unknown"), ...(value.connectionId ? { label: String(value.connectionId) } : {}) },
    status: String(value.status), ...(value.error ? { error: String(value.error) } : {}) };
}

/** Lazily opened per-owner hubs (`state/owners/<digest(ownerId)>.sqlite`). */
export class OwnerHubs {
  private readonly hubs = new Map<string, OwnerHub>();
  constructor(readonly stateDir: string, readonly directory: HubDirectory) {}
  hub(ownerId: string): OwnerHub {
    let hub = this.hubs.get(ownerId);
    if (!hub) { hub = new OwnerHub(ownerId, this.stateDir === ":memory:" ? ":memory:" : join(this.stateDir, "owners", `${digest(ownerId)}.sqlite`), this.directory); this.hubs.set(ownerId, hub); }
    return hub;
  }
  /** Hubs opened by this process (every owner with a started agent); the attachment sweeper walks these. */
  open(): OwnerHub[] { return [...this.hubs.values()]; }
  sockets(): number { return [...this.hubs.values()].reduce((total, hub) => total + hub.sockets.size, 0); }
  close(): void { for (const hub of this.hubs.values()) hub.close(); this.hubs.clear(); }
}
