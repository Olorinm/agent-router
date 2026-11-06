import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboxRecord, OutboxRecord } from "../communication/core.js";
import { DurableStore } from "../communication/store.js";
import type { RunBinding } from "../execution/host-worker.js";
import { digest, key } from "../execution/protocol.js";
import { CliWork } from "../execution/work.js";
import type { ManagedAgent } from "../matrix/managed.js";
import type { RoomEvent } from "../matrix/protocol.js";
import type { TimelineEntry } from "../matrix/social.js";
import { OwnerHubs } from "./hub.js";
import { AgentLedger, legacySession, type EventInput, type SessionKind, type TurnState } from "./ledger.js";
import { personId } from "./registry.js";

export type HistoryPort = (room: string, from?: string) => Promise<{ events: RoomEvent[]; end?: string }>;
export interface BackfillOptions {
  stateDir: string; agentId?: string | undefined; dryRun?: boolean | undefined;
  /** Synapse gap filling, acting as the agent's virtual user with the Application Service token. Optional. */
  history?: ((agent: ManagedAgent) => HistoryPort | undefined) | undefined;
  maxPages?: number | undefined;
}
export interface RoomReport {
  room: string; class: "owner_dm" | "peer" | "group" | "mau_group"; imported: number; duplicate: number; fromSynapse: number; skipped: Record<string, number>;
}
export interface AgentReport {
  agentId: string; rooms: RoomReport[]; linked: { turns: number; deliveries: number; cards: number };
  unmatched: { inbox: number; outbox: number }; resequenced: string[];
}
type Stamped = { room: string; event: RoomEvent & { origin_server_ts?: number }; cursor: number; synapse: boolean };
class DryRun extends Error {}
const turnStates: Record<string, TurnState> = { completed: "completed", failed: "failed", rejected: "failed", canceled: "canceled",
  working: "running", input_required: "waiting", auth_required: "waiting", submitted: "queued" };

/** Read the registry's identity without opening it as a DurableStore with the wrong identity. */
function storeIdentity(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return JSON.parse(String(db.prepare("SELECT value FROM documents WHERE collection='meta' AND id='identity'").get()?.value ?? "null")) as string; }
  finally { db.close(); }
}
function matrixConnection(stateDir: string, agentId: string): string {
  const file = join(stateDir, "connections", "agents", agentId, "channels.json");
  if (!existsSync(file)) return "matrix";
  const config = JSON.parse(readFileSync(file, "utf8")) as { agents?: Array<{ connections?: Array<{ id: string; kind: string }> }> };
  return config.agents?.[0]?.connections?.find((item) => item.kind === "matrix")?.id ?? "matrix";
}

/**
 * ADR 0005 section 10: import each agent's Matrix `timeline` mirror (plus optional Synapse history) into its ledger.
 * Offline (it takes the agent store lease), idempotent (keys `<connectionId>:<eventId>`), and `dryRun` rolls back.
 */
export async function backfill(options: BackfillOptions): Promise<{ dryRun: boolean; agents: AgentReport[] }> {
  const registryPath = join(options.stateDir, "registry.sqlite");
  if (!existsSync(registryPath)) throw new Error("registry_not_found");
  const registry = new DurableStore(registryPath, storeIdentity(registryPath));
  const hubs = new OwnerHubs(options.stateDir, { owns: () => false, agentName: (id) => id, ledger: () => undefined, personName: () => undefined });
  try {
    const all = registry.entries<ManagedAgent>("agents").map(({ value }) => value).filter((agent) => agent.status !== "deleting");
    const selected = options.agentId ? all.filter((agent) => agent.id === options.agentId) : all;
    if (options.agentId && !selected.length) throw new Error("agent_not_found");
    const reports: AgentReport[] = [];
    for (const agent of selected) reports.push(await backfillAgent(options, agent, all, hubs));
    return { dryRun: Boolean(options.dryRun), agents: reports };
  } finally { hubs.close(); registry.close(); }
}

async function backfillAgent(options: BackfillOptions, agent: ManagedAgent, all: ManagedAgent[], hubs: OwnerHubs): Promise<AgentReport> {
  const path = join(options.stateDir, "agents", `${agent.id}.sqlite`);
  const report: AgentReport = { agentId: agent.id, rooms: [], linked: { turns: 0, deliveries: 0, cards: 0 }, unmatched: { inbox: 0, outbox: 0 }, resequenced: [] };
  if (!existsSync(path)) return report;
  const store = new DurableStore(path, agent.matrixId), lease = `ledger-backfill-${process.pid}`;
  try {
    store.acquireLease(lease); // Refuses while the service runs this agent.
    const ledger = AgentLedger.open(store), connection = matrixConnection(options.stateDir, agent.id);
    const owner = agent.owner, ownerPerson = personId(owner);
    const agents = new Map(all.filter((item) => item.owner === owner).map((item) => [item.matrixId, item.id]));
    const timeline = store.entries<TimelineEntry>("timeline").map(({ value }) => value);
    const rooms = new Set([...timeline.map((entry) => entry.room), ...store.entries("rooms").map(({ id }) => id), ...store.entries("room_info").map(({ id }) => id)]);
    const stamped: Stamped[] = timeline.map((entry) => ({ room: entry.room, event: entry.event, cursor: entry.cursor, synapse: false }));
    const port = options.history?.(agent);
    if (port) {
      const seen = new Set(timeline.map((entry) => entry.event.event_id));
      for (const room of rooms) {
        let from: string | undefined;
        for (let page = 0; page < (options.maxPages ?? 1000); page++) {
          const result = await port(room, from);
          for (const event of result.events) if (event.event_id && !seen.has(event.event_id)) { seen.add(event.event_id); stamped.push({ room, event, cursor: 0, synapse: true }); }
          if (!result.end || !result.events.length || result.end === from) break;
          from = result.end;
        }
      }
    }
    stamped.sort((a, b) => (a.event.origin_server_ts ?? 0) - (b.event.origin_server_ts ?? 0) || a.cursor - b.cursor);
    const hub = hubs.hub(owner);
    const work = () => {
      const roomReports = new Map<string, RoomReport>(), touched = new Map<string, number>();
      const classify = (room: string): RoomReport["class"] => {
        const info = store.get<{ members?: string[]; group?: boolean }>("rooms", room) ?? store.get<{ members?: string[] }>("room_info", room);
        const others = [...new Set(info?.members ?? [])].filter((member) => member !== agent.matrixId);
        // `ai.mau.room` groups are not migrated (product decision 2026-11-06): their history stays in the Synapse archive.
        if ((info as { group?: boolean } | undefined)?.group) return "mau_group";
        if (others.length === 1 && others[0] === owner) return "owner_dm";
        return others.length === 1 ? "peer" : "group";
      };
      const roomReport = (room: string) => {
        let item = roomReports.get(room);
        if (!item) { item = { room, class: classify(room), imported: 0, duplicate: 0, fromSynapse: 0, skipped: {} }; roomReports.set(room, item); }
        return item;
      };
      for (const room of rooms) roomReport(room);
      const sender = (mxid: string): Pick<EventInput, "role" | "senderType" | "senderId"> => agents.has(mxid)
        ? { role: "assistant", senderType: "agent", senderId: agents.get(mxid)! }
        : mxid === owner ? { role: "user", senderType: "person", senderId: ownerPerson } : { role: "user", senderType: "external", senderId: mxid };
      for (const { room, event, synapse } of stamped) {
        const item = roomReport(room), content = event.content ?? {};
        if (item.class === "mau_group") { item.skipped.mau_group = (item.skipped.mau_group ?? 0) + 1; continue; }
        const relation = content["m.relates_to"] as { rel_type?: string; event_id?: string; key?: string; "m.in_reply_to"?: { event_id?: string } } | undefined;
        const skip = (reason: string) => { item.skipped[reason] = (item.skipped[reason] ?? 0) + 1; };
        const target = (id: string | undefined) => id ? ledger.platformEvent(connection, id) : undefined;
        let input: Pick<EventInput, "kind" | "refEventId" | "body">;
        if (event.state_key !== undefined) {
          if (event.type === "m.room.name") input = { kind: "member", body: { action: "rename", title: String(content.name ?? "") } };
          else if (event.type === "m.room.member") {
            const membership = String(content.membership ?? "");
            if (!["join", "leave", "ban"].includes(membership)) { skip(`state:${event.type}`); continue; }
            input = { kind: "member", body: { action: membership === "join" ? "add" : "remove", member: { type: agents.has(event.state_key) ? "agent" : event.state_key === owner ? "person" : "external",
              id: agents.get(event.state_key) ?? (event.state_key === owner ? ownerPerson : event.state_key), name: String(content.displayname ?? event.state_key) } } };
          } else { skip(`state:${event.type}`); continue; }
        } else if (event.type === "m.room.message" && relation?.rel_type === "m.replace") {
          const ref = target(relation.event_id), replacement = (content["m.new_content"] ?? content) as Record<string, unknown>;
          input = { kind: "edit", refEventId: ref ?? null, body: { targetEventId: ref ?? null, ...(ref ? {} : { targetExternalId: relation.event_id }), text: String(replacement.body ?? "") } };
        } else if (event.type === "m.room.message") {
          const media = typeof content.url === "string";
          const replyTo = target(relation?.["m.in_reply_to"]?.event_id);
          input = { kind: "message", body: { text: media ? "" : String(content.body ?? ""), ...(content.msgtype === "m.notice" ? { notice: true } : {}),
            ...(replyTo ? { replyTo } : {}), ...(Object.keys(content).length ? {} : { redacted: true }) } };
          if (media) {
            const info = content.info as { mimetype?: string; size?: number } | undefined;
            const attachmentId = ledger.addAttachment({ eventId: null, name: String(content.body ?? "attachment"), contentType: info?.mimetype ?? "application/octet-stream",
              size: typeof info?.size === "number" ? info.size : null, locator: { channel: { connectionId: connection, id: content.url, name: String(content.body ?? "attachment") } } });
            input.body.attachments = [{ attachmentId, name: String(content.body ?? "attachment"), contentType: info?.mimetype ?? "application/octet-stream",
              size: typeof info?.size === "number" ? info.size : null, sha256: null }];
          }
        } else if (event.type === "m.reaction") {
          const ref = target(relation?.event_id);
          input = { kind: "reaction", refEventId: ref ?? null, body: { targetEventId: ref ?? null, ...(ref ? {} : { targetExternalId: relation?.event_id ?? null }), key: String(relation?.key ?? ""), removed: false } };
        } else if (event.type === "m.room.redaction") {
          const redacts = typeof content.redacts === "string" ? content.redacts : event.redacts, ref = target(redacts);
          input = { kind: "redaction", refEventId: ref ?? null, body: { targetEventId: ref ?? null, ...(ref ? {} : { targetExternalId: redacts ?? null }) } };
        } else { skip(event.type); continue; }
        const at = event.origin_server_ts ?? 0, who = sender(event.sender);
        const body: Record<string, unknown> = { ...input.body, channel: "matrix", source: "backfill" };
        const thread = relation?.rel_type === "m.thread" && relation.event_id ? `${room}:${relation.event_id}` : room;
        const peer = item.class === "owner_dm" ? owner : item.class === "peer" ? [...new Set(store.get<{ members?: string[] }>("rooms", room)?.members ?? store.get<{ members?: string[] }>("room_info", room)?.members ?? [])]
          .find((member) => member !== agent.matrixId) ?? event.sender : event.sender;
        const session: { key: string; kind: SessionKind; label: string } = item.class === "owner_dm" ? { key: legacySession(agent.id, "owner-main"), kind: "owner_main", label: "owner-main" }
          : item.class === "peer" ? { key: legacySession(agent.id, key(connection, "direct", room, peer)), kind: "peer", label: `matrix:direct:${peer}` }
          : { key: legacySession(agent.id, key(connection, "group", thread, "group")), kind: "group", label: `matrix:group:${thread}` };
        const existing = ledger.session(session.key)?.lastSeq ?? 0;
        if (!touched.has(session.key)) touched.set(session.key, existing);
        ledger.ensureSession(session.key, session.kind, session.label, at);
        const conversationId = ledger.ensureConversation({ connectionId: connection, channel: "matrix", accountId: agent.matrixId,
          kind: item.class === "group" ? "group" : "direct", peerId: item.class === "group" ? room : peer, parentId: item.class === "group" ? "" : room,
          threadId: item.class === "group" && thread !== room ? thread : "", sessionKey: session.key, ...(item.class === "owner_dm" ? { personId: ownerPerson } : {}),
          replyRoute: { connectionId: connection, target: room, messageId: event.event_id, data: {} }, at }, item.class === "owner_dm" ? "participant" : "primary");
        const result = ledger.append(session.key, { ...input, ...who, conversationId, idempotencyKey: `${connection}:${event.event_id}`, createdAt: at, body });
        if (result.duplicate) { item.duplicate++; continue; }
        item.imported++; if (synapse) item.fromSynapse++;
        ledger.attachEvent(Array.isArray(body.attachments) ? (body.attachments as Array<{ attachmentId: string }>).map((value) => value.attachmentId) : [], result.event.eventId);
        ledger.indexPlatform(connection, [event.event_id], result.event.eventId);
      }
      // A session that already had events now has older history: rewrite its order, bump its generation.
      for (const [sessionKey, before] of touched) if (before > 0 && (ledger.session(sessionKey)?.lastSeq ?? 0) > before) {
        ledger.resequence(sessionKey); report.resequenced.push(sessionKey);
      }
      link(store, ledger, connection, agent, report);
      report.rooms = [...roomReports.values()];
      if (!options.dryRun) store.set("meta", "ledger_backfill", { at: new Date().toISOString(), counts: {
        imported: report.rooms.reduce((total, room) => total + room.imported, 0), rooms: report.rooms.length, ...report.linked, unmatched: report.unmatched } });
    };
    try { store.transaction(() => hub.store.transaction(() => { work(); if (options.dryRun) throw new DryRun(); })); }
    catch (error) { if (!(error instanceof DryRun)) throw error; }
    return report;
  } finally { store.releaseLease(lease); store.close(); }
}

/** Section 10 step 5: attach legacy inbox/outbox/question records to the imported events. */
function link(store: DurableStore, ledger: AgentLedger, connection: string, agent: ManagedAgent, report: AgentReport) {
  const work = new CliWork(store, () => "allow");
  const state = (taskId: string): TurnState => { try { return turnStates[work.inspect(taskId).status] ?? "unknown"; } catch { return "unknown"; } };
  for (const { value } of store.entries<InboxRecord>("communication_inbox")) {
    if (value.connectionId !== connection) continue;
    const eventId = ledger.platformEvent(connection, value.source.externalId), event = eventId ? ledger.event(eventId) : undefined;
    if (!event) { report.unmatched.inbox++; continue; }
    if (!ledger.claimFor(connection, value.source.externalId)) {
      ledger.claim({ connectionId: connection, externalId: value.source.externalId, inputId: value.id, hash: value.hash, at: Date.parse(value.receivedAt) || event.createdAt });
      ledger.settleClaim(connection, value.source.externalId, value.state === "ignored" ? "ignored" : "accepted", { eventId: event.eventId, ...(event.conversationId ? { conversationId: event.conversationId } : {}),
        ...(value.reason ? { reason: value.reason } : {}) });
    }
    if (!value.taskId) continue;
    const admission = value.source.scope === "group" ? "group" : event.senderType === "person" && ledger.session(event.sessionKey)?.kind === "owner_main" ? "owner" : "peer";
    if (!ledger.turn(value.taskId)) report.linked.turns++;
    ledger.ensureTurn({ turnId: value.taskId, sessionKey: event.sessionKey, admission, originConversationId: event.conversationId, originEventId: event.eventId,
      replyRoute: value.replyRoute, state: state(value.taskId), at: event.createdAt });
    ledger.annotate(event.eventId, { turnId: value.taskId });
    ledger.queueInput(value.id, event.sessionKey, event.eventId, event.createdAt);
    ledger.updateInput(value.id, "started", { turnId: value.taskId }, event.createdAt);
  }
  for (const { id, value } of store.entries<OutboxRecord>("communication_outbox")) {
    if (value.route.connectionId !== connection || !value.externalId || value.activity) continue;
    const ids = value.externalId.split(","), eventId = ledger.platformEvent(connection, ids[0]!), event = eventId ? ledger.event(eventId) : undefined;
    if (!event) { report.unmatched.outbox++; continue; }
    const turnId = value.taskId ?? value.originTaskId, final = Boolean(value.taskId && (value.final || id === digest(key(value.taskId, "final"))));
    ledger.annotate(event.eventId, { ...(turnId ? { turnId } : {}), ...(final ? { body: { final: true } } : {}) });
    ledger.indexPlatform(connection, ids, event.eventId);
    if (final && turnId && ledger.turn(turnId)) ledger.linkFinal(turnId, event.eventId);
    if (!ledger.delivery(id)) report.linked.deliveries++;
    ledger.createDelivery({ deliveryId: id, eventId: event.eventId, conversationId: event.conversationId ?? "", connectionId: connection,
      route: { ...value.route, channel: "matrix" }, purpose: final ? "reply" : value.content ? "content" : "notice", status: "sent", platformMessageId: value.externalId, at: event.createdAt });
  }
  for (const { value } of store.entries<{ call: { id: string; runId: string; deadlineAt: string }; taskId: string; noticeId: string; closed: boolean }>("communication_questions")) {
    if (value.closed) continue;
    const notice = store.get<OutboxRecord>("communication_outbox", value.noticeId);
    const eventId = notice?.externalId ? ledger.platformEvent(connection, notice.externalId.split(",")[0]!) : undefined, event = eventId ? ledger.event(eventId) : undefined;
    const run = store.entries<RunBinding>("communication_runs").map(({ value: binding }) => binding).find((binding) => binding.runId === value.call.runId);
    if (!event || !run) continue;
    const cardId = `cd_${digest(key(value.call.runId, value.call.id)).slice(0, 40)}`;
    if (!ledger.card(cardId)) report.linked.cards++;
    const deadline = Date.parse(value.call.deadlineAt);
    ledger.addCard({ cardId, callId: value.call.id, runId: value.call.runId, claimId: run.claimId, turnId: value.taskId, sessionKey: event.sessionKey,
      eventId: event.eventId, kind: value.call.id.startsWith("mau-approval:") ? "connector_approval" : "question", deadlineAt: Number.isFinite(deadline) ? deadline : null, at: event.createdAt });
  }
  void agent;
}
