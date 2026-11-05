import { randomBytes } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { DurableStore } from "../communication/store.js";
import { digest, key } from "../execution/protocol.js";
import { AGENT_LEDGER_V1 } from "./schema.js";

export type SessionKind = "owner_main" | "peer" | "group" | "room" | "schedule" | "work" | "delegation";
export type Admission = "owner" | "peer" | "group" | "schedule" | "work" | "delegation";
export type TurnState = "queued" | "running" | "waiting" | "completed" | "failed" | "canceled" | "unknown";
export type DeliveryStatus = "created" | "queued" | "sending" | "sent" | "suppressed" | "rejected" | "unknown" | "replied";
export type DeliveryPurpose = "reply" | "notice" | "card" | "content" | "activity" | "mirror";
export type InputState = "queued" | "starting" | "started" | "control" | "dropped" | "unknown";
export interface EventInput {
  kind: string; role: "user" | "assistant" | "system"; senderType: "person" | "agent" | "external" | "system"; senderId: string;
  conversationId?: string | null | undefined; turnId?: string | null | undefined; refEventId?: string | null | undefined;
  idempotencyKey?: string | null | undefined; createdAt?: number | undefined; body: Record<string, unknown>;
}
export interface LedgerEvent {
  sessionKey: string; seq: number; eventId: string; window: number; kind: string; role: EventInput["role"];
  senderType: EventInput["senderType"]; senderId: string; conversationId: string | null; turnId: string | null;
  refEventId: string | null; idempotencyKey: string | null; createdAt: number; body: Record<string, unknown>;
}
export interface LedgerSession {
  sessionKey: string; kind: SessionKind; label: string; roomId: string | null; window: number; lastSeq: number;
  generation: number; publishedSeq: number; title: string | null; archived: boolean; createdAt: number; updatedAt: number;
}
export interface ConversationInput {
  connectionId: string; channel: string; accountId: string; kind: "direct" | "group" | "channel"; peerId: string;
  parentId?: string | undefined; threadId?: string | undefined; sessionKey: string; personId?: string | undefined;
  replyRoute: unknown; title?: string | undefined; at: number;
}
export interface Claim {
  connectionId: string; externalId: string; inputId: string; hash: string; state: "accepted" | "ignored" | "tombstone";
  reason: string | null; eventId: string | null; conversationId: string | null; receivedAt: number; expiresAt: number | null;
}
export interface Turn {
  turnId: string; sessionKey: string; window: number; admission: Admission; originConversationId: string | null;
  originEventId: string | null; replyRoute: unknown; state: TurnState; finalEventId: string | null; error: string | null;
  createdAt: number; startedAt: number | null; finishedAt: number | null;
}
export interface Delivery {
  deliveryId: string; eventId: string | null; conversationId: string; connectionId: string; route: unknown;
  purpose: DeliveryPurpose; status: DeliveryStatus; attempts: number; nextAt: number; platformMessageId: string | null;
  error: string | null; createdAt: number; updatedAt: number;
}
type Row = Record<string, SQLInputValue>;
const TOMBSTONE_MS = 30 * 24 * 3600_000, MAX_BODY = 256 * 1024;
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Lexicographically time-ordered id (ULID layout: 48-bit ms time, 80 random bits). */
export function ulid(now = Date.now()): string {
  let time = "", t = now;
  for (let i = 0; i < 10; i++) { time = crockford[t % 32] + time; t = Math.floor(t / 32); }
  const bytes = randomBytes(16); let random = "";
  for (let i = 0; i < 16; i++) random += crockford[bytes[i]! % 32];
  return time + random;
}
export const legacySession = (agentId: string, scope: string) => `c-${digest(key(agentId, scope)).slice(0, 40)}`;
export const conversationKey = (input: Pick<ConversationInput, "channel" | "accountId" | "kind" | "peerId" | "parentId" | "threadId">) =>
  `cv_${digest([input.channel, input.accountId, input.kind, input.peerId, input.parentId ?? "", input.threadId ?? ""]).slice(0, 40)}`;
const terminalTurn = new Set<TurnState>(["completed", "failed", "canceled"]);

/**
 * The per-agent transcript ledger (ADR 0005 section 4.1) inside the agent's existing SQLite file.
 * Seq is assigned only here. No network call runs inside its transactions.
 */
export class AgentLedger {
  private static readonly ledgers = new WeakMap<DurableStore, AgentLedger>();
  /** Create the tables (once) and attach the ledger to this store; channel cores then shadow-write into it. */
  static open(store: DurableStore): AgentLedger {
    let ledger = this.ledgers.get(store);
    if (!ledger) { store.migrate(1, AGENT_LEDGER_V1); ledger = new AgentLedger(store); this.ledgers.set(store, ledger); }
    return ledger;
  }
  static attached(store: DurableStore): AgentLedger | undefined { return this.ledgers.get(store); }
  lastError = "";
  private readonly listeners = new Set<(sessionKey: string) => void>();
  private readonly streams = new Set<(sessionKey: string, turnId: string, text: string) => void>();
  private dirty = new Set<string>();
  private scheduled = false;
  private constructor(readonly store: DurableStore) {}
  private get db() { return this.store.db; }
  private row(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).get(...args) as Row | undefined; }
  private rows(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).all(...args) as Row[]; }
  private run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }

  /** Publication signal (ADR 6.6). Fired after the writing call stack, so the commit is visible. */
  listen(listener: (sessionKey: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  listenStream(listener: (sessionKey: string, turnId: string, text: string) => void): () => void { this.streams.add(listener); return () => { this.streams.delete(listener); }; }
  stream(sessionKey: string, turnId: string, text: string): void { for (const listener of this.streams) try { listener(sessionKey, turnId, text); } catch { /* Streams are best effort. */ } }
  private touch(sessionKey: string) {
    this.dirty.add(sessionKey);
    if (this.scheduled || !this.listeners.size) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false; const keys = [...this.dirty]; this.dirty = new Set();
      for (const sessionKey of keys) for (const listener of this.listeners) try { listener(sessionKey); } catch { /* The hub catches up later. */ }
    });
  }
  /**
   * Shadow write: a ledger failure never changes the legacy path. Inside an outer transaction the work runs
   * in a savepoint, so a ledger error rolls back only the ledger rows.
   */
  shadow<T>(work: () => T): T | undefined {
    try {
      if (!this.db.isTransaction) return this.store.transaction(work);
      this.db.exec("SAVEPOINT ledger_shadow");
      try { const result = work(); this.db.exec("RELEASE ledger_shadow"); return result; }
      catch (error) { this.db.exec("ROLLBACK TO ledger_shadow"); this.db.exec("RELEASE ledger_shadow"); throw error; }
    } catch (error) {
      this.lastError = error instanceof Error && /^[a-z0-9_:-]+$/.test(error.message) ? error.message : "ledger_write_failed";
      return undefined;
    }
  }

  ensureSession(sessionKey: string, kind: SessionKind, label: string, at = Date.now(), roomId?: string): LedgerSession {
    if (this.run(`INSERT OR IGNORE INTO ledger_sessions(session_key,kind,label,room_id,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
      sessionKey, kind, label, roomId ?? null, at, at).changes)
      this.run(`INSERT OR IGNORE INTO ledger_session_windows(session_key,window,context_id,opened_at) VALUES(?,1,?,?)`, sessionKey, sessionKey, at);
    return this.session(sessionKey)!;
  }
  session(sessionKey: string): LedgerSession | undefined {
    const row = this.row("SELECT * FROM ledger_sessions WHERE session_key=?", sessionKey);
    return row ? sessionRow(row) : undefined;
  }
  sessions(): LedgerSession[] { return this.rows("SELECT * FROM ledger_sessions ORDER BY created_at, session_key").map(sessionRow); }
  /** Map an execution context id (a session key or a later window's context id) to its session. */
  sessionForContext(contextId: string): string | undefined {
    return this.row("SELECT session_key FROM ledger_session_windows WHERE context_id=?", contextId)?.session_key as string | undefined;
  }
  markPublished(sessionKey: string, seq: number): void {
    this.run("UPDATE ledger_sessions SET published_seq=MAX(published_seq,?) WHERE session_key=?", seq, sessionKey);
  }

  /** A conversation never moves to another session; a later receipt only refreshes its reply route. */
  ensureConversation(input: ConversationInput, role: "primary" | "participant" | "related" = "participant"): string {
    const id = conversationKey(input);
    this.run(`INSERT INTO ledger_conversations(conversation_id,connection_id,channel,account_id,kind,peer_id,parent_id,thread_id,
      session_key,person_id,reply_route,title,created_at,last_inbound_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET reply_route=excluded.reply_route, last_inbound_at=excluded.last_inbound_at,
      person_id=COALESCE(ledger_conversations.person_id, excluded.person_id)`,
      id, input.connectionId, input.channel, input.accountId, input.kind, input.peerId, input.parentId ?? "", input.threadId ?? "",
      input.sessionKey, input.personId ?? null, JSON.stringify(input.replyRoute ?? null), input.title ?? null, input.at, input.at);
    const sessionKey = this.row("SELECT session_key FROM ledger_conversations WHERE conversation_id=?", id)!.session_key as string;
    this.run(`INSERT INTO ledger_session_conversations(session_key,conversation_id,role,last_inbound_at) VALUES(?,?,?,?)
      ON CONFLICT(session_key,conversation_id) DO UPDATE SET last_inbound_at=excluded.last_inbound_at`, sessionKey, id, role, input.at);
    return id;
  }
  conversationSession(conversationId: string): string | undefined {
    return this.row("SELECT session_key FROM ledger_conversations WHERE conversation_id=?", conversationId)?.session_key as string | undefined;
  }

  /** Append with a gapless seq. An idempotency key returns the stored event instead of a second copy. */
  append(sessionKey: string, input: EventInput): { event: LedgerEvent; duplicate: boolean } {
    if (input.idempotencyKey) {
      const prior = this.row("SELECT * FROM ledger_events WHERE session_key=? AND idempotency_key=?", sessionKey, input.idempotencyKey);
      if (prior) return { event: eventRow(prior), duplicate: true };
    }
    const session = this.session(sessionKey);
    if (!session) throw new Error("ledger_session_not_found");
    const at = input.createdAt ?? Date.now(), seq = session.lastSeq + 1, eventId = `ev_${ulid(at)}`;
    this.run(`INSERT INTO ledger_events(session_key,seq,event_id,window,kind,role,sender_type,sender_id,conversation_id,turn_id,
      ref_event_id,idempotency_key,created_at,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, sessionKey, seq, eventId, session.window,
      input.kind, input.role, input.senderType, input.senderId, input.conversationId ?? null, input.turnId ?? null,
      input.refEventId ?? null, input.idempotencyKey ?? null, at, bounded(input.body));
    this.run("UPDATE ledger_sessions SET last_seq=?, updated_at=MAX(updated_at,?) WHERE session_key=?", seq, at, sessionKey);
    this.touch(sessionKey);
    return { event: this.event(eventId)!, duplicate: false };
  }
  event(eventId: string): LedgerEvent | undefined {
    const row = this.row("SELECT * FROM ledger_events WHERE event_id=?", eventId);
    return row ? eventRow(row) : undefined;
  }
  eventByKey(sessionKey: string, idempotencyKey: string): LedgerEvent | undefined {
    const row = this.row("SELECT * FROM ledger_events WHERE session_key=? AND idempotency_key=?", sessionKey, idempotencyKey);
    return row ? eventRow(row) : undefined;
  }
  /** Ascending seq. `after`/`before` are exclusive bounds; `latest` returns the newest `limit` events. */
  events(sessionKey: string, options: { after?: number; before?: number; limit?: number; latest?: boolean } = {}): LedgerEvent[] {
    const limit = options.limit ?? 200;
    if (options.latest || options.before !== undefined) {
      return this.rows(`SELECT * FROM ledger_events WHERE session_key=? AND seq<? ORDER BY seq DESC LIMIT ?`,
        sessionKey, options.before ?? Number.MAX_SAFE_INTEGER, limit).map(eventRow).reverse();
    }
    return this.rows("SELECT * FROM ledger_events WHERE session_key=? AND seq>? ORDER BY seq LIMIT ?", sessionKey, options.after ?? 0, limit).map(eventRow);
  }
  /** `message` and `card` events after `afterSeq` that the reader did not send (ADR 8.2 unread rule). */
  unread(sessionKey: string, afterSeq: number, personId: string): number {
    return Number(this.row(`SELECT COUNT(*) AS n FROM ledger_events WHERE session_key=? AND seq>? AND kind IN ('message','card')
      AND NOT (sender_type='person' AND sender_id=?)`, sessionKey, afterSeq, personId)!.n);
  }
  /** The newest event worth a chat-list preview. */
  latestVisible(sessionKey: string): LedgerEvent | undefined {
    const row = this.row(`SELECT * FROM ledger_events WHERE session_key=? AND kind IN ('message','notice','card') ORDER BY seq DESC LIMIT 1`, sessionKey);
    return row ? eventRow(row) : undefined;
  }
  turnEvents(turnId: string): LedgerEvent[] { return this.rows("SELECT * FROM ledger_events WHERE turn_id=? ORDER BY session_key, seq", turnId).map(eventRow); }
  /** Patch an event that has not changed meaning (backfill linking only). */
  annotate(eventId: string, patch: { turnId?: string; body?: Record<string, unknown> }): void {
    const event = this.event(eventId); if (!event) return;
    this.run("UPDATE ledger_events SET turn_id=COALESCE(?,turn_id), body=? WHERE event_id=?", patch.turnId ?? null,
      bounded({ ...event.body, ...patch.body }), eventId);
  }
  /** Re-sequence a session by time after history was rewritten (late backfill) and bump its generation. */
  resequence(sessionKey: string): void {
    const rows = this.rows("SELECT event_id FROM ledger_events WHERE session_key=? ORDER BY created_at, seq", sessionKey);
    this.run("UPDATE ledger_events SET seq=-seq WHERE session_key=?", sessionKey);
    rows.forEach((row, index) => this.run("UPDATE ledger_events SET seq=? WHERE event_id=?", index + 1, row.event_id!));
    this.run("UPDATE ledger_sessions SET last_seq=?, generation=generation+1, published_seq=0 WHERE session_key=?", rows.length, sessionKey);
    this.touch(sessionKey);
  }

  /** Durable ingress claim. Same hash: the stored claim (duplicate). Different hash: rejected, as the legacy inbox does. */
  claim(input: { connectionId: string; externalId: string; inputId: string; hash: string; at?: number }): { claim: Claim; duplicate: boolean } {
    const prior = this.claimFor(input.connectionId, input.externalId);
    if (prior) {
      if (prior.hash !== input.hash) throw new Error("channel_event_id_reused_with_different_payload");
      return { claim: prior, duplicate: true };
    }
    this.run(`INSERT INTO ledger_ingress(connection_id,external_id,input_id,hash,state,received_at) VALUES(?,?,?,?,'accepted',?)`,
      input.connectionId, input.externalId, input.inputId, input.hash, input.at ?? Date.now());
    return { claim: this.claimFor(input.connectionId, input.externalId)!, duplicate: false };
  }
  claimFor(connectionId: string, externalId: string): Claim | undefined {
    const row = this.row("SELECT * FROM ledger_ingress WHERE connection_id=? AND external_id=?", connectionId, externalId);
    return row ? claimRow(row) : undefined;
  }
  claimByInput(inputId: string): Claim | undefined {
    const row = this.row("SELECT * FROM ledger_ingress WHERE input_id=?", inputId);
    return row ? claimRow(row) : undefined;
  }
  settleClaim(connectionId: string, externalId: string, state: "accepted" | "ignored", fields: { reason?: string; eventId?: string; conversationId?: string } = {}): void {
    this.run("UPDATE ledger_ingress SET state=?, reason=?, event_id=?, conversation_id=? WHERE connection_id=? AND external_id=? AND state<>'tombstone'",
      state, fields.reason ?? null, fields.eventId ?? null, fields.conversationId ?? null, connectionId, externalId);
  }
  /** Keep only the hash so redelivery is still recognised; the row expires after 30 days. */
  tombstone(connectionId: string, externalId: string, at = Date.now()): void {
    this.run("UPDATE ledger_ingress SET state='tombstone', event_id=NULL, expires_at=? WHERE connection_id=? AND external_id=?",
      at + TOMBSTONE_MS, connectionId, externalId);
  }
  pruneTombstones(at = Date.now()): number {
    return Number(this.run("DELETE FROM ledger_ingress WHERE state='tombstone' AND expires_at<=?", at).changes);
  }

  indexPlatform(connectionId: string, platformIds: string[], eventId: string): void {
    platformIds.filter(Boolean).forEach((id, part) =>
      this.run("INSERT OR IGNORE INTO ledger_platform_messages(connection_id,platform_message_id,event_id,part) VALUES(?,?,?,?)", connectionId, id, eventId, part));
  }
  platformEvent(connectionId: string, platformId: string): string | undefined {
    return this.row("SELECT event_id FROM ledger_platform_messages WHERE connection_id=? AND platform_message_id=?", connectionId, platformId)?.event_id as string | undefined;
  }

  queueInput(inputId: string, sessionKey: string, eventId: string, at = Date.now(), fields: { retryOf?: string } = {}): void {
    this.run(`INSERT OR IGNORE INTO ledger_pending_inputs(input_id,session_key,event_id,state,retry_of,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?)`,
      inputId, sessionKey, eventId, fields.retryOf ?? null, at, at);
  }
  updateInput(inputId: string, state: InputState, fields: { turnId?: string; reason?: string } = {}, at = Date.now()): void {
    this.run("UPDATE ledger_pending_inputs SET state=?, turn_id=COALESCE(?,turn_id), reason=COALESCE(?,reason), updated_at=? WHERE input_id=?",
      state, fields.turnId ?? null, fields.reason ?? null, at, inputId);
  }
  input(inputId: string) { return this.row("SELECT * FROM ledger_pending_inputs WHERE input_id=?", inputId); }
  turnInputs(turnId: string): string[] {
    return this.rows("SELECT event_id FROM ledger_pending_inputs WHERE turn_id=? ORDER BY created_at", turnId).map((row) => row.event_id as string);
  }

  ensureTurn(input: { turnId: string; sessionKey: string; admission: Admission; originConversationId?: string | null; originEventId?: string | null;
    replyRoute?: unknown; state?: TurnState; at?: number }): Turn {
    const session = this.session(input.sessionKey); if (!session) throw new Error("ledger_session_not_found");
    this.run(`INSERT OR IGNORE INTO ledger_turns(turn_id,session_key,window,admission,origin_conversation_id,origin_event_id,reply_route,state,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, input.turnId, input.sessionKey, session.window, input.admission, input.originConversationId ?? null,
      input.originEventId ?? null, input.replyRoute == null ? null : JSON.stringify(input.replyRoute), input.state ?? "queued", input.at ?? Date.now());
    return this.turn(input.turnId)!;
  }
  turn(turnId: string): Turn | undefined {
    const row = this.row("SELECT * FROM ledger_turns WHERE turn_id=?", turnId);
    return row ? turnRow(row) : undefined;
  }
  /** Backfill only: attach an imported final message without appending turn events out of time order. */
  linkFinal(turnId: string, eventId: string): void { this.run("UPDATE ledger_turns SET final_event_id=? WHERE turn_id=?", eventId, turnId); }
  turns(sessionKey: string): Turn[] { return this.rows("SELECT * FROM ledger_turns WHERE session_key=? ORDER BY created_at", sessionKey).map(turnRow); }
  /**
   * Move a turn and append a `turn` event once per state. A terminal turn does not move back.
   * Returns the event when the state changed.
   */
  turnState(turnId: string, state: TurnState, fields: { error?: string; finalEventId?: string; agentId?: string; at?: number } = {}): LedgerEvent | undefined {
    const turn = this.turn(turnId); if (!turn) return undefined;
    if (terminalTurn.has(turn.state) && !(turn.state === state)) return undefined;
    const at = fields.at ?? Date.now();
    this.run(`UPDATE ledger_turns SET state=?, error=COALESCE(?,error), final_event_id=COALESCE(?,final_event_id),
      started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,
      finished_at=CASE WHEN ? IN ('completed','failed','canceled') THEN COALESCE(finished_at,?) ELSE finished_at END WHERE turn_id=?`,
      state, fields.error ?? null, fields.finalEventId ?? null, state, at, state, at, turnId);
    if (turn.state === state && state !== "queued") return undefined;
    return this.append(turn.sessionKey, { kind: "turn", role: "system", senderType: "system", senderId: "router", turnId,
      idempotencyKey: `turn:${turnId}:${state}`, createdAt: at,
      body: { agentId: fields.agentId ?? "", state, inputEventIds: this.turnInputs(turnId), ...(fields.error ? { error: fields.error } : {}) } }).event;
  }
  activeTurns(sessionKey: string): number {
    return Number(this.row("SELECT COUNT(*) AS n FROM ledger_turns WHERE session_key=? AND state IN ('queued','running','waiting')", sessionKey)!.n);
  }

  createDelivery(input: { deliveryId: string; eventId: string | null; conversationId: string; connectionId: string; route: unknown;
    purpose: DeliveryPurpose; status?: DeliveryStatus; content?: unknown; at?: number; platformMessageId?: string }): void {
    const at = input.at ?? Date.now();
    this.run(`INSERT OR IGNORE INTO ledger_deliveries(delivery_id,event_id,conversation_id,connection_id,route,purpose,status,content,
      platform_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, input.deliveryId, input.eventId, input.conversationId,
      input.connectionId, JSON.stringify(input.route), input.purpose, input.status ?? "queued",
      input.content === undefined ? null : JSON.stringify(input.content), input.platformMessageId ?? null, at, at);
  }
  delivery(deliveryId: string): Delivery | undefined {
    const row = this.row("SELECT * FROM ledger_deliveries WHERE delivery_id=?", deliveryId);
    return row ? deliveryRow(row) : undefined;
  }
  deliveriesFor(eventId: string): Delivery[] {
    return this.rows("SELECT * FROM ledger_deliveries WHERE event_id=? ORDER BY created_at", eventId).map(deliveryRow);
  }
  /** Track a delivery; reaching sent/unknown/rejected appends a `delivery` event and indexes platform ids. */
  deliveryStatus(deliveryId: string, status: DeliveryStatus, fields: { attempts?: number; nextAt?: number; platformMessageId?: string; error?: string } = {}, at = Date.now()): void {
    const prior = this.delivery(deliveryId); if (!prior) return;
    this.run(`UPDATE ledger_deliveries SET status=?, attempts=COALESCE(?,attempts), next_at=COALESCE(?,next_at),
      platform_message_id=COALESCE(?,platform_message_id), error=?, updated_at=? WHERE delivery_id=?`, status, fields.attempts ?? null,
      fields.nextAt ?? null, fields.platformMessageId ?? null, fields.error ?? null, at, deliveryId);
    if (!prior.eventId || prior.status === status || !["sent", "unknown", "rejected", "suppressed"].includes(status)) return;
    const target = this.event(prior.eventId); if (!target) return;
    if (fields.platformMessageId) this.indexPlatform(prior.connectionId, fields.platformMessageId.split(","), prior.eventId);
    const channel = prior.route && typeof prior.route === "object" ? (prior.route as { channel?: string }).channel : undefined;
    this.append(target.sessionKey, { kind: "delivery", role: "system", senderType: "system", senderId: "router", refEventId: prior.eventId,
      turnId: target.turnId, idempotencyKey: `delivery:${deliveryId}:${status}`, createdAt: at,
      body: { targetEventId: prior.eventId, delivery: { deliveryId, connectionId: prior.connectionId, ...(channel ? { channel } : {}), status,
        ...(fields.error ? { error: fields.error } : {}) } } });
  }

  addCard(input: { cardId: string; callId: string; runId: string; claimId: string; turnId: string; sessionKey: string; eventId: string;
    kind: "question" | "approval" | "connector_approval" | "sensitive"; deadlineAt?: number | null; at?: number }): void {
    this.run(`INSERT OR IGNORE INTO ledger_cards(card_id,call_id,run_id,claim_id,turn_id,session_key,event_id,kind,status,deadline_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`, input.cardId, input.callId, input.runId, input.claimId, input.turnId, input.sessionKey,
      input.eventId, input.kind, input.deadlineAt ?? null, input.at ?? Date.now());
  }
  addCardToken(token: string, cardId: string, choiceId: string, result: unknown): void {
    this.run("INSERT OR IGNORE INTO ledger_card_tokens(token,card_id,choice_id,result) VALUES(?,?,?,?)", token, cardId, choiceId, JSON.stringify(result ?? null));
  }
  cardToken(token: string) { return this.row("SELECT * FROM ledger_card_tokens WHERE token=?", token); }
  card(cardId: string) { return this.row("SELECT * FROM ledger_cards WHERE card_id=?", cardId); }
  cardsForTurn(turnId: string): string[] { return this.rows("SELECT card_id FROM ledger_cards WHERE turn_id=?", turnId).map((row) => row.card_id as string); }
  pendingCards(sessionKey: string): number {
    return Number(this.row("SELECT COUNT(*) AS n FROM ledger_cards WHERE session_key=? AND status='pending'", sessionKey)!.n);
  }
  /** Close a pending card and append its `card.update` event. */
  cardStatus(cardId: string, status: "answered" | "approved" | "rejected" | "expired" | "canceled", fields: { answeredBy?: string; summary?: string } = {}, at = Date.now()): void {
    const card = this.card(cardId); if (!card || card.status !== "pending") return;
    this.run("UPDATE ledger_cards SET status=?, answered_by=?, updated_at=? WHERE card_id=?", status, fields.answeredBy ?? null, at, cardId);
    this.append(card.session_key as string, { kind: "card.update", role: "system", senderType: "system", senderId: "router",
      refEventId: card.event_id as string, turnId: card.turn_id as string, idempotencyKey: `card:${cardId}:${status}`, createdAt: at,
      body: { cardId, status, ...(fields.summary ? { summary: fields.summary } : {}) } });
  }

  addAttachment(input: { eventId: string | null; name: string; contentType: string; size?: number | null; locator: unknown; at?: number }): string {
    const id = `at_${ulid(input.at)}`;
    this.run(`INSERT INTO ledger_attachments(attachment_id,event_id,name,content_type,size,locator,created_at) VALUES(?,?,?,?,?,?,?)`,
      id, input.eventId, input.name, input.contentType, input.size ?? null, JSON.stringify(input.locator), input.at ?? Date.now());
    return id;
  }
  attachEvent(attachmentIds: string[], eventId: string): void {
    for (const id of attachmentIds) this.run("UPDATE ledger_attachments SET event_id=? WHERE attachment_id=?", eventId, id);
  }
  counts() {
    const count = (table: string) => Number(this.row(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
    return { sessions: count("ledger_sessions"), events: count("ledger_events"), conversations: count("ledger_conversations"),
      claims: count("ledger_ingress"), turns: count("ledger_turns"), deliveries: count("ledger_deliveries"), cards: count("ledger_cards") };
  }
}
function bounded(body: Record<string, unknown>): string {
  let text = JSON.stringify(body);
  if (Buffer.byteLength(text) <= MAX_BODY) return text;
  // Larger text becomes an attachment once the blob store exists (phase 4); until then it is cut and marked.
  const cut = typeof body.text === "string" ? Buffer.from(body.text).subarray(0, MAX_BODY - 16_384).toString("utf8") : "";
  text = JSON.stringify({ ...body, text: cut, truncated: true });
  if (Buffer.byteLength(text) > MAX_BODY) text = JSON.stringify({ text: cut, truncated: true });
  return text;
}
const nullable = (value: SQLInputValue | undefined) => value === null || value === undefined ? null : String(value);
function sessionRow(row: Row): LedgerSession {
  return { sessionKey: row.session_key as string, kind: row.kind as SessionKind, label: row.label as string, roomId: nullable(row.room_id),
    window: Number(row.window), lastSeq: Number(row.last_seq), generation: Number(row.generation), publishedSeq: Number(row.published_seq),
    title: nullable(row.title), archived: Boolean(row.archived), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function eventRow(row: Row): LedgerEvent {
  return { sessionKey: row.session_key as string, seq: Number(row.seq), eventId: row.event_id as string, window: Number(row.window),
    kind: row.kind as string, role: row.role as LedgerEvent["role"], senderType: row.sender_type as LedgerEvent["senderType"],
    senderId: row.sender_id as string, conversationId: nullable(row.conversation_id), turnId: nullable(row.turn_id),
    refEventId: nullable(row.ref_event_id), idempotencyKey: nullable(row.idempotency_key), createdAt: Number(row.created_at),
    body: JSON.parse(row.body as string) as Record<string, unknown> };
}
function claimRow(row: Row): Claim {
  return { connectionId: row.connection_id as string, externalId: row.external_id as string, inputId: row.input_id as string,
    hash: row.hash as string, state: row.state as Claim["state"], reason: nullable(row.reason), eventId: nullable(row.event_id),
    conversationId: nullable(row.conversation_id), receivedAt: Number(row.received_at), expiresAt: row.expires_at === null ? null : Number(row.expires_at) };
}
function turnRow(row: Row): Turn {
  return { turnId: row.turn_id as string, sessionKey: row.session_key as string, window: Number(row.window), admission: row.admission as Admission,
    originConversationId: nullable(row.origin_conversation_id), originEventId: nullable(row.origin_event_id),
    replyRoute: row.reply_route === null ? null : JSON.parse(row.reply_route as string), state: row.state as TurnState,
    finalEventId: nullable(row.final_event_id), error: nullable(row.error), createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at) };
}
function deliveryRow(row: Row): Delivery {
  return { deliveryId: row.delivery_id as string, eventId: nullable(row.event_id), conversationId: row.conversation_id as string,
    connectionId: row.connection_id as string, route: JSON.parse(row.route as string), purpose: row.purpose as DeliveryPurpose,
    status: row.status as DeliveryStatus, attempts: Number(row.attempts), nextAt: Number(row.next_at),
    platformMessageId: nullable(row.platform_message_id), error: nullable(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
