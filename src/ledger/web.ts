import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { digest } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import { LIMITS, type HubSocket, type OwnerHubs } from "./hub.js";
import { personId, type PersonRegistry } from "./registry.js";

export interface OwnerPrincipal { personId: string; ownerId: string; matrixUserId: string }
/** ADR 0005 section 8.1. Phase 6 adds a native implementation beside Synapse whoami. */
export interface OwnerAuthenticator { authenticate(token: string): Promise<OwnerPrincipal> }
/** Wraps the service's whoami check and caches the result for 60 s by token hash. Tokens are never stored. */
export class SynapseWhoamiAuthenticator implements OwnerAuthenticator {
  private readonly cache = new Map<string, { principal: OwnerPrincipal; expires: number }>();
  constructor(private readonly whoami: (token: string) => Promise<string>, private readonly ttlMs = 60_000) {}
  async authenticate(token: string): Promise<OwnerPrincipal> {
    const hash = digest(["owner-token", token]), now = Date.now(), cached = this.cache.get(hash);
    if (cached && cached.expires > now) return cached.principal;
    const ownerId = await this.whoami(token);
    const principal = { personId: personId(ownerId), ownerId, matrixUserId: ownerId };
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(hash, { principal, expires: now + this.ttlMs });
    return principal;
  }
}
export interface WebLedgerDependencies {
  hubs: OwnerHubs; persons: PersonRegistry; authenticator: OwnerAuthenticator;
  /** Opens the agent runtime (and so its ledger) when a chat names an agent that is not running yet. */
  open(agentId: string): Promise<void>;
  owned(ownerId: string): Array<{ id: string; name: string }>;
  debug(agentId: string): Record<string, unknown>;
}
const bearer = (req: IncomingMessage) => req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "";
const features = { history: true, send: false, cards: false, attachments: false, reset: false, groups: false };
const limits = { textBytes: 24_000, eventBytes: 256 * 1024, historyPage: LIMITS.pageEvents, historyBytes: LIMITS.pageBytes,
  attachmentBytes: 25 * 1024 * 1024, attachmentsPerMessage: 10, socketsPerPerson: 10, features };
const seq = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const historyQuery = z.object({ before: seq.optional(), after: seq.optional(), generation: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageEvents).default(50), strict: z.enum(["true", "false"]).optional() }).strict()
  .refine((query) => query.before === undefined || query.after === undefined, "before_and_after_are_exclusive");
const agentOf = (chatId: string) => /^(?:dm|obs):([^:]+)/.exec(chatId)?.[1];

/** Single-use socket tickets (60 s), kept in memory only. */
class Tickets {
  private readonly tickets = new Map<string, { principal: OwnerPrincipal; token: string; expires: number }>();
  issue(principal: OwnerPrincipal, token: string) {
    const now = Date.now();
    for (const [id, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(id);
    const ticket = `tk_${randomBytes(24).toString("base64url")}`, expires = now + 60_000;
    this.tickets.set(digest(ticket), { principal, token, expires });
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }
  consume(ticket: string) {
    const id = digest(ticket), entry = this.tickets.get(id);
    this.tickets.delete(id);
    return entry && entry.expires > Date.now() ? entry : undefined;
  }
}

/**
 * Read-only web channel API (ADR 0005 phase 2): chat index, history, read markers, turn detail and the event socket.
 * Sending, reset, cards, attachments and groups arrive in later phases; `GET /me` reports them as disabled features.
 */
export function createWebLedger(dependencies: WebLedgerDependencies) {
  const { hubs, persons, authenticator } = dependencies, tickets = new Tickets(), epoch = `ep_${randomBytes(8).toString("hex")}`;
  const router = express.Router();
  router.use(async (req, res, next) => {
    try { res.locals.principal = await authenticator.authenticate(bearer(req)); next(); } catch (error) { next(error); }
  });
  const principal = (res: express.Response) => res.locals.principal as OwnerPrincipal;
  const hub = (res: express.Response) => hubs.hub(principal(res).ownerId);
  const chat = async (res: express.Response, chatId: string) => {
    const agentId = agentOf(chatId);
    if (!agentId || !dependencies.owned(principal(res).ownerId).some((agent) => agent.id === agentId)) throw new WorkError("chat_not_found", 404);
    await dependencies.open(agentId);
    return hub(res);
  };
  router.get("/me", (_req, res) => {
    const { personId: id, ownerId } = principal(res);
    res.json({ person: { id, name: persons.person(id)?.displayName ?? ownerId }, ownerId, identities: persons.identities(id), limits });
  });
  router.post("/socket-tickets", (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.set("Cache-Control", "no-store").json(tickets.issue(principal(res), bearer(req)));
  });
  router.get("/chats", (req, res) => {
    const query = z.object({ archived: z.enum(["true", "false"]).default("false"), cursor: z.string().regex(/^\d{1,9}$/).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50) }).strict().parse(req.query);
    res.json(hub(res).chats(principal(res).personId, { archived: query.archived === "true", cursor: query.cursor, limit: query.limit }));
  });
  router.get("/chats/:chatId", async (req, res) => {
    const target = await chat(res, req.params.chatId);
    const summary = target.summary(req.params.chatId, principal(res).personId);
    if (!summary) throw new WorkError("chat_not_found", 404);
    res.json({ ...summary, members: [{ type: "person", id: principal(res).personId, name: persons.person(principal(res).personId)?.displayName ?? principal(res).ownerId },
      ...summary.agentIds.map((id) => ({ type: "agent", id, name: dependencies.owned(principal(res).ownerId).find((agent) => agent.id === id)?.name ?? id }))] });
  });
  router.get("/chats/:chatId/events", async (req, res) => {
    const query = historyQuery.parse(req.query);
    res.json((await chat(res, req.params.chatId)).page(req.params.chatId, { ...query, strict: query.strict === "true" }));
  });
  router.post("/chats/:chatId/read", async (req, res) => {
    const body = z.object({ seq }).strict().parse(req.body);
    res.json((await chat(res, req.params.chatId)).read(req.params.chatId, principal(res).personId, body.seq));
  });
  router.get("/chats/:chatId/turns/:turnId", async (req, res) => res.json((await chat(res, req.params.chatId)).turn(req.params.chatId, req.params.turnId)));
  /** Phase 1 diffing aid: ledger counts beside the legacy and Matrix mirror counts, per owned agent. */
  router.get("/debug/ledger", async (_req, res) => {
    const data = [];
    for (const agent of dependencies.owned(principal(res).ownerId)) { await dependencies.open(agent.id); data.push({ agentId: agent.id, ...dependencies.debug(agent.id) }); }
    res.json({ data });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const live = new Set<WebSocket>();
  const frame = z.discriminatedUnion("method", [
    z.object({ type: z.literal("req"), id: z.string().max(64), method: z.literal("subscribe"), params: z.object({
      chats: z.array(z.object({ chatId: z.string().min(1).max(512), afterSeq: z.number().int().min(0).optional(), generation: z.number().int().min(1).optional() }).strict()).max(LIMITS.subscriptions).default([]),
      index: z.boolean().optional() }).strict() }).strict(),
    z.object({ type: z.literal("req"), id: z.string().max(64), method: z.literal("unsubscribe"), params: z.object({ chatIds: z.array(z.string().max(512)).max(LIMITS.subscriptions) }).strict() }).strict(),
  ]);
  /** HTTP upgrade for `/_agent-router/v1/web/socket?ticket=…`. Returns false for other paths. */
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(req.url ?? "/", "http://router.invalid");
    if (url.pathname !== "/_agent-router/v1/web/socket") return false;
    const ticket = tickets.consume(url.searchParams.get("ticket") ?? "");
    if (!ticket) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return true; }
    sockets.handleUpgrade(req, socket, head, (ws) => connect(ws, ticket.principal, ticket.token));
    return true;
  };
  const connect = (ws: WebSocket, owner: OwnerPrincipal, token: string) => {
    const target = hubs.hub(owner.ownerId);
    live.add(ws);
    const client: HubSocket = { personId: owner.personId, index: false, subscriptions: new Map(), send: (data) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > 1024 * 1024) { ws.close(4408, "backpressure"); return; }
      ws.send(JSON.stringify(data));
    } };
    const open = [...target.sockets].filter((item) => item.personId === owner.personId).length;
    if (open >= limits.socketsPerPerson) { ws.close(4429, "too_many_sockets"); return; }
    target.sockets.add(client);
    // The bearer is re-checked every 10 minutes; a revoked session closes the socket.
    const recheck = setInterval(() => { authenticator.authenticate(token).catch(() => ws.close(4401, "token_invalid")); }, 600_000);
    recheck.unref();
    ws.on("close", () => { clearInterval(recheck); target.sockets.delete(client); live.delete(ws); });
    ws.on("message", (raw, binary) => {
      const text = raw.toString();
      if (!binary && text === "ping") { ws.send("pong"); return; }
      let id = "";
      try {
        const parsed = JSON.parse(text) as { id?: unknown };
        id = typeof parsed.id === "string" ? parsed.id : "";
        const request = frame.parse(parsed);
        if (request.method === "unsubscribe") { target.unsubscribe(client, request.params.chatIds); ws.send(JSON.stringify({ type: "res", id, ok: true, result: {} })); return; }
        for (const item of request.params.chats) {
          const agentId = agentOf(item.chatId);
          if (!agentId || !dependencies.owned(owner.ownerId).some((agent) => agent.id === agentId)) throw new WorkError("chat_not_found", 404);
        }
        const subscribed = target.subscribe(client, request.params.chats, request.params.index);
        ws.send(JSON.stringify({ type: "res", id, ok: true, result: subscribed.result }));
        subscribed.then();
      } catch (error) {
        const code = error instanceof WorkError ? error.message : error instanceof z.ZodError || error instanceof SyntaxError ? "invalid_request" : "operation_failed";
        ws.send(JSON.stringify({ type: "res", id, ok: false, error: { code } }));
      }
    });
    client.send({ type: "event", event: "hello", data: { socketId: `so_${randomBytes(8).toString("hex")}`, epoch, heartbeatMs: 30_000,
      limits: { maxSubscriptions: LIMITS.subscriptions, maxReplayEvents: LIMITS.socketReplayEvents } } });
  };
  const close = () => { for (const ws of live) ws.close(1012, "restart"); sockets.close(); };
  return { router, upgrade, close };
}
