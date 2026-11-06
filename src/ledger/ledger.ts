import { randomBytes } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { DurableStore } from "../communication/store.js";
import { digest, key } from "../execution/protocol.js";
import { AGENT_LEDGER_V1, AGENT_LEDGER_V2, AGENT_LEDGER_V3, AGENT_LEDGER_V4 } from "./schema.js";

export type SessionKind = "owner_main" | "peer" | "group" | "room" | "schedule" | "work" | "delegation";
export type Admission = "owner" | "peer" | "group" | "schedule" | "work" | "delegation";
export type TurnState = "queued" | "running" | "waiting" | "completed" | "failed" | "canceled" | "unknown";
export type DeliveryStatus = "created" | "queued" | "sending" | "sent" | "suppressed" | "rejected" | "unknown" | "replied";
export type DeliveryPurpose = "reply" | "notice" | "card" | "content" | "activity" | "mirror";
export type CardKind = "question" | "approval" | "connector_approval" | "sensitive";
export type CardStatus = "pending" | "answered" | "approved" | "rejected" | "expired" | "canceled";
/** `router` marks Router-native cards (the unknown-turn retry card, ADR 6.2.4); the others come from the callId prefix. */
export type CardSource = "host" | "mau-approval" | "mau-handoff" | "router";
export type CardSurface = "web" | "channel" | "run-api" | "host";
export interface CardRecord {
  cardId: string; callId: string; runId: string; claimId: string; turnId: string; sessionKey: string; eventId: string; kind: CardKind;
  status: CardStatus; source: CardSource; deadlineAt: number | null; answeredBy: string | null; answerKey: string | null; result: unknown;
  surface: CardSurface | null; summary: string | null; updatedAt: number;
}
export const RETRY_CALL_PREFIX = "router-retry:";
export const cardSource = (callId: string): CardSource => callId.startsWith("mau-approval:") ? "mau-approval" : callId.startsWith("mau-handoff:") ? "mau-handoff" :
  callId.startsWith(RETRY_CALL_PREFIX) ? "router" : "host";
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
    if (!ledger) { store.migrate(1, AGENT_LEDGER_V1); store.migrate(2, AGENT_LEDGER_V2); store.migrate(3, AGENT_LEDGER_V3); store.migrate(4, AGENT_LEDGER_V4); ledger = new AgentLedger(store); this.ledgers.set(store, ledger); }
    return ledger;
  }
  static attached(store: DurableStore): AgentLedger | undefined { return this.ledgers.get(store); }
  lastError = "";
  /**
   * Phase 3 (`AGENT_LEDGER_SEND`): the dispatcher and flush read the ledger, and ledger writes on the channel path
   * are no longer shadow writes. A failed ledger write then fails the receipt or transition it belongs to.
   */
  authoritative = false;
  /** Phase 4 features (`AGENT_LEDGER_CARDS`, `AGENT_LEDGER_CONTROL`); both need `authoritative`. */
  features = { cards: false, reset: false };
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
   * in a savepoint, so a ledger error rolls back only the ledger rows. When SQLite itself ended the outer transaction
   * (SQLITE_IOERR, SQLITE_FULL), the legacy writes are gone as well: the error propagates instead of being swallowed.
   */
  shadow<T>(work: () => T): T | undefined {
    const outer = this.db.isTransaction;
    try {
      if (!outer) return this.store.transaction(work);
      this.db.exec("SAVEPOINT ledger_shadow");
      try { const result = work(); this.db.exec("RELEASE ledger_shadow"); return result; }
      catch (error) { if (this.db.isTransaction) { this.db.exec("ROLLBACK TO ledger_shadow"); this.db.exec("RELEASE ledger_shadow"); } throw error; }
    } catch (error) {
      if (outer && !this.db.isTransaction) throw error;
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
    // Late events of a turn keep the turn's window after a reset (ADR 16.3).
    const window = input.turnId ? Number(this.row("SELECT window FROM ledger_turns WHERE turn_id=? AND session_key=?", input.turnId, sessionKey)?.window ?? session.window) : session.window;
    this.run(`INSERT INTO ledger_events(session_key,seq,event_id,window,kind,role,sender_type,sender_id,conversation_id,turn_id,
      ref_event_id,idempotency_key,created_at,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, sessionKey, seq, eventId, window,
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
  /** Events that refer to a target (redactions, edits, reactions), oldest first. */
  references(eventId: string, kind: string): LedgerEvent[] {
    return this.rows("SELECT * FROM ledger_events WHERE ref_event_id=? AND kind=? ORDER BY seq", eventId, kind).map(eventRow);
  }
  turnEvents(turnId: string): LedgerEvent[] { return this.rows("SELECT * FROM ledger_events WHERE turn_id=? ORDER BY session_key, seq", turnId).map(eventRow); }
  /** Patch an event that has not changed meaning (backfill linking only). */
  annotate(eventId: string, patch: { turnId?: string; body?: Record<string, unknown> }): void {
    const event = this.event(eventId); if (!event) return;
    this.run("UPDATE ledger_events SET turn_id=COALESCE(?,turn_id), body=? WHERE event_id=?", patch.turnId ?? null,
      bounded({ ...event.body, ...patch.body }), eventId);
  }
  /** Redaction removes the content of the target and keeps its place (seq, sender, channel). */
  redactBody(eventId: string, at = Date.now()): void {
    const event = this.event(eventId); if (!event) return;
    this.run("UPDATE ledger_events SET body=? WHERE event_id=?", JSON.stringify({ text: "", redacted: true, redactedAt: new Date(at).toISOString(),
      ...(typeof event.body.channel === "string" ? { channel: event.body.channel } : {}) }), eventId);
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
  /** A retry (ADR 6.2.4) points at the input whose outcome stayed unknown. */
  markRetry(inputId: string, retryOf: string): void { this.run("UPDATE ledger_pending_inputs SET retry_of=? WHERE input_id=?", retryOf, inputId); }
  input(inputId: string) { return this.row("SELECT * FROM ledger_pending_inputs WHERE input_id=?", inputId); }
  /** Dispatch order (ADR 6.2): accepted inputs not yet consumed, oldest first, in receipt order within one millisecond. */
  dueInputs(limit = 500): string[] {
    return this.rows("SELECT input_id FROM ledger_pending_inputs WHERE state IN ('queued','starting') ORDER BY created_at, rowid LIMIT ?", limit)
      .map((row) => row.input_id as string);
  }
  /** The newest input of a turn (a resumed turn has several). */
  inputForTurn(turnId: string): string | undefined {
    return this.row("SELECT input_id FROM ledger_pending_inputs WHERE turn_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", turnId)?.input_id as string | undefined;
  }
  inputForEvent(eventId: string) { return this.row("SELECT * FROM ledger_pending_inputs WHERE event_id=?", eventId); }
  /** Inputs of one session that became turns, newest first (resume lookup). */
  startedInputs(sessionKey: string, limit = 50): Array<{ inputId: string; turnId: string }> {
    return this.rows(`SELECT input_id, turn_id FROM ledger_pending_inputs WHERE session_key=? AND turn_id IS NOT NULL
      ORDER BY created_at DESC, rowid DESC LIMIT ?`, sessionKey, limit).map((row) => ({ inputId: row.input_id as string, turnId: row.turn_id as string }));
  }
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
    // Unknown work is never replayed (ADR 6.2.4): its inputs leave the started set until the outcome is known.
    if (state === "unknown") this.run("UPDATE ledger_pending_inputs SET state='unknown', updated_at=? WHERE turn_id=? AND state='started'", at, turnId);
    else if (turn.state === "unknown") this.run("UPDATE ledger_pending_inputs SET state='started', updated_at=? WHERE turn_id=? AND state='unknown'", at, turnId);
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
  /** Flush order (ADR 6.4): queued deliveries that are due. */
  dueDeliveries(now = Date.now(), limit = 500): string[] {
    return this.rows("SELECT delivery_id FROM ledger_deliveries WHERE status='queued' AND next_at<=? ORDER BY next_at, created_at, rowid LIMIT ?", now, limit)
      .map((row) => row.delivery_id as string);
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
    kind: CardKind; source?: CardSource; deadlineAt?: number | null; at?: number }): void {
    this.run(`INSERT OR IGNORE INTO ledger_cards(card_id,call_id,run_id,claim_id,turn_id,session_key,event_id,kind,status,deadline_at,updated_at,source)
      VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?)`, input.cardId, input.callId, input.runId, input.claimId, input.turnId, input.sessionKey,
      input.eventId, input.kind, input.deadlineAt ?? null, input.at ?? Date.now(), input.source ?? cardSource(input.callId));
  }
  addCardToken(token: string, cardId: string, choiceId: string, result: unknown): void {
    this.run("INSERT OR IGNORE INTO ledger_card_tokens(token,card_id,choice_id,result) VALUES(?,?,?,?)", token, cardId, choiceId, JSON.stringify(result ?? null));
  }
  cardToken(token: string) { return this.row("SELECT * FROM ledger_card_tokens WHERE token=?", token); }
  cardChoice(cardId: string, choiceId: string) { return this.row("SELECT * FROM ledger_card_tokens WHERE card_id=? AND choice_id=?", cardId, choiceId); }
  card(cardId: string) { return this.row("SELECT * FROM ledger_cards WHERE card_id=?", cardId); }
  cardRecord(cardId: string): CardRecord | undefined { const row = this.card(cardId); return row ? cardRow(row) : undefined; }
  cardByCall(runId: string, callId: string): CardRecord | undefined {
    const row = this.row("SELECT * FROM ledger_cards WHERE run_id=? AND call_id=?", runId, callId); return row ? cardRow(row) : undefined;
  }
  /** Open cards of a run (call observation) or of a turn (Router-native cards). */
  openCards(filter: { runId?: string; turnId?: string; sessionKey?: string }): CardRecord[] {
    const [column, value] = filter.runId !== undefined ? ["run_id", filter.runId] : filter.turnId !== undefined ? ["turn_id", filter.turnId] : ["session_key", filter.sessionKey ?? ""];
    return this.rows(`SELECT * FROM ledger_cards WHERE ${column}=? AND status='pending' ORDER BY updated_at`, value).map(cardRow);
  }
  /** Answers that were planned but not yet confirmed by the Host (crash or Host failure between plan and resolve). */
  plannedCards(limit = 50): CardRecord[] {
    return this.rows("SELECT * FROM ledger_cards WHERE status='pending' AND answer_key IS NOT NULL ORDER BY updated_at LIMIT ?", limit).map(cardRow);
  }
  /**
   * Save-before-resolve (ADR 16.1 step 5): record the answer on a pending card before the Host call. The first planned
   * answer wins: `taken` means another key is already planned, `closed` that the card is no longer pending.
   */
  planAnswer(cardId: string, answer: { key: string; result: unknown; by: string | null; surface: CardSurface; summary?: string }, at = Date.now()): "planned" | "same" | "taken" | "closed" {
    const card = this.cardRecord(cardId);
    if (!card || card.status !== "pending") return "closed";
    if (card.answerKey) return card.answerKey === answer.key ? "same" : "taken";
    this.run(`UPDATE ledger_cards SET answer_key=?, result=?, answered_by=?, answer_surface=?, answer_summary=?, updated_at=? WHERE card_id=? AND answer_key IS NULL`,
      answer.key, JSON.stringify(answer.result ?? null), answer.by, answer.surface, answer.summary ?? null, at, cardId);
    return "planned";
  }
  /** Drop a planned answer the Host refused, so the card can be answered again. */
  unplanAnswer(cardId: string, key: string): void {
    this.run("UPDATE ledger_cards SET answer_key=NULL, result=NULL, answered_by=NULL, answer_surface=NULL, answer_summary=NULL WHERE card_id=? AND answer_key=? AND status='pending'", cardId, key);
  }
  cardsForTurn(turnId: string): string[] { return this.rows("SELECT card_id FROM ledger_cards WHERE turn_id=?", turnId).map((row) => row.card_id as string); }
  pendingCards(sessionKey: string): number {
    return Number(this.row("SELECT COUNT(*) AS n FROM ledger_cards WHERE session_key=? AND status='pending'", sessionKey)!.n);
  }
  /** Close a pending card and append its `card.update` event. Returns false when the card was already closed. */
  cardStatus(cardId: string, status: Exclude<CardStatus, "pending">, fields: { answeredBy?: string | null | undefined; summary?: string | null | undefined; surface?: CardSurface } = {}, at = Date.now()): boolean {
    const card = this.card(cardId); if (!card || card.status !== "pending") return false;
    const answeredBy = fields.answeredBy ?? (card.answered_by as string | null) ?? null, summary = fields.summary ?? (card.answer_summary as string | null) ?? null;
    this.run("UPDATE ledger_cards SET status=?, answered_by=?, answer_surface=COALESCE(?,answer_surface), answer_summary=?, updated_at=? WHERE card_id=?",
      status, answeredBy, fields.surface ?? null, summary, at, cardId);
    this.append(card.session_key as string, { kind: "card.update", role: "system", senderType: "system", senderId: "router",
      refEventId: card.event_id as string, turnId: card.turn_id as string, idempotencyKey: `card:${cardId}:${status}`, createdAt: at,
      body: { cardId, status, ...(answeredBy && ["answered", "approved", "rejected"].includes(status) ? { answeredBy } : {}), ...(summary ? { summary } : {}) } });
    return true;
  }

  /** The execution context of the session's current window (window 1 is the session key itself). */
  contextFor(sessionKey: string): string {
    return (this.row(`SELECT w.context_id FROM ledger_sessions s JOIN ledger_session_windows w ON w.session_key=s.session_key AND w.window=s.window
      WHERE s.session_key=?`, sessionKey)?.context_id as string | undefined) ?? sessionKey;
  }
  /** Turns that still run in the session, and inputs not yet taken by the dispatcher (reset busy check, ADR 16.3). */
  busy(sessionKey: string): { activeTurns: string[]; queuedInputs: string[] } {
    return { activeTurns: this.rows("SELECT turn_id FROM ledger_turns WHERE session_key=? AND state IN ('queued','running','waiting') ORDER BY created_at", sessionKey).map((row) => row.turn_id as string),
      queuedInputs: this.rows("SELECT input_id FROM ledger_pending_inputs WHERE session_key=? AND state='queued' ORDER BY created_at", sessionKey).map((row) => row.input_id as string) };
  }
  /**
   * Reset (ADR 6.8/16.3): close the window, open `<key>.w<n+1>`, and append the `window` event. Seq continues, so the
   * chat stays one history with a divider. The next turn starts a new Host session through the new context id.
   */
  reset(sessionKey: string, reason: "reset" = "reset", at = Date.now()): { window: number; event: LedgerEvent } {
    const session = this.session(sessionKey); if (!session) throw new Error("ledger_session_not_found");
    const next = session.window + 1;
    this.run("UPDATE ledger_session_windows SET closed_at=?, reason=? WHERE session_key=? AND window=? AND closed_at IS NULL", at, reason, sessionKey, session.window);
    this.run("INSERT INTO ledger_session_windows(session_key,window,context_id,opened_at) VALUES(?,?,?,?)", sessionKey, next, `${sessionKey}.w${next}`, at);
    this.run("UPDATE ledger_sessions SET window=?, updated_at=MAX(updated_at,?) WHERE session_key=?", next, at, sessionKey);
    const event = this.append(sessionKey, { kind: "window", role: "system", senderType: "system", senderId: "router", createdAt: at,
      idempotencyKey: `window:${next}`, body: { window: next, reason } }).event;
    return { window: next, event };
  }
  /**
   * Purge (ADR 16.4): delete the session's transcript and everything bound to its events, tombstone every ingress claim
   * of its conversations (a redelivered channel message does not come back), bump the generation and open a new window.
   * Execution records (runs, archives, Host sessions) are kept.
   */
  purge(sessionKey: string, at = Date.now()): { generation: number; purgedEvents: number; window: number; inputIds: string[]; attachmentIds: string[] } {
    const session = this.session(sessionKey); if (!session) throw new Error("ledger_session_not_found");
    const events = `SELECT event_id FROM ledger_events WHERE session_key=?`;
    const purgedEvents = Number(this.row("SELECT COUNT(*) AS n FROM ledger_events WHERE session_key=?", sessionKey)!.n);
    this.run(`DELETE FROM ledger_platform_messages WHERE event_id IN (${events})`, sessionKey);
    // The caller releases their blob references (ADR 16.4) after the transaction.
    const attachmentIds = this.rows(`SELECT attachment_id FROM ledger_attachments WHERE event_id IN (${events})`, sessionKey).map((row) => row.attachment_id as string);
    this.run(`DELETE FROM ledger_attachments WHERE event_id IN (${events})`, sessionKey);
    this.run(`DELETE FROM ledger_deliveries WHERE event_id IN (${events}) AND status<>'queued' AND status<>'sending'`, sessionKey);
    this.run(`UPDATE ledger_deliveries SET event_id=NULL WHERE event_id IN (${events})`, sessionKey);
    this.run("DELETE FROM ledger_card_tokens WHERE card_id IN (SELECT card_id FROM ledger_cards WHERE session_key=?)", sessionKey);
    this.run("DELETE FROM ledger_cards WHERE session_key=?", sessionKey);
    this.run("DELETE FROM ledger_events WHERE session_key=?", sessionKey);
    this.run(`UPDATE ledger_ingress SET state='tombstone', event_id=NULL, reason='purged', expires_at=? WHERE conversation_id IN
      (SELECT conversation_id FROM ledger_conversations WHERE session_key=?)`, at + TOMBSTONE_MS, sessionKey);
    const inputIds = this.rows("SELECT input_id FROM ledger_pending_inputs WHERE session_key=?", sessionKey).map((row) => row.input_id as string);
    this.run("UPDATE ledger_pending_inputs SET state='dropped', reason='purged', updated_at=? WHERE session_key=? AND state='queued'", at, sessionKey);
    this.run("UPDATE ledger_sessions SET last_seq=0, published_seq=0, generation=generation+1, updated_at=MAX(updated_at,?) WHERE session_key=?", at, sessionKey);
    const { window } = this.reset(sessionKey, "reset", at);
    return { generation: this.session(sessionKey)!.generation, purgedEvents, window, inputIds, attachmentIds };
  }

  addAttachment(input: { eventId: string | null; name: string; contentType: string; size?: number | null; locator: unknown; at?: number }): string {
    const id = `at_${ulid(input.at)}`;
    this.run(`INSERT INTO ledger_attachments(attachment_id,event_id,name,content_type,size,locator,created_at) VALUES(?,?,?,?,?,?,?)`,
      id, input.eventId, input.name, input.contentType, input.size ?? null, JSON.stringify(input.locator), input.at ?? Date.now());
    return id;
  }
  /** Redaction (ADR 16.4): the event's attachment rows lose their `event_id`; returns their ids. */
  detachAttachments(eventId: string): string[] {
    const ids = this.rows("SELECT attachment_id FROM ledger_attachments WHERE event_id=?", eventId).map((row) => row.attachment_id as string);
    if (ids.length) this.run("UPDATE ledger_attachments SET event_id=NULL WHERE event_id=?", eventId);
    return ids;
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
function cardRow(row: Row): CardRecord {
  return { cardId: row.card_id as string, callId: row.call_id as string, runId: row.run_id as string, claimId: row.claim_id as string,
    turnId: row.turn_id as string, sessionKey: row.session_key as string, eventId: row.event_id as string, kind: row.kind as CardKind,
    status: row.status as CardStatus, source: (row.source as CardSource | undefined) ?? cardSource(row.call_id as string),
    deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at), answeredBy: nullable(row.answered_by), answerKey: nullable(row.answer_key),
    result: row.result === null || row.result === undefined ? null : JSON.parse(row.result as string), surface: nullable(row.answer_surface) as CardSurface | null,
    summary: nullable(row.answer_summary), updatedAt: Number(row.updated_at) };
}
function deliveryRow(row: Row): Delivery {
  return { deliveryId: row.delivery_id as string, eventId: nullable(row.event_id), conversationId: row.conversation_id as string,
    connectionId: row.connection_id as string, route: JSON.parse(row.route as string), purpose: row.purpose as DeliveryPurpose,
    status: row.status as DeliveryStatus, attempts: Number(row.attempts), nextAt: Number(row.next_at),
    platformMessageId: nullable(row.platform_message_id), error: nullable(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
