import { randomUUID } from "node:crypto";
import { ChannelHttpError } from "../channels/http.js";
import type { CommunicationCore, InboxRecord, OutboxRecord } from "../communication/core.js";
import { interaction } from "../communication/interaction.js";
import type { DurableStore } from "../communication/store.js";
import type { HostCall, HostPort } from "../execution/host.js";
import type { RunBinding } from "../execution/host-worker.js";
import type { RunObservation } from "../execution/observation.js";
import { digest, key } from "../execution/protocol.js";
import { WorkError, type CliWork } from "../execution/work.js";
import { RETRY_CALL_PREFIX, type AgentLedger, type CardKind, type CardRecord, type CardStatus, type CardSurface, type LedgerEvent } from "./ledger.js";
import { shadowOutbox } from "./shadow.js";

/** ADR 0005 16.1: the private browser link of a handoff card is never stored in the transcript. */
export const HANDOFF_LINK = "[私密链接，仅在卡片待处理时显示]";
export const redactLinks = (text: string) => text.replace(/https:\/\/[^\s"'<>）)]+/g, HANDOFF_LINK);
const redactDeep = (value: unknown): unknown => typeof value === "string" ? redactLinks(value) : Array.isArray(value) ? value.map(redactDeep)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactDeep(item)])) : value;
const approvalMethod = (name: string) => name === "approval" || name === "permission" || name === "session/request_permission" || /requestApproval$/.test(name);

/** Card kind of a Host interaction (ADR 4.1 `ledger_cards.kind`). */
export function cardKind(call: Pick<HostCall, "id" | "name">, sensitive: boolean): CardKind {
  if (sensitive) return "sensitive";
  if (call.id.startsWith("mau-approval:")) return "connector_approval";
  return approvalMethod(call.name) && !call.id.startsWith("mau-handoff:") ? "approval" : "question";
}
/** The card body stored in the `card` event. Handoff cards keep no private link (decision 15.2.14). */
export function cardBody(input: { cardId: string; agentId: string; turnId: string; claimId: string; call: HostCall; text: string;
  choices: string[]; kind: CardKind }) {
  const handoff = input.call.id.startsWith("mau-handoff:"), deadline = Date.parse(input.call.deadlineAt);
  return { cardId: input.cardId, agentId: input.agentId, turnId: input.turnId, claimId: input.claimId, callId: input.call.id, kind: input.kind,
    source: input.call.id.startsWith("mau-approval:") ? "mau-approval" : handoff ? "mau-handoff" : "host",
    text: handoff ? redactLinks(input.text) : input.text, choices: input.choices.map((label, index) => ({ choiceId: String(index), label })),
    freeText: input.kind === "question", native: { method: input.call.name, params: handoff ? redactDeep(input.call.input) : input.call.input ?? null },
    deadlineAt: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface CardView {
  cardId: string; agentId: string; turnId: string; claimId: string; callId: string; kind: CardKind; source: string; text: string;
  choices: Array<{ choiceId: string; label: string; style?: "primary" | "danger" }>; freeText: boolean; native?: { method: string; params: unknown };
  deadlineAt: string | null; status: CardStatus;
}
export interface AnswerInput {
  key: string; by: string | null; surface: CardSurface;
  choiceId?: string | undefined; text?: string | undefined; result?: unknown; hasResult?: boolean;
}
export interface ControlDependencies {
  agentId: string; ownerPersonId: string; store: DurableStore; ledger: AgentLedger; core: CommunicationCore; work: CliWork;
  observation?: RunObservation | undefined; host?: HostPort | undefined;
  /** Close an unknown run after the owner decided (HostWorker.closeUnknown). */
  closeUnknown?: ((claimId: string) => Promise<void>) | undefined;
  /** Drop the blob references of purged ledger attachments (`OwnerAttachments.releaseAgent`); set with `attachments`. */
  releaseAttachments?: ((attachmentIds: string[]) => void) | undefined;
}

/**
 * Phase 4 owner control over the ledger (ADR 0005 section 16): card answers from every surface into one card record,
 * the unknown-turn retry card, cancel, steer, reset and purge. Network calls never run inside a ledger transaction.
 */
export class LedgerControl {
  /** A planned answer younger than this is still owned by its in-flight request. */
  replanGraceMs = 5_000;
  constructor(readonly deps: ControlDependencies) {}
  private get ledger() { return this.deps.ledger; }
  private tx<T>(work: () => T): T { return this.deps.store.db.isTransaction ? work() : this.deps.store.transaction(work); }
  get cards() { return this.ledger.authoritative && this.ledger.features.cards; }
  get resets() { return this.ledger.authoritative && this.ledger.features.reset; }

  card(cardId: string): CardRecord | undefined { return this.ledger.cardRecord(cardId); }
  /** The API `Card`: stored body, current status. A pending handoff card shows the live text (with its private link). */
  async view(cardId: string, live = false): Promise<CardView> {
    const record = this.card(cardId); if (!record) throw new WorkError("card_not_found", 404);
    const stored = (this.ledger.event(record.eventId)?.body.card ?? {}) as Partial<CardView>;
    const view = { ...stored, cardId, source: record.source, kind: record.kind, status: record.status } as CardView;
    if (live && record.status === "pending" && record.source === "mau-handoff") {
      const call = await this.liveCall(record).catch(() => undefined);
      if (call) return { ...view, text: interaction(call).text, native: { method: call.name, params: call.input ?? null } };
    }
    return view;
  }
  private async liveCall(card: CardRecord): Promise<HostCall | undefined> {
    if (!this.deps.observation) return undefined;
    const { calls } = await this.deps.observation.run(card.claimId);
    return calls.find((item) => item.id === card.callId);
  }

  /** Status mapping (ADR 16.1): approvals by their allow/deny choice, everything else `answered`. */
  outcome(card: CardRecord, result: unknown): Exclude<CardStatus, "pending"> {
    if (card.kind === "connector_approval") return (result as { choice?: unknown } | null)?.choice === "once" ? "approved" : "rejected";
    if (card.kind !== "approval") return "answered";
    const native = (this.ledger.event(card.eventId)?.body.card as { native?: { method?: string; params?: { options?: Array<{ optionId?: string; kind?: string }> } } } | undefined)?.native;
    if (native?.method === "session/request_permission") {
      const id = (result as { outcome?: { optionId?: unknown } } | null)?.outcome?.optionId;
      const kind = native.params?.options?.find((option) => option.optionId === id)?.kind ?? "";
      return kind.startsWith("allow") ? "approved" : kind.startsWith("reject") ? "rejected" : "answered";
    }
    const allow = this.ledger.cardChoice(card.cardId, "0"), deny = this.ledger.cardChoice(card.cardId, "1");
    if (allow && same(JSON.parse(String(allow.result)), result)) return "approved";
    if (deny && same(JSON.parse(String(deny.result)), result)) return "rejected";
    return "answered";
  }
  /** Commit (ADR 16.1 step 7). `closed` is false when another surface closed the card first. */
  commit(card: CardRecord, result: unknown, fields: { by?: string | null; summary?: string | null; surface?: CardSurface } = {}): boolean {
    const closed = this.tx(() => {
      const done = this.ledger.cardStatus(card.cardId, this.outcome(card, result), { answeredBy: fields.by ?? card.answeredBy, summary: fields.summary ?? card.summary,
        ...(fields.surface ? { surface: fields.surface } : {}) });
      const question = this.deps.store.get<{ closed?: boolean }>("communication_questions", card.callId);
      if (question && !question.closed) this.deps.store.set("communication_questions", card.callId, { ...question, closed: true });
      return done;
    });
    // An answer given in the web is announced in the external conversation the card was sent to.
    if (closed && (fields.surface ?? card.surface) === "web") {
      const input = this.deps.core.input(card.turnId);
      if (input && input.connectionId !== "web" && this.deps.core.capabilities(card.turnId)) {
        try { this.deps.core.notice(input, "已在网页回答。", `web-answer:${card.cardId}`); } catch { /* The card state is already committed. */ }
      }
    }
    return closed;
  }
  /** Close a card whose call ended without a Router answer. A planned answer that reached the Host is committed. */
  close(card: CardRecord, reason: "ended" | "left", at = Date.now()): void {
    const fresh = this.card(card.cardId); if (!fresh || fresh.status !== "pending") return;
    if (fresh.answerKey) { this.commit(fresh, fresh.result); return; }
    const expired = fresh.deadlineAt !== null && fresh.deadlineAt <= at;
    this.tx(() => this.ledger.cardStatus(fresh.cardId, expired ? "expired" : reason === "ended" ? "canceled" : "answered", { surface: "host" }));
  }
  /** Worker observation: open cards of a running run whose call is no longer pending. */
  observe(runId: string, pending: HostCall[]): void {
    const ids = new Set(pending.filter((call) => call.kind === "interaction").map((call) => call.id));
    for (const card of this.ledger.openCards({ runId })) if (!ids.has(card.callId)) this.close(card, "left");
  }
  /** The run finished: every open card of it closes. */
  ended(runId: string): void { for (const card of this.ledger.openCards({ runId })) this.close(card, "ended"); }

  /**
   * Answer a card (ADR 16.1 steps 3-7). Scope and HTTP idempotency are checked by the caller. Returns `stale` when the
   * card was answered elsewhere, expired or its call is gone. A Host or network failure leaves the planned answer in
   * place (503 `card_answer_pending`); the worker re-resolves it.
   */
  async answer(cardId: string, input: AnswerInput): Promise<{ status: "accepted" | "stale"; card: CardView }> {
    let card = this.card(cardId); if (!card) throw new WorkError("card_not_found", 404);
    const stale = async () => ({ status: "stale" as const, card: await this.view(cardId) });
    // The worker completed this request's planned answer (after a Host failure or crash): it is this request's answer.
    if (card.status !== "pending" && card.answerKey === input.key) return { status: "accepted", card: await this.view(cardId) };
    if (card.status !== "pending" || card.answerKey && card.answerKey !== input.key) return stale();
    if (card.kind === "sensitive") throw new WorkError("sensitive_input_requires_native_entry", 422);
    let result: unknown, summary: string | undefined;
    if (card.answerKey === input.key) { result = card.result; summary = card.summary ?? undefined; }
    else {
      const body = (this.ledger.event(card.eventId)?.body.card ?? {}) as Partial<CardView>;
      if (input.choiceId !== undefined) {
        const choice = this.ledger.cardChoice(cardId, input.choiceId);
        if (!choice) throw new WorkError("choice_not_found", 422);
        result = JSON.parse(String(choice.result)); summary = body.choices?.find((item) => item.choiceId === input.choiceId)?.label ?? input.choiceId;
      } else if (input.text !== undefined) {
        summary = Array.from(input.text).slice(0, 140).join("");
        if (card.source === "router") {
          const index = (body.choices ?? []).findIndex((item) => item.label === input.text!.trim());
          const choice = index >= 0 ? this.ledger.cardChoice(cardId, String(index)) : undefined;
          if (!choice) throw new WorkError("invalid_answer", 422).with({ detail: "interaction_choice_required" });
          result = JSON.parse(String(choice.result));
        } else {
          const call = await this.liveCall(card);
          if (!call || call.status !== "pending") { this.close(card, "left"); return stale(); }
          try { result = interaction(call).answer(input.text); }
          catch (error) { throw new WorkError("invalid_answer", 422).with({ detail: error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "invalid_answer" }); }
        }
      } else if (input.hasResult) {
        if (card.source !== "host" || card.kind !== "question") throw new WorkError("choice_or_text_required", 422);
        result = input.result; summary = "";
      } else throw new WorkError("choice_or_text_required", 422);
      const planned = this.tx(() => this.ledger.planAnswer(cardId, { key: input.key, result, by: input.by, surface: input.surface, ...(summary ? { summary } : {}) }));
      if (planned === "closed" || planned === "taken") return stale();
      card = this.card(cardId)!;
    }
    const settled = await this.deliver(card, result);
    if (settled === "stale") return stale();
    this.commit(card, result, { by: input.by, ...(summary !== undefined ? { summary } : {}), surface: input.surface });
    return { status: "accepted", card: await this.view(cardId) };
  }
  /** Step 6: resolve through RunObservation (Host, or Mau's synthetic calls), or run a Router-native card. */
  private async deliver(card: CardRecord, result: unknown): Promise<"done" | "stale"> {
    if (card.source === "router") { await this.retryDecision(card, result); return "done"; }
    const observation = this.deps.observation;
    if (!observation) throw new WorkError("host_observation_unavailable", 409);
    try { await observation.resolve(card.claimId, card.callId, result); return "done"; }
    catch (error) {
      const status = error instanceof WorkError ? error.status : error instanceof ChannelHttpError ? error.status : 0;
      const code = error instanceof Error ? error.message : "";
      if (status === 404) { this.tx(() => this.ledger.cardStatus(card.cardId, "expired", { surface: "host" })); return "stale"; }
      if (status === 409) { this.tx(() => this.ledger.unplanAnswer(card.cardId, card.answerKey ?? "")); return "stale"; }
      if (status === 400 || status === 422) {
        this.tx(() => this.ledger.unplanAnswer(card.cardId, card.answerKey ?? ""));
        throw new WorkError("invalid_answer", 422).with({ detail: /^[a-z0-9_]+$/.test(code) ? code : "invalid_answer" });
      }
      throw new WorkError("card_answer_pending", 503).with({ retryAfterMs: 1000 });
    }
  }
  /**
   * Answers from the run API and Mau's call endpoint (ADR 16.1 "one record"): plan, resolve, commit. Without the
   * `cards` feature the answer is only recorded after the Host accepted it.
   */
  async record(runId: string, callId: string, input: { by: string | null; surface: CardSurface; result: unknown }, resolve: () => Promise<void>): Promise<"accepted" | "stale"> {
    const card = this.ledger.cardByCall(runId, callId);
    if (!card) { await resolve(); return "accepted"; }
    const key = `${input.surface}:${randomUUID()}`;
    if (this.cards) {
      const planned = this.tx(() => this.ledger.planAnswer(card.cardId, { key, result: input.result, by: input.by, surface: input.surface }));
      if (planned !== "planned") return "stale";
      try { await resolve(); } catch (error) { this.tx(() => this.ledger.unplanAnswer(card.cardId, key)); throw error; }
      this.commit(this.card(card.cardId)!, input.result, { by: input.by, surface: input.surface });
      return "accepted";
    }
    await resolve();
    // Shadow mode: the Host accepted the answer; a ledger error must not turn that into a failure.
    try { this.commit(card, input.result, { by: input.by, surface: input.surface }); } catch { this.ledger.lastError = "card_record_failed"; }
    return "accepted";
  }
  /**
   * Chat answers (HostWorker.handleInput): plan before the Host call. `stale` when another surface answered first.
   * Without the `cards` feature, nothing is gated.
   */
  planChat(call: Pick<HostCall, "id" | "runId">, input: { inputId: string; by: string | null; result: unknown; summary?: string }): "planned" | "stale" | "untracked" {
    const card = this.ledger.cardByCall(call.runId, call.id);
    if (!card) return "untracked";
    if (!this.cards) return card.status === "pending" ? "planned" : "untracked";
    const planned = this.tx(() => this.ledger.planAnswer(card.cardId, { key: `channel:${input.inputId}`, result: input.result, by: input.by, surface: "channel",
      ...(input.summary ? { summary: input.summary } : {}) }));
    return planned === "planned" || planned === "same" ? "planned" : "stale";
  }
  commitChat(call: Pick<HostCall, "id" | "runId">, input: { by: string | null; result: unknown; summary?: string }): void {
    const card = this.ledger.cardByCall(call.runId, call.id);
    if (card) this.commit(card, input.result, { by: input.by, surface: "channel", ...(input.summary !== undefined ? { summary: input.summary } : {}) });
  }
  /** Worker tick: planned answers whose resolve did not complete (crash or Host failure) are resolved again once more. */
  async reresolve(now = Date.now(), graceMs = this.replanGraceMs): Promise<void> {
    if (!this.cards) return;
    for (const card of this.ledger.plannedCards()) {
      if (card.updatedAt > now - graceMs) continue;
      try { if ((await this.deliver(card, card.result)) === "done") this.commit(this.card(card.cardId) ?? card, card.result); }
      catch { /* Retried on the next tick; the Host arbitrates repeated identical answers. */ }
    }
  }

  /** ADR 6.2.4: an unknown turn gets a "重新执行 / 不用了" card. It is never replayed automatically. */
  unknownTurn(binding: Pick<RunBinding, "claimId" | "taskId" | "contextId">): void {
    if (!this.cards) return;
    const ledger = this.ledger, turn = ledger.turn(binding.taskId); if (!turn) return;
    const callId = `${RETRY_CALL_PREFIX}${binding.taskId}`, runId = `router:${binding.claimId}`;
    const cardId = `cd_${digest(key(runId, callId)).slice(0, 40)}`;
    if (ledger.card(cardId)) return;
    const text = "这一轮执行中断，结果无法确认，系统不会自动重复执行。要重新执行吗？";
    const labels = ["重新执行", "不用了"], results = [{ action: "retry" }, { action: "skip" }];
    const input = this.deps.core.input(binding.taskId), external = input && input.connectionId !== "web";
    const nativeButtons = external ? this.deps.core.capabilities(binding.taskId)?.buttons : undefined;
    const tokens = labels.map((_label, index) => digest(key(callId, String(index))).slice(0, 32));
    this.tx(() => {
      const event = ledger.append(turn.sessionKey, { kind: "card", role: "assistant", senderType: "system", senderId: "router", turnId: binding.taskId,
        idempotencyKey: `card:${cardId}`, body: { card: { cardId, agentId: this.deps.agentId, turnId: binding.taskId, claimId: binding.claimId, callId,
          kind: "question", source: "router", text, choices: labels.map((label, index) => ({ choiceId: String(index), label, style: index ? "danger" : "primary" })),
          freeText: false, deadlineAt: null } } }).event;
      ledger.addCard({ cardId, callId, runId, claimId: binding.claimId, turnId: binding.taskId, sessionKey: turn.sessionKey, eventId: event.eventId,
        kind: "question", source: "router", deadlineAt: null });
      labels.forEach((_label, index) => ledger.addCardToken(tokens[index]!, cardId, String(index), results[index]));
      if (external) {
        const body = `${text}\n${nativeButtons ? "可点击选项，或直接回复“重新执行”或“不用了”。" : "请回复“重新执行”或“不用了”。"}`;
        const noticeId = this.deps.core.notice(input!, body, `question:${callId}`, { text: body, ...(nativeButtons ? { buttons: labels.map((label, index) => ({ label, token: tokens[index]! })) } : {}) });
        const notice = this.deps.store.get<OutboxRecord>("communication_outbox", noticeId);
        if (notice) shadowOutbox(ledger, this.deps.core.shadowContext, input!, notice, "card", null, event.eventId);
      }
    });
  }
  /** The unknown turn was reconciled or closed elsewhere: its unanswered retry card is withdrawn. */
  unknownSettled(turnId: string): void {
    for (const card of this.ledger.openCards({ turnId })) if (card.source === "router" && !card.answerKey)
      this.tx(() => this.ledger.cardStatus(card.cardId, "canceled", { surface: "host" }));
  }
  /** "重新执行": close the unknown run, then queue a copy of the original input marked as a possible duplicate. */
  private async retryDecision(card: CardRecord, result: unknown): Promise<void> {
    try { await this.deps.closeUnknown?.(card.claimId); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "host_run_still_running") { this.tx(() => this.ledger.unplanAnswer(card.cardId, card.answerKey ?? "")); throw new WorkError("turn_still_running", 409); }
      if (code !== "unknown_run_not_found" && code !== "claim_not_current") throw new WorkError("card_answer_pending", 503).with({ retryAfterMs: 1000 });
    }
    if ((result as { action?: unknown } | null)?.action !== "retry") return;
    const original = this.deps.core.input(card.turnId);
    if (!original) return;
    const ledger = this.ledger, externalId = `${original.source.externalId}:retry:${card.turnId}`.slice(0, 512);
    this.tx(() => {
      const record = this.deps.core.receive(original.connectionId, { ...original.source, externalId,
        ...(original.connectionId === "web" ? { reply: { ...original.source.reply, messageId: externalId } } : {}) });
      const claim = ledger.claimFor(original.connectionId, externalId);
      if (!claim?.eventId) return;
      ledger.annotate(claim.eventId, { body: { possibleDuplicate: true } });
      ledger.markRetry(record.id, original.id);
    });
  }

  /** ADR 16.2 cancel. The Host cancel follows through the worker; the turn becomes `canceled` by its turn event. */
  async cancel(sessionKey: string, turnId: string): Promise<{ status: "accepted" } | { status: "already_finished"; state: string }> {
    const turn = this.ledger.turn(turnId);
    if (!turn || turn.sessionKey !== sessionKey) throw new WorkError("turn_not_found", 404);
    if (["completed", "failed", "canceled"].includes(turn.state)) return { status: "already_finished", state: turn.state };
    await this.deps.work.cancel(turnId);
    this.tx(() => this.ledger.append(sessionKey, { kind: "notice", role: "system", senderType: "system", senderId: "router", turnId,
      idempotencyKey: `cancel:${turnId}`, body: { text: "正在停止当前任务。", level: "info" } }));
    return { status: "accepted" };
  }
  /** ADR 16.2 steer: requires a running binding; on success the steered text is a user message inside the turn. */
  async steer(sessionKey: string, turnId: string, input: { personId: string; idempotencyKey: string; text: string }): Promise<{ status: "accepted"; event: LedgerEvent } | { status: "unsupported" }> {
    const turn = this.ledger.turn(turnId);
    if (!turn || turn.sessionKey !== sessionKey) throw new WorkError("turn_not_found", 404);
    const idempotencyKey = `web:${input.personId}:${input.idempotencyKey}`, prior = this.ledger.eventByKey(sessionKey, idempotencyKey);
    if (prior) return { status: "accepted", event: prior };
    const binding = this.deps.store.entries<RunBinding>("communication_runs").map(({ value }) => value)
      .find((item) => item.taskId === turnId && item.phase === "running" && item.runId);
    if (!binding?.runId || ["completed", "failed", "canceled"].includes(turn.state)) throw new WorkError("turn_not_running", 409);
    const host = this.deps.host;
    if (!host?.steer) return { status: "unsupported" };
    try { await host.steer(binding.runId, input.text); }
    catch (error) {
      const status = error instanceof WorkError || error instanceof ChannelHttpError ? error.status : 0;
      if ((error instanceof Error && error.message === "host_steer_unsupported") || status >= 400 && status < 500) return { status: "unsupported" };
      throw new WorkError("steer_failed", 503);
    }
    const event = this.tx(() => this.ledger.append(sessionKey, { kind: "message", role: "user", senderType: "person", senderId: input.personId, turnId,
      idempotencyKey, body: { text: input.text, steer: true, channel: "web" } }).event);
    return { status: "accepted", event };
  }
  /** Cancel active turns and drop queued inputs (reset or purge with `cancelActive`). */
  private async clear(sessionKey: string, reason: string, cancelActive: boolean): Promise<void> {
    const busy = this.ledger.busy(sessionKey);
    if (!busy.activeTurns.length && !busy.queuedInputs.length) return;
    if (!cancelActive) throw new WorkError("session_busy", 409).with({ activeTurns: busy.activeTurns, queuedInputs: busy.queuedInputs.length });
    for (const turnId of busy.activeTurns) await this.deps.work.cancel(turnId).catch(() => undefined);
    this.tx(() => {
      for (const inputId of busy.queuedInputs) {
        this.ledger.updateInput(inputId, "dropped", { reason });
        const legacy = this.deps.store.get<InboxRecord>("communication_inbox", inputId);
        if (legacy?.state === "received") this.deps.store.set("communication_inbox", inputId, { ...legacy, state: "done", reason: `dropped_by_${reason}` } satisfies InboxRecord);
      }
    });
  }
  /** ADR 16.3 reset of the shared session: every owner channel continues in the new window. */
  async reset(sessionKey: string, options: { cancelActive?: boolean } = {}): Promise<{ window: number; event: LedgerEvent }> {
    if (!this.ledger.session(sessionKey)) throw new WorkError("chat_not_found", 404);
    await this.clear(sessionKey, "reset", Boolean(options.cancelActive));
    return this.tx(() => this.ledger.reset(sessionKey));
  }
  /**
   * ADR 16.4 purge: the transcript is deleted, claims are tombstoned and the chat continues in a new window. The legacy
   * inbox and settled outbox copies of the session's messages lose their text too (hashes and ids are kept).
   */
  async purge(sessionKey: string, options: { cancelActive?: boolean } = {}): Promise<{ generation: number; purgedEvents: number; window: number }> {
    if (!this.ledger.session(sessionKey)) throw new WorkError("chat_not_found", 404);
    await this.clear(sessionKey, "purge", Boolean(options.cancelActive));
    const result = this.tx(() => {
      const purged = this.ledger.purge(sessionKey);
      const store = this.deps.store, tasks = new Set<string>();
      for (const { id, value } of store.entries<InboxRecord>("communication_inbox")) {
        if (value.conversationId !== sessionKey) continue;
        if (value.taskId) tasks.add(value.taskId);
        const { attachments: _attachments, quoted: _quoted, ...source } = value.source;
        store.set("communication_inbox", id, { ...value, source: { ...source, text: "" } } satisfies InboxRecord);
        store.delete("communication_media", id);
      }
      for (const { id, value } of store.entries<OutboxRecord>("communication_outbox")) {
        if (value.state === "queued" || value.state === "submitting" || !tasks.has(value.taskId ?? value.originTaskId ?? "")) continue;
        const { content: _content, ...rest } = value;
        store.set("communication_outbox", id, { ...rest, text: "" } satisfies OutboxRecord);
      }
      return { generation: purged.generation, purgedEvents: purged.purgedEvents, window: purged.window, attachmentIds: purged.attachmentIds };
    });
    // ADR 16.4: the purged rows' blob references go too (the hub is another file, so after the agent transaction; the
    // blob itself is swept after its grace period).
    if (result.attachmentIds.length) this.deps.releaseAttachments?.(result.attachmentIds);
    return { generation: result.generation, purgedEvents: result.purgedEvents, window: result.window };
  }

  /**
   * Control commands from any owner channel (ADR 16.3): `/new`, `/reset`, `新对话`. The reply goes to that conversation
   * only. Also answers to the retry card by its button or its exact label.
   */
  async command(input: InboxRecord): Promise<boolean> {
    const text = input.source.text.trim(), core = this.deps.core;
    if (this.resets && /^(\/(?:new|reset)(?:@\w+)?|新对话)$/i.test(text) && core.isOwnerInput(input) && this.ledger.session(input.conversationId)?.kind === "owner_main") {
      try { await this.reset(input.conversationId); core.notice(input, "已开始新对话。", "reset"); }
      catch (error) {
        if (!(error instanceof WorkError) || error.message !== "session_busy") throw error;
        core.notice(input, "当前任务进行中，请先停止。", "reset-busy");
      }
      return true;
    }
    if (!this.cards || !core.isOwnerInput(input)) return false;
    const token = input.source.action ? this.ledger.cardToken(input.source.action.token) : undefined;
    const cards = this.ledger.openCards({ sessionKey: input.conversationId }).filter((card) => card.source === "router");
    const card = token ? cards.find((item) => item.cardId === token.card_id) : cards.length === 1 ? cards[0] : undefined;
    if (!card || !token && !["重新执行", "不用了"].includes(text)) return false;
    const answered = await this.answer(card.cardId, { key: `channel:${input.id}`, by: core.ownerPersonId ?? null, surface: "channel",
      ...(token ? { choiceId: String(token.choice_id) } : { text }) });
    core.notice(input, answered.status === "stale" ? "这个问题已经回答过了。" : "已收到回答。", "retry-answer");
    return true;
  }
}
