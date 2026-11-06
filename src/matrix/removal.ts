import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableStore } from "../communication/store.js";
import { mediaContent } from "../communication/media.js";
import type { AttachmentReference } from "../communication/types.js";
import { AgentLedger } from "../ledger/ledger.js";
import { OwnerHubs } from "../ledger/hub.js";
import { OwnerAttachments } from "../ledger/blobs-hub.js";
import type { BlobStore } from "../ledger/blobs.js";
import { personId } from "../ledger/registry.js";
import type { ManagedAgent, MatrixState } from "./managed.js";

/**
 * Offline tooling for the removal of Synapse (ADR 0005 section 19.4): `ledger promote-media` (item 6), `matrix export`
 * (item 7, with the final consistency report) and `matrix forget` (item 14). Every command takes the agent store leases,
 * so it refuses while the Router service runs those agents.
 */

/** Reads one `mxc://` URI as an agent's virtual user (Application Service token). */
export type MediaReader = (agent: ManagedAgent) => (uri: string) => Promise<Buffer>;
interface Row { attachment_id: string; event_id: string | null; name: string; content_type: string; locator: string }
type ChannelLocator = AttachmentReference & { connectionId: string };

function storeIdentity(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return JSON.parse(String(db.prepare("SELECT value FROM documents WHERE collection='meta' AND id='identity'").get()?.value ?? "null")) as string; }
  finally { db.close(); }
}
function openRegistry(stateDir: string): DurableStore {
  const path = join(stateDir, "registry.sqlite");
  if (!existsSync(path)) throw new Error("registry_not_found");
  return new DurableStore(path, storeIdentity(path));
}
/** Every Matrix connection id configured for the agent (`matrix` when none is configured, as the import assumes). */
function matrixConnections(stateDir: string, agentId: string): Set<string> {
  const file = join(stateDir, "connections", "agents", agentId, "channels.json");
  if (!existsSync(file)) return new Set(["matrix"]);
  const config = JSON.parse(readFileSync(file, "utf8")) as { agents?: Array<{ connections?: Array<{ id: string; kind: string }> }> };
  const ids = (config.agents ?? []).flatMap((agent) => agent.connections ?? []).filter((item) => item.kind === "matrix").map((item) => item.id);
  return new Set(ids.length ? ids : ["matrix"]);
}
const stateOf = (agent: ManagedAgent): MatrixState => agent.matrix ?? "active";

/** Opens the selected agents' stores under one lease; `work` runs with them, the leases are always released. */
async function withAgents<T>(stateDir: string, selection: { agentId?: string | undefined; all?: boolean | undefined }, lease: string,
  work: (registry: DurableStore, agents: Array<{ agent: ManagedAgent; store: DurableStore | undefined }>) => Promise<T>): Promise<T> {
  const registry = openRegistry(stateDir);
  const opened: DurableStore[] = [];
  try {
    const all = registry.entries<ManagedAgent>("agents").map(({ value }) => value).filter((agent) => agent.status !== "deleting");
    const selected = selection.agentId ? all.filter((agent) => agent.id === selection.agentId) : all;
    if (selection.agentId && !selected.length) throw new Error("agent_not_found");
    const agents = selected.map((agent) => {
      const path = join(stateDir, "agents", `${agent.id}.sqlite`);
      if (!existsSync(path)) return { agent, store: undefined };
      const store = new DurableStore(path, agent.matrixId);
      opened.push(store);
      store.acquireLease(lease); // Refuses while the service runs this agent.
      return { agent, store };
    });
    return await work(registry, agents);
  } finally {
    for (const store of opened) { try { store.releaseLease(lease); } catch { /* Expires on its own. */ } store.close(); }
    registry.close();
  }
}

function channelRows(ledger: AgentLedger, connections: Set<string>): Array<{ row: Row; locator: ChannelLocator }> {
  return (ledger.store.db.prepare("SELECT attachment_id,event_id,name,content_type,locator FROM ledger_attachments WHERE locator LIKE '%\"channel\"%'").all() as unknown as Row[])
    .flatMap((row) => {
      const locator = (JSON.parse(row.locator) as { channel?: ChannelLocator }).channel;
      return locator && connections.has(locator.connectionId) && typeof locator.id === "string" && locator.id.startsWith("mxc://") ? [{ row, locator }] : [];
    });
}

export interface PromoteMediaReport {
  dryRun: boolean;
  agents: Array<{ agentId: string; owner: string; candidates: number; promoted: number; failed: Array<{ attachmentId: string; error: string }>; remaining: number }>;
  /** Item 6 check: Matrix channel locators left in all selected ledgers; must be zero before `media_store` is deleted. */
  remaining: number;
}
/**
 * `ledger promote-media (--agent <id> | --all) --channel matrix [--dry-run]`: copy every `mxc://` attachment referenced by the
 * agent ledgers into the blob store and rewrite its locator to the blob. Idempotent: promoted rows have no channel locator.
 */
export async function promoteMedia(options: { stateDir: string; agentId?: string | undefined; all?: boolean | undefined; dryRun?: boolean | undefined;
  store: BlobStore; read?: MediaReader | undefined; now?: number | undefined }): Promise<PromoteMediaReport> {
  if (!options.dryRun && !options.read) throw new Error("matrix_media_reader_required");
  return withAgents(options.stateDir, options, `ledger-promote-media-${process.pid}`, async (_registry, agents) => {
    const ledgers = new Map<string, AgentLedger>();
    const hubs = new OwnerHubs(options.stateDir, { owns: (owner, id) => agents.some(({ agent }) => agent.id === id && agent.owner === owner),
      agentName: (id) => agents.find(({ agent }) => agent.id === id)?.agent.name ?? id, ledger: (id) => ledgers.get(id), personName: () => undefined });
    const attachments = new OwnerAttachments({ hubs, store: options.store, owned: (owner) => agents.filter(({ agent }) => agent.owner === owner).map(({ agent }) => agent),
      open: async () => undefined, ledger: (id) => ledgers.get(id), tempDir: join(options.stateDir, "tmp", "uploads") });
    const report: PromoteMediaReport = { dryRun: Boolean(options.dryRun), agents: [], remaining: 0 };
    try {
      for (const { agent, store } of agents) {
        if (!store) continue;
        const ledger = AgentLedger.open(store); ledgers.set(agent.id, ledger);
        const connections = matrixConnections(options.stateDir, agent.id), rows = channelRows(ledger, connections);
        const item = { agentId: agent.id, owner: agent.owner, candidates: rows.length, promoted: 0, failed: [] as Array<{ attachmentId: string; error: string }>, remaining: 0 };
        if (!options.dryRun) {
          const read = options.read!(agent);
          for (const { row, locator } of rows) {
            try {
              const media = mediaContent(locator.name || row.name, locator.mediaType || row.content_type, await read(locator.id));
              await attachments.storePromoted(agent.owner, agent.id, ledger, row.attachment_id, media, row.name, options.now);
              item.promoted++;
            } catch (error) { item.failed.push({ attachmentId: row.attachment_id, error: error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "promotion_failed" }); }
          }
        }
        item.remaining = channelRows(ledger, connections).length;
        report.remaining += item.remaining;
        report.agents.push(item);
      }
    } finally { hubs.close(); }
    return report;
  });
}

interface RoomInfo { members?: string[]; group?: boolean; encrypted?: boolean }
export interface MatrixManifest {
  exportedAt: string; serverName: string | null;
  agents: Array<{ id: string; owner: string; name: string; address: string; matrixId: string; state: MatrixState }>;
  owners: string[];
  /** `group` marks `ai.mau.room` groups; they are not migrated, their history stays in the Synapse archive (item 8). */
  rooms: Array<{ roomId: string; name: string | null; members: string[]; group: boolean; agents: string[];
    conversations: Array<{ agentId: string; conversationId: string; sessionKey: string; kind: string }>;
    events: { timeline: number; ledger: number } }>;
  orphans: Array<{ matrixId: string; agentId: string; owner: string; deletedAt: string }>;
}
export interface ConsistencyReport {
  /** True when every blocking check passes; `warnings` still need an operator decision (item 4). */
  ready: boolean;
  blocking: { unpromotedMedia: number; unmatchedTimelineEvents: number; agentsWithoutBackfill: string[];
    ownersWithoutEdgeLogin: string[]; queuedMatrixSends: number };
  /** `matrixGroups`: `ai.mau.room` groups, not migrated by product decision; listed so the operator can confirm. */
  warnings: { liveMatrixSessions: Array<{ agentId: string; sessionKey: string; kind: string; lastInboundAt: string }>;
    matrixGroups: string[] };
}
const DAY = 86_400_000;

/**
 * `matrix export (--agent <id> | --all) --out <dir>` (item 7): writes `manifest.json` (agents, owners, rooms, room →
 * conversation and hub room mappings, per-room event counts) and `report.json`, the final consistency report to read
 * before Synapse is removed. Read-only.
 */
export async function exportMatrix(options: { stateDir: string; agentId?: string | undefined; all?: boolean | undefined; out?: string | undefined;
  now?: number | undefined }): Promise<{ manifest: MatrixManifest; report: ConsistencyReport }> {
  const now = options.now ?? Date.now();
  return withAgents(options.stateDir, options, `matrix-export-${process.pid}`, async (registry, agents) => {
    const rooms = new Map<string, MatrixManifest["rooms"][number]>();
    const report: ConsistencyReport = { ready: false, blocking: { unpromotedMedia: 0, unmatchedTimelineEvents: 0, agentsWithoutBackfill: [],
      ownersWithoutEdgeLogin: [], queuedMatrixSends: 0 }, warnings: { liveMatrixSessions: [], matrixGroups: [] } };
    const room = (roomId: string) => {
      let item = rooms.get(roomId);
      if (!item) { item = { roomId, name: null, members: [], group: false, agents: [], conversations: [], events: { timeline: 0, ledger: 0 } }; rooms.set(roomId, item); }
      return item;
    };
    for (const { agent, store } of agents) {
      if (!store || stateOf(agent) === "none") continue;
      const ledger = AgentLedger.open(store), connections = matrixConnections(options.stateDir, agent.id);
      for (const { id, value } of store.entries<RoomInfo>("rooms")) {
        const item = room(id);
        item.members = [...new Set([...item.members, ...(value.members ?? [])])].sort();
        item.group ||= Boolean(value.group);
        if (!item.agents.includes(agent.id)) item.agents.push(agent.id);
        item.name ??= store.get<{ name?: string }>("room_info", id)?.name ?? null;
      }
      // Timeline mirror vs ledger: a Matrix message is matched by its ingress claim. `ai.mau.room` groups are not migrated.
      const claimed = new Set((store.db.prepare("SELECT connection_id, external_id FROM ledger_ingress").all() as Array<{ connection_id: string; external_id: string }>)
        .filter((row) => connections.has(row.connection_id)).map((row) => row.external_id));
      for (const { value } of store.entries<{ room: string; event: { event_id: string; type: string; sender: string } }>("timeline")) {
        const item = room(value.room); item.events.timeline++;
        if (value.event.type !== "m.room.message" || value.event.sender === agent.matrixId || claimed.has(value.event.event_id) || item.group) continue;
        report.blocking.unmatchedTimelineEvents++;
      }
      const conversations = store.db.prepare("SELECT c.conversation_id, c.session_key, c.kind, c.reply_route, c.connection_id, s.kind AS session_kind, c.last_inbound_at FROM ledger_conversations c LEFT JOIN ledger_sessions s ON s.session_key=c.session_key WHERE c.channel='matrix'").all() as Array<Record<string, string | number | null>>;
      for (const row of conversations) {
        const target = (JSON.parse(String(row.reply_route)) as { target?: string }).target;
        if (target) {
          const item = room(target);
          item.conversations.push({ agentId: agent.id, conversationId: String(row.conversation_id), sessionKey: String(row.session_key), kind: String(row.kind) });
          item.events.ledger += Number(store.db.prepare("SELECT COUNT(*) AS n FROM ledger_events WHERE conversation_id=?").get(String(row.conversation_id))!.n);
        }
        const kind = String(row.session_kind ?? "");
        if (["delegation", "peer", "group"].includes(kind) && Number(row.last_inbound_at ?? 0) > now - 30 * DAY)
          report.warnings.liveMatrixSessions.push({ agentId: agent.id, sessionKey: String(row.session_key), kind, lastInboundAt: new Date(Number(row.last_inbound_at)).toISOString() });
      }
      report.blocking.unpromotedMedia += channelRows(ledger, connections).length;
      if (!store.get("meta", "ledger_backfill") && store.entries("timeline").length) report.blocking.agentsWithoutBackfill.push(agent.id);
      report.blocking.queuedMatrixSends += store.entries<{ status: string }>("outbox").filter(({ value }) => value.status === "queued").length
        + store.entries<{ state: string; route: { connectionId: string } }>("communication_outbox").filter(({ value }) => value.state === "queued" && connections.has(value.route?.connectionId)).length;
    }
    for (const item of rooms.values()) {
      item.agents.sort();
      if (item.group) report.warnings.matrixGroups.push(item.roomId);
    }
    // Owners who have never signed in through the edge identity (item 3).
    const owners = [...new Set(agents.map(({ agent }) => agent.owner))].sort();
    let identities: Array<{ person_id: string; last_seen_at: number | null; created_at: number }> = [];
    try { identities = registry.db.prepare("SELECT person_id, last_seen_at, created_at FROM reg_person_identities WHERE provider='cloudflare-access' AND revoked_at IS NULL").all() as typeof identities; }
    catch { /* No identity table: no owner has signed in through the edge yet. */ }
    report.blocking.ownersWithoutEdgeLogin = owners.filter((owner) => !identities.some((row) => row.person_id === personId(owner)));
    const b = report.blocking;
    report.ready = !b.unpromotedMedia && !b.unmatchedTimelineEvents && !b.agentsWithoutBackfill.length && !b.ownersWithoutEdgeLogin.length && !b.queuedMatrixSends;
    const manifest: MatrixManifest = {
      exportedAt: new Date(now).toISOString(), serverName: agents[0]?.agent.owner.slice(agents[0].agent.owner.indexOf(":") + 1) ?? null,
      agents: agents.map(({ agent }) => ({ id: agent.id, owner: agent.owner, name: agent.name, address: agent.address, matrixId: agent.matrixId, state: stateOf(agent) })),
      owners, rooms: [...rooms.values()].sort((a, b) => a.roomId.localeCompare(b.roomId)),
      orphans: registry.entries<{ agentId: string; owner: string; deletedAt: string }>("matrix_orphans").map(({ id, value }) => ({ matrixId: id, ...value })),
    };
    if (options.out) {
      mkdirSync(options.out, { recursive: true, mode: 0o700 });
      writeFileSync(join(options.out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      writeFileSync(join(options.out, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    }
    return { manifest, report };
  });
}

export interface ForgetReport {
  dryRun: boolean;
  agents: Array<{ agentId: string; previous: MatrixState; documents: Record<string, number> }>;
  registry: Record<string, number>;
  /** Accounts of deleted agents that were not deactivated because Matrix was off (19.2). */
  orphans: string[];
}
const AGENT_COLLECTIONS = ["timeline", "room_info", "read_markers", "rooms"];
/**
 * `matrix forget --all [--dry-run]` (item 14): delete the Matrix mirrors from every agent store and the registry, and set
 * every agent to `matrix: "none"`. Run only after Synapse has been removed (or with `--dry-run` to count).
 */
export async function forgetMatrix(options: { stateDir: string; all?: boolean | undefined; agentId?: string | undefined; dryRun?: boolean | undefined }): Promise<ForgetReport> {
  return withAgents(options.stateDir, options, `matrix-forget-${process.pid}`, async (registry, agents) => {
    const report: ForgetReport = { dryRun: Boolean(options.dryRun), agents: [], registry: {}, orphans: registry.entries("matrix_orphans").map(({ id }) => id) };
    const count = (store: DurableStore, collection: string) => Number(store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE collection=?").get(collection)!.n);
    for (const { agent, store } of agents) {
      const documents: Record<string, number> = {};
      if (store) {
        for (const collection of AGENT_COLLECTIONS) documents[collection] = count(store, collection);
        documents["meta.sync"] = store.get("meta", "sync") === undefined ? 0 : 1;
        if (!options.dryRun) store.transaction(() => {
          for (const collection of AGENT_COLLECTIONS) store.db.prepare("DELETE FROM documents WHERE collection=?").run(collection);
          store.delete("meta", "sync");
        });
      }
      report.agents.push({ agentId: agent.id, previous: stateOf(agent), documents });
    }
    const queues = (registry.db.prepare("SELECT collection, COUNT(*) AS n FROM documents WHERE collection LIKE 'as_queue:%' GROUP BY collection").all() as Array<{ collection: string; n: number }>);
    report.registry.as_queue = queues.reduce((total, row) => total + Number(row.n), 0);
    for (const collection of ["as_members", "as_transactions", "matrix_agents", "matrix_orphans"]) report.registry[collection] = count(registry, collection);
    if (!options.dryRun) registry.transaction(() => {
      registry.db.prepare("DELETE FROM documents WHERE collection LIKE 'as_queue:%'").run();
      for (const collection of ["as_members", "as_transactions", "matrix_agents", "matrix_orphans"]) registry.db.prepare("DELETE FROM documents WHERE collection=?").run(collection);
      for (const { agent } of agents) registry.set("agents", agent.id, { ...registry.get<ManagedAgent>("agents", agent.id)!, matrix: "none" });
    });
    return report;
  });
}
