import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableStore } from "../communication/store.js";
import { digest, key } from "../execution/protocol.js";
import type { ManagedAgent } from "../matrix/managed.js";
import type { RoomEvent } from "../matrix/protocol.js";
import type { TimelineEntry } from "../matrix/social.js";
import type { HistoryPort } from "./backfill.js";
import { OwnerHubs } from "./hub.js";
import { AgentLedger, legacySession } from "./ledger.js";
import { personId } from "./registry.js";
import type { RoomAppend } from "./rooms.js";

/** Sends one Matrix event as the agent's virtual user; returns the event id. */
export type NoticePort = (room: string, type: string, content: Record<string, unknown>, txnId: string) => Promise<string>;
export interface ImportRoomsOptions {
  stateDir: string; ownerId?: string | undefined; dryRun?: boolean | undefined;
  /** Synapse `/messages` as an agent's virtual user (AS token). Without it only the agents' `timeline` mirrors are read. */
  history?: ((agent: ManagedAgent) => HistoryPort | undefined) | undefined;
  /** Sends the final notice as an agent. Without it the notice is reported as `pending`. */
  notice?: ((agent: ManagedAgent) => NoticePort | undefined) | undefined;
  maxPages?: number | undefined;
  now?: number | undefined;
}
export type RoomDecision = "import" | "skip:has_outsiders" | "skip:not_group" | "skip:unknown_members";
export interface ImportedRoom {
  matrixRoomId: string; decision: RoomDecision; roomId?: string; title?: string; agents?: string[];
  imported?: number; fromSynapse?: number; sessions?: Array<{ agentId: string; sessionKey: string; existed: boolean }>;
  notice?: "sent" | "already_sent" | "pending";
}
export interface ImportRoomsReport { dryRun: boolean; owners: Array<{ ownerId: string; rooms: ImportedRoom[] }> }
export const MIGRATED_NOTICE = "此群聊已迁移到 Mau 网页端，这里的新消息不会再被处理。";
interface Migration { roomId: string; at: string; noticeEventId?: string }

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
 * ADR 0005 section 17.6: import the owner's `ai.mau.room` Matrix groups into hub rooms, keep each agent's session,
 * freeze the Matrix room and post one final notice. Idempotent; a rerun imports what arrived before the freeze.
 * Run with the Router service stopped (it takes the agent store leases) and Synapse running.
 */
export async function importRooms(options: ImportRoomsOptions): Promise<ImportRoomsReport> {
  const registryPath = join(options.stateDir, "registry.sqlite");
  if (!existsSync(registryPath)) throw new Error("registry_not_found");
  const registry = new DurableStore(registryPath, storeIdentity(registryPath));
  const all = registry.entries<ManagedAgent>("agents").map(({ value }) => value).filter((agent) => agent.status !== "deleting");
  const hubs = new OwnerHubs(options.stateDir, { owns: (owner, agentId) => all.some((agent) => agent.id === agentId && agent.owner === owner),
    agentName: (id) => all.find((agent) => agent.id === id)?.name ?? id, ledger: () => undefined, personName: () => undefined });
  const report: ImportRoomsReport = { dryRun: Boolean(options.dryRun), owners: [] };
  try {
    const owners = options.ownerId ? [options.ownerId] : [...new Set(all.map((agent) => agent.owner))];
    if (options.ownerId && !all.some((agent) => agent.owner === options.ownerId)) throw new Error("owner_not_found");
    for (const owner of owners) report.owners.push({ ownerId: owner, rooms: await importOwner(options, registry, hubs, owner, all.filter((agent) => agent.owner === owner)) });
    return report;
  } finally { hubs.close(); registry.close(); }
}

async function importOwner(options: ImportRoomsOptions, registry: DurableStore, hubs: OwnerHubs, owner: string, agents: ManagedAgent[]): Promise<ImportedRoom[]> {
  const lease = `ledger-import-rooms-${process.pid}`, stores = new Map<string, DurableStore>();
  const byMatrix = new Map(agents.map((agent) => [agent.matrixId, agent]));
  const ownerPerson = personId(owner), now = options.now ?? Date.now();
  try {
    for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
      const path = join(options.stateDir, "agents", `${agent.id}.sqlite`);
      if (!existsSync(path)) continue;
      const store = new DurableStore(path, agent.matrixId);
      stores.set(agent.id, store);
      store.acquireLease(lease); // Refuses while the service runs this agent.
    }
    // Every Matrix room an agent knows, with its membership and the ai.mau.room marker.
    const rooms = new Map<string, { members: Set<string>; group: boolean; known: boolean; title?: string }>();
    for (const store of stores.values()) {
      for (const { id, value } of store.entries<{ members?: string[]; group?: boolean }>("rooms")) {
        const item = rooms.get(id) ?? { members: new Set<string>(), group: false, known: false };
        for (const member of value.members ?? []) item.members.add(member);
        item.group ||= Boolean(value.group); item.known ||= Boolean(value.members?.length);
        const name = store.get<{ name?: string }>("room_info", id)?.name; if (name && !item.title) item.title = name;
        rooms.set(id, item);
      }
    }
    const hub = hubs.hub(owner), results: ImportedRoom[] = [];
    for (const [matrixRoomId, info] of [...rooms].sort(([a], [b]) => a.localeCompare(b))) {
      const decision: RoomDecision = !info.group ? "skip:not_group" : !info.known ? "skip:unknown_members"
        : [...info.members].some((member) => member !== owner && !byMatrix.has(member)) ? "skip:has_outsiders" : "import";
      const members = [...info.members].filter((member) => byMatrix.has(member)).map((member) => byMatrix.get(member)!).sort((a, b) => a.id.localeCompare(b.id));
      const result: ImportedRoom = { matrixRoomId, decision };
      results.push(result);
      if (decision !== "import") continue;
      const title = info.title || matrixRoomId;
      Object.assign(result, { title, agents: members.map((agent) => agent.id) });
      if (options.dryRun) continue;
      // 1. Hub room (id derived from the Matrix room id, as the phase 1 backfill does).
      const roomId = hub.importRoom(matrixRoomId, title, [{ type: "person", id: ownerPerson }, ...members.map((agent) => ({ type: "agent" as const, id: agent.id }))], now);
      result.roomId = roomId;
      // 2. History: the agents' timeline mirrors, then Synapse pages back to the first event the hub already has.
      const known = (eventId: string) => Boolean(hub.rooms.eventByKey(roomId, `matrix:${eventId}`));
      const found = new Map<string, { event: RoomEvent & { origin_server_ts?: number }; synapse: boolean }>();
      for (const agent of members) for (const { value } of stores.get(agent.id)?.entries<TimelineEntry>("timeline") ?? [])
        if (value.room === matrixRoomId && value.event.event_id && !known(value.event.event_id)) found.set(value.event.event_id, { event: value.event, synapse: false });
      const port = members.map((agent) => options.history?.(agent)).find(Boolean);
      if (port) {
        let from: string | undefined;
        pages: for (let page = 0; page < (options.maxPages ?? 1000); page++) {
          const result = await port(matrixRoomId, from);
          for (const event of result.events) {
            if (!event.event_id) continue;
            if (known(event.event_id)) break pages;
            if (!found.has(event.event_id)) found.set(event.event_id, { event, synapse: true });
          }
          if (!result.end || !result.events.length || result.end === from) break;
          from = result.end;
        }
      }
      const ordered = [...found.values()].sort((a, b) => (a.event.origin_server_ts ?? 0) - (b.event.origin_server_ts ?? 0));
      let imported = 0, fromSynapse = 0;
      hub.store.transaction(() => {
        for (const { event, synapse } of ordered) {
          const input = convert(event, owner, ownerPerson, byMatrix); if (!input) continue;
          if (!hub.rooms.append(roomId, input).duplicate) { imported++; if (synapse) fromSynapse++; }
        }
      });
      Object.assign(result, { imported, fromSynapse });
      // 3. Session continuity: each agent's Matrix group session becomes its room session; the cursor starts at the end.
      const lastSeq = hub.rooms.position(`room:${roomId}`).lastSeq, sessions: NonNullable<ImportedRoom["sessions"]> = [];
      for (const agent of members) {
        const store = stores.get(agent.id); if (!store) continue;
        const ledger = AgentLedger.open(store), connection = matrixConnection(options.stateDir, agent.id);
        const sessionKey = legacySession(agent.id, key(connection, "group", matrixRoomId, "group")), existed = Boolean(ledger.session(sessionKey));
        store.transaction(() => {
          ledger.ensureSession(sessionKey, "room", `room:${roomId}`, now, roomId);
          store.db.prepare("UPDATE ledger_sessions SET kind='room', room_id=?, label=? WHERE session_key=?").run(roomId, `room:${roomId}`, sessionKey);
        });
        hub.rooms.moveCursor(roomId, agent.id, lastSeq);
        sessions.push({ agentId: agent.id, sessionKey, existed });
      }
      result.sessions = sessions;
      hub.rooms.index(roomId);
      // 4. Freeze: MatrixChannel claims later messages of this room as ignored (room_migrated).
      const prior = registry.get<Migration>("matrix_room_migrations", matrixRoomId);
      const migration: Migration = prior ?? { roomId, at: new Date(now).toISOString() };
      if (!prior) registry.set("matrix_room_migrations", matrixRoomId, migration);
      // 5. Final notice from the member agent with the lowest id; its transaction id makes a rerun harmless.
      if (migration.noticeEventId) { result.notice = "already_sent"; continue; }
      const sender = members[0], send = sender ? options.notice?.(sender) : undefined;
      if (!send) { result.notice = "pending"; continue; }
      const eventId = await send(matrixRoomId, "m.room.message", { msgtype: "m.notice", body: MIGRATED_NOTICE }, digest(["room-migrated", matrixRoomId]));
      registry.set("matrix_room_migrations", matrixRoomId, { ...migration, noticeEventId: eventId });
      result.notice = "sent";
    }
    return results;
  } finally {
    for (const store of stores.values()) { try { store.releaseLease(lease); } catch { /* Expires on its own. */ } store.close(); }
  }
}

/** Matrix event → room event (messages, notices, names and memberships; other events are not part of a room transcript). */
function convert(event: RoomEvent & { origin_server_ts?: number }, owner: string, ownerPerson: string, agents: Map<string, ManagedAgent>): RoomAppend | undefined {
  const content = event.content ?? {}, at = event.origin_server_ts ?? 0;
  const agent = agents.get(event.sender);
  const who: Pick<RoomAppend, "role" | "senderType" | "senderId"> = agent ? { role: "assistant", senderType: "agent", senderId: agent.id }
    : event.sender === owner ? { role: "user", senderType: "person", senderId: ownerPerson } : { role: "user", senderType: "external", senderId: event.sender };
  const base = { ...who, idempotencyKey: `matrix:${event.event_id}`, createdAt: at };
  if (event.state_key !== undefined) {
    if (event.type === "m.room.name") return { ...base, kind: "member", role: "system", body: { action: "rename", title: String(content.name ?? ""), channel: "matrix", source: "import" } };
    if (event.type !== "m.room.member") return undefined;
    const membership = String(content.membership ?? ""); if (!["join", "leave", "ban"].includes(membership)) return undefined;
    const target = agents.get(event.state_key);
    return { ...base, kind: "member", role: "system", body: { action: membership === "join" ? "add" : "remove", channel: "matrix", source: "import",
      member: { type: target ? "agent" : event.state_key === owner ? "person" : "external", id: target?.id ?? (event.state_key === owner ? ownerPerson : event.state_key),
        name: target?.name ?? String(content.displayname ?? event.state_key) } } };
  }
  if (event.type !== "m.room.message") return undefined;
  const relation = content["m.relates_to"] as { rel_type?: string } | undefined;
  if (relation?.rel_type === "m.replace") return undefined;
  const media = typeof content.url === "string", name = String(content.body ?? "attachment");
  const mime = (content.info as { mimetype?: string } | undefined)?.mimetype ?? "application/octet-stream";
  return { ...base, kind: "message", body: { text: media ? "" : String(content.body ?? ""), ...(content.msgtype === "m.notice" ? { notice: true } : {}),
    ...(media ? { attachments: [{ name, contentType: mime }] } : {}), ...(Object.keys(content).length ? {} : { redacted: true }), channel: "matrix", source: "import",
    ...(agent ? { agentId: agent.id } : {}) } };
}
