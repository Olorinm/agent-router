import type { InboxRecord, OutboxRecord } from "../communication/core.js";
import type { AgentLedger, DeliveryPurpose, DeliveryStatus, EventInput, SessionKind, TurnState } from "./ledger.js";

/** What the channel core knows about a connection, without exposing provider secrets to the ledger. */
export interface ShadowContext {
  agentId: string;
  ownerPersonId?: string | undefined;
  channel(connectionId: string): string;
  account(connectionId: string): string;
  person?(connectionId: string, sender: string): string | undefined;
}
const legacyStatus: Record<OutboxRecord["state"], DeliveryStatus> = { queued: "queued", submitting: "sending", accepted: "sent", failed: "rejected", uncertain: "unknown" };
const lifecycle = new Set(["reaction", "message-edit", "message-redaction"]);

function sender(ctx: ShadowContext, record: InboxRecord, owner: boolean): Pick<EventInput, "senderType" | "senderId"> {
  const person = owner ? ctx.ownerPersonId ?? ctx.person?.(record.connectionId, record.source.sender) : ctx.person?.(record.connectionId, record.source.sender);
  return person ? { senderType: "person", senderId: person } : { senderType: "external", senderId: record.source.sender };
}
function sessionOf(record: InboxRecord, channel: string, owner: boolean): { kind: SessionKind; label: string } {
  const source = record.source;
  if (source.scope === "direct") return owner ? { kind: "owner_main", label: "owner-main" } : { kind: "peer", label: `${channel}:direct:${source.sender}` };
  return { kind: "group", label: `${channel}:group:${source.threadId}` };
}
/** Section 5 keying, derived generically from the fields every adapter already emits. */
function conversationOf(ctx: ShadowContext, record: InboxRecord, personId: string | undefined, at: number) {
  const source = record.source, direct = source.scope === "direct";
  // Web DMs (section 5): one conversation per person, independent of the request that carried the message.
  if (ctx.channel(record.connectionId) === "web") return { connectionId: record.connectionId, channel: "web", accountId: ctx.account(record.connectionId),
    kind: "direct" as const, peerId: `person:${personId ?? source.sender}`, parentId: "", threadId: "", sessionKey: record.conversationId,
    ...(personId ? { personId } : {}), replyRoute: { ...record.replyRoute, messageId: "" }, at };
  const peerId = direct ? source.sender : source.groupId ?? source.reply.target;
  const parentId = direct ? source.reply.target : "";
  const threadId = [peerId, parentId].includes(source.threadId) ? "" : source.threadId;
  return { connectionId: record.connectionId, channel: ctx.channel(record.connectionId), accountId: ctx.account(record.connectionId),
    kind: direct ? "direct" as const : "group" as const, peerId, parentId, threadId, sessionKey: record.conversationId,
    ...(direct && personId ? { personId } : {}), replyRoute: record.replyRoute, at };
}
function referenced(ledger: AgentLedger, connectionId: string, data: Record<string, unknown>): { target: string | undefined; external: string | undefined } {
  const relation = data["m.relates_to"] as { event_id?: unknown } | undefined;
  const external = [data.messageId, data.message_id, data.redacts, relation?.event_id].find((value): value is string => typeof value === "string" && Boolean(value));
  return { target: external ? ledger.platformEvent(connectionId, external) : undefined, external };
}

/** Ingress (ADR 6.1): claim, conversation and session, transcript event, platform index and pending input. */
export function shadowReceive(ledger: AgentLedger, ctx: ShadowContext, record: InboxRecord,
  facts: { owner: boolean; allowed: boolean; oversized: boolean; noticeId?: string | undefined }, at = Date.now()): void {
  const { source, connectionId } = record;
  const { duplicate } = ledger.claim({ connectionId, externalId: source.externalId, inputId: record.id, hash: record.hash, at });
  if (duplicate) return;
  // Unknown senders are never written to a transcript, and do not create conversations either.
  if (!facts.allowed) { ledger.settleClaim(connectionId, source.externalId, "ignored", { reason: "sender_not_allowed" }); return; }
  const channel = ctx.channel(connectionId), who = sender(ctx, record, facts.owner);
  const session = sessionOf(record, channel, facts.owner);
  ledger.ensureSession(record.conversationId, session.kind, session.label, at);
  const conversationId = ledger.ensureConversation(conversationOf(ctx, record, who.senderType === "person" ? who.senderId : undefined, at),
    session.kind === "owner_main" && channel !== "web" ? "participant" : "primary");
  if (record.state === "ignored") {
    ledger.settleClaim(connectionId, source.externalId, "ignored", { reason: record.reason ?? "input_empty", conversationId });
    if (facts.oversized && facts.noticeId) {
      const notice = ledger.append(record.conversationId, { kind: "notice", role: "system", senderType: "system", senderId: "router", conversationId,
        idempotencyKey: `notice:${facts.noticeId}`, createdAt: at, body: { text: "这条消息超过当前 24 KB 的文字输入上限，请缩短内容后再发送。", level: "warning", channel } }).event;
      if (channel !== "web") ledger.createDelivery({ deliveryId: facts.noticeId, eventId: notice.eventId, conversationId, connectionId,
        route: { ...record.replyRoute, channel }, purpose: "notice", at });
    }
    return;
  }
  const type = source.event?.type, data = source.event?.data ?? {};
  let input: Pick<EventInput, "kind" | "body" | "refEventId">;
  if (type === "reaction") {
    const ref = referenced(ledger, connectionId, data);
    const relation = data["m.relates_to"] as { key?: unknown } | undefined;
    input = { kind: "reaction", refEventId: ref.target ?? null, body: { targetEventId: ref.target ?? null, ...(ref.target ? {} : { targetExternalId: ref.external ?? null }),
      key: String(data.emoji ?? data.reaction_type ?? relation?.key ?? source.text ?? ""), removed: data.action === "removed" } };
  } else if (type === "message-edit" || type === "message-redaction") {
    const ref = referenced(ledger, connectionId, data);
    input = { kind: type === "message-edit" ? "edit" : "redaction", refEventId: ref.target ?? null,
      body: { targetEventId: ref.target ?? null, ...(ref.target ? {} : { targetExternalId: ref.external ?? null }), ...(type === "message-edit" ? { text: source.text } : {}) } };
  } else if (source.action) {
    const token = ledger.cardToken(source.action.token);
    input = { kind: "action", body: { targetCardId: token?.card_id ?? null, label: token ? String(token.choice_id) : "" } };
  } else {
    // A quote names a platform message id, or (web) an event id of the same session.
    const quotedId = source.quoted?.messageId;
    const replyTo = quotedId ? ledger.platformEvent(connectionId, quotedId) ??
      (ledger.event(quotedId)?.sessionKey === record.conversationId ? quotedId : undefined) : undefined;
    input = { kind: "message", body: { text: source.text,
      ...(replyTo ? { replyTo } : source.quoted ? { quoted: { ...(source.quoted.messageId ? { externalId: source.quoted.messageId } : {}), ...(source.quoted.text ? { text: source.quoted.text } : {}) } } : {}),
      ...(source.event ? { event: { type: source.event.type, data: source.event.data } } : {}),
      ...(source.mentions ? { mentions: source.mentions } : {}), ...(source.privateGroup ? { privateGroup: true } : {}) } };
  }
  const attachments = input.kind === "message" ? (source.attachments ?? []).map((item) => ({ name: item.name, contentType: item.mediaType,
    attachmentId: ledger.addAttachment({ eventId: null, name: item.name, contentType: item.mediaType, locator: { channel: { connectionId, ...item } }, at }) })) : [];
  const { event } = ledger.append(record.conversationId, { ...input, role: "user", ...who, conversationId, createdAt: at,
    idempotencyKey: `${connectionId}:${source.externalId}`,
    body: { ...input.body, channel, ...(attachments.length ? { attachments: attachments.map((item) => ({ ...item, size: null, sha256: null })) } : {}) } });
  ledger.attachEvent(attachments.map((item) => item.attachmentId), event.eventId);
  ledger.indexPlatform(connectionId, [source.externalId], event.eventId);
  if (!type || !lifecycle.has(type)) ledger.queueInput(record.id, record.conversationId, event.eventId, at);
  ledger.settleClaim(connectionId, source.externalId, "accepted", { eventId: event.eventId, conversationId });
}

/** Dispatch (ADR 6.2): the pending input became a turn. A resumed task reuses its turn. */
export function shadowStart(ledger: AgentLedger, ctx: ShadowContext, record: InboxRecord, taskId: string, owner: boolean, at = Date.now()): void {
  const claim = ledger.claimByInput(record.id), pending = ledger.input(record.id);
  if (!claim?.eventId || !pending) return;
  ledger.updateInput(record.id, "started", { turnId: taskId }, at);
  ledger.annotate(claim.eventId, { turnId: taskId });
  const admission = record.source.scope === "group" ? "group" : owner ? "owner" : "peer";
  const turn = ledger.ensureTurn({ turnId: taskId, sessionKey: record.conversationId, admission, originConversationId: claim.conversationId,
    originEventId: claim.eventId, replyRoute: record.replyRoute, at });
  ledger.append(record.conversationId, { kind: "turn", role: "system", senderType: "system", senderId: "router", turnId: taskId,
    idempotencyKey: `turn:${taskId}:input:${record.id}`, createdAt: at,
    body: { agentId: ctx.agentId, state: turn.state, inputEventIds: ledger.turnInputs(taskId) } });
}
export function shadowControl(ledger: AgentLedger, record: InboxRecord, reason: string): void {
  if (ledger.input(record.id)) ledger.updateInput(record.id, "control", { reason });
}
export function shadowTurn(ledger: AgentLedger, agentId: string, taskId: string, state: TurnState, error?: string): void {
  ledger.turnState(taskId, state, { agentId, ...(error ? { error } : {}) });
}

/**
 * Outbound (ADR 6.3/6.4): record first, then the delivery. `event` is null for activity reactions and for
 * deliveries whose event was written elsewhere (`eventId`).
 */
export function shadowOutbox(ledger: AgentLedger, ctx: ShadowContext, input: InboxRecord, outbox: OutboxRecord, purpose: DeliveryPurpose,
  event: (Omit<EventInput, "role" | "senderType" | "senderId"> & Partial<Pick<EventInput, "role" | "senderType" | "senderId">>) | null, eventId?: string, at = Date.now()): string | undefined {
  const claim = ledger.claimByInput(input.id);
  if (!claim?.conversationId || !ledger.session(input.conversationId) || ledger.delivery(outbox.id)) return eventId;
  const channel = ctx.channel(input.connectionId);
  let id = eventId ?? null;
  if (event) {
    const turnId = "turnId" in event ? event.turnId ?? null : outbox.taskId ?? outbox.originTaskId ?? null;
    id = ledger.append(ledger.turn(turnId ?? "")?.sessionKey ?? input.conversationId, { role: "assistant", senderType: "agent", senderId: ctx.agentId,
      conversationId: claim.conversationId, createdAt: at, ...event, turnId, body: { ...event.body, channel } }).event.eventId;
  }
  // Web needs no delivery row: the transcript is its delivery (ADR 2.4).
  if (channel !== "web") ledger.createDelivery({ deliveryId: outbox.id, eventId: id, conversationId: claim.conversationId, connectionId: input.connectionId,
    route: { ...outbox.route, channel }, purpose, ...(outbox.content ? { content: outbox.content } : {}), at });
  return id ?? undefined;
}
export function shadowDelivery(ledger: AgentLedger, outbox: Pick<OutboxRecord, "id" | "state" | "attempts" | "nextAt" | "externalId" | "error">, suppressed = false): void {
  ledger.deliveryStatus(outbox.id, suppressed ? "suppressed" : legacyStatus[outbox.state], { attempts: outbox.attempts, nextAt: outbox.nextAt,
    ...(outbox.externalId ? { platformMessageId: outbox.externalId } : {}), ...(outbox.error ? { error: outbox.error } : {}) });
}
