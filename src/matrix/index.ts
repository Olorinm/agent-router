import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import { agentCardHandler, jsonRpcHandler, restHandler, type UserBuilder } from "@a2a-js/sdk/server/express";
import { A2ABackend } from "./backend.js";
import { WorkError } from "./cli-work.js";
import { MatrixConnector, delay, type Contact } from "./connector.js";
import { MatrixA2AHandler, requestSignal } from "./gateway.js";
import { ConnectorStore } from "./store.js";
import { SdkMatrixTransport } from "./transport.js";
import { decodeRequest, mxid } from "./protocol.js";
import { ProfileStore, connectorAddress } from "./profile.js";
import { authError, profileClient } from "./auth.js";

function secret(name: string, required = true): string {
  const value = process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`]!, "utf8").trim() : process.env[name] ?? "";
  if (required && value.length < 16) throw new Error(`${name}_required`);
  return value;
}
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name}_required`); return value; }

export function createConnectorApp(connector: MatrixConnector, apiToken: string, publicBaseUrl: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use((_req, res, next) => {
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    requestSignal.run(abort.signal, next);
  });
  const expected = createHash("sha256").update(apiToken).digest();
  const auth: RequestHandler = (req, res, next) => {
    const value = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "";
    if (!value || !timingSafeEqual(expected, createHash("sha256").update(value).digest())) {
      res.status(401).json({ error: "unauthorized" }); return;
    }
    next();
  };
  app.get("/health/live", (_req, res) => res.json({ status: "ok", transport: "matrix" }));
  app.get("/health/ready", auth, (_req, res) => res.status(Date.now() - connector.lastSyncAt < 90_000 ? 200 : 503).json({
    status: Date.now() - connector.lastSyncAt < 90_000 ? "ready" : "syncing", userId: connector.userId,
    lastSyncAt: connector.lastSyncAt, lastError: connector.lastError,
  }));
  app.use(auth);
  app.get("/api/status", (_req, res) => {
    const counts: Record<string, Record<string, number>> = {};
    for (const collection of ["incoming", "outgoing", "outbox"]) {
      counts[collection] = {};
      for (const { value } of connector.store.entries<{ status: string }>(collection)) {
        counts[collection][value.status] = (counts[collection][value.status] ?? 0) + 1;
      }
    }
    res.json({ userId: connector.userId, execution: connector.cli ? "cli" : "a2a", lastSyncAt: connector.lastSyncAt, lastError: connector.lastError, counts,
      outboxErrors: connector.store.entries<{ status: string; error?: string }>("outbox")
        .filter((r) => r.value.status === "queued" && r.value.error).map((r) => ({ id: r.id, error: r.value.error })),
      protocolErrors: connector.store.entries("protocol_errors").slice(-20).map((r) => r.value) });
  });
  app.get("/api/contacts", (_req, res) => res.json({ data: connector.contacts() }));
  const social = () => { if (!connector.social) throw new Error("native_matrix_client_unavailable"); return connector.social; };
  app.post("/api/contacts", async (req, res) => {
    const contact = z.object({ address: mxid, note: z.string().max(500).default(""),
      tags: z.array(z.string().max(80)).max(32).default([]),
      receive: z.enum(["allow", "ask", "deny"]).default("ask"),
      execution: z.enum(["allow", "ask", "deny"]).default("ask") }).strict().parse(req.body);
    await connector.updateContact(contact);
    if (contact.receive === "deny" && connector.social) await connector.social.block(contact.address, true);
    res.status(201).json({ data: connector.contact(contact.address) });
  });
  app.delete("/api/contacts/:address", async (req, res) => { await connector.removeContact(mxid.parse(req.params.address)); res.status(204).end(); });
  app.get("/api/blocked", (_req, res) => res.json({ data: social().blocked() }));
  app.post("/api/blocked/:address", async (req, res) => { await social().block(mxid.parse(req.params.address), true); res.status(204).end(); });
  app.delete("/api/blocked/:address", async (req, res) => { await social().block(mxid.parse(req.params.address), false); res.status(204).end(); });
  app.get("/api/requests", (_req, res) => res.json({ data: connector.pending() }));
  app.post("/api/requests/:id/approve", (req, res) => {
    if (connector.cli?.has(req.params.id)) connector.cli.approve(req.params.id); else connector.approve(req.params.id);
    res.status(204).end();
  });
  app.post("/api/requests/:id/reject", (req, res) => {
    if (connector.cli?.has(req.params.id)) connector.cli.reject(req.params.id); else connector.deny(req.params.id);
    res.status(204).end();
  });
  const work = () => { if (!connector.cli) throw new WorkError("execution_is_bound_to_a2a_service"); return connector.cli; };
  app.get("/api/inbox", (req, res) => {
    const all = z.enum(["true", "false"]).default("false").parse(req.query.all) === "true";
    res.json({ data: work().list(all), requests: connector.pending().filter((r) => r.request.operation === "send").map((r) => ({
      id: r.id, from: r.sender, conversation: r.room, status: r.status === "uncertain" ? "uncertain" : "approval_required",
      reason: r.error ?? null, input: r.request.body.message, contextId: decodeRequest(r.request.body).message!.contextId,
    })) });
  });
  app.get("/api/work/:id", (req, res) => res.json(work().inspect(req.params.id)));
  app.post("/api/work/claim", async (req, res) => {
    const body = z.object({ worker: z.string().trim().min(1).max(160), id: z.string().min(1).max(255).optional(),
      wait: z.number().int().min(0).max(60).default(0) }).strict().parse(req.body);
    const deadline = Date.now() + body.wait * 1000;
    do {
      if (res.destroyed) return;
      await connector.work();
      const result = work().claim(body.worker, body.id);
      if (result) { res.json(result); return; }
      if (Date.now() >= deadline) break;
      await delay(250);
    } while (!res.destroyed);
    if (!res.destroyed) res.json(null);
  });
  app.post("/api/work/:id/update", async (req, res) => {
    const body = z.object({ action: z.enum(["progress", "reply", "need-input", "fail", "cancelled"]),
      text: z.string().max(32000).default(""), data: z.record(z.string(), z.unknown()).optional() }).strict().parse(req.body);
    if (body.action !== "cancelled" && !body.text.trim() && !(body.action === "reply" && body.data)) {
      throw new WorkError("message_required", 400);
    }
    const result = work().update(req.params.id, body.action, body.text, body.data);
    await connector.work(); res.json(result);
  });
  app.get("/api/invites", (_req, res) => res.json({ data: connector.store.entries("invites").map((r) => r.value) }));
  app.post("/api/invites/:room/accept", async (req, res) => {
    if (!connector.store.get("invites", req.params.room)) { res.status(404).json({ error: "invite_not_found" }); return; }
    if (connector.social) await connector.social.accept(req.params.room); else await connector.transport.join(req.params.room);
    res.status(204).end();
  });
  app.post("/api/invites/:room/reject", async (req, res) => { await social().leave(req.params.room); res.status(204).end(); });
  app.get("/api/conversations", (_req, res) => res.json({ data: connector.social?.conversations() ?? connector.store.entries("conversations").map((r) => r.value) }));
  app.post("/api/conversations", async (req, res) => {
    const body = z.object({ address: mxid }).strict().parse(req.body);
    res.status(201).json(await connector.conversation(body.address));
  });
  app.post("/api/messages", async (req, res) => {
    const body = z.object({ address: mxid, text: z.string().min(1), contextId: z.string().min(1).optional(), messageId: z.string().min(1).max(255).optional() }).strict().parse(req.body);
    res.status(202).json(await connector.say(body.address, body.text, body.contextId, body.messageId));
  });
  app.get("/api/rooms/:room/history", async (req, res) => {
    const from = z.string().optional().parse(req.query.from);
    res.json(await social().history(req.params.room, from));
  });
  app.post("/api/rooms/:room/read", async (req, res) => {
    const body = z.object({ eventId: z.string().optional() }).strict().parse(req.body ?? {});
    await social().read(req.params.room, body.eventId); res.status(204).end();
  });
  app.post("/api/rooms/:room/leave", async (req, res) => { await social().leave(req.params.room); res.status(204).end(); });
  app.get("/api/events", async (req, res) => {
    let cursor = z.coerce.number().int().min(0).safeParse(req.query.since ?? connector.store.get("meta", "timeline_cursor") ?? 0);
    if (!cursor.success) { res.status(400).json({ error: "invalid_cursor" }); return; }
    const room = z.string().optional().parse(req.query.room);
    const client = social(); let after = cursor.data;
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.flushHeaders();
    while (!res.destroyed) {
      const entries = client.entries(after, room);
      for (const entry of entries) {
        after = entry.cursor; res.write(`id: ${after}\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      if (!entries.length) res.write(": keepalive\n\n");
      await delay(1000);
    }
  });
  const handlers = new Map<string, ReturnType<typeof suite>>();
  const userBuilder: UserBuilder = async () => ({ isAuthenticated: true, userName: connector.userId });
  function suite(target: string) {
    const handler = new MatrixA2AHandler(connector, target, publicBaseUrl);
    return { card: agentCardHandler({ agentCardProvider: handler, cache: { maxAge: 0 } }),
      rest: restHandler({ requestHandler: handler, userBuilder }), rpc: jsonRpcHandler({ requestHandler: handler, userBuilder }) };
  }
  const route = (kind: "card" | "rest" | "rpc"): RequestHandler => (req, res, next) => {
    const target = mxid.parse(req.params.address);
    let handler = handlers.get(target);
    if (!handler) { handler = suite(target); handlers.set(target, handler); }
    return handler[kind](req, res, next);
  };
  app.use("/agents/:address/.well-known/agent-card.json", route("card"));
  app.use("/agents/:address/a2a/rest", route("rest"));
  app.use("/agents/:address/a2a/jsonrpc", route("rpc"));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof WorkError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: error instanceof z.ZodError ? "invalid_request" : "operation_failed" });
  });
  return app;
}

export async function runConnector(): Promise<void> {
  const profiles = process.env.MATRIX_PROFILE || !process.env.MATRIX_HOMESERVER_URL ? new ProfileStore() : undefined;
  const release = profiles?.lock();
  let store: ConnectorStore | undefined, backend: A2ABackend | undefined, connector: MatrixConnector | undefined;
  let server: ReturnType<ReturnType<typeof createConnectorApp>["listen"]> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { server?.close(); server?.closeAllConnections(); await connector?.stop(); await backend?.close(); store?.close(); }
    finally { release?.(); }
  };
  try {
    const profile = profiles?.require();
    const url = new URL(profile?.homeserver ?? required("MATRIX_HOMESERVER_URL"));
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (profile || process.env.MATRIX_ALLOW_HTTP === "true"))) throw new Error("matrix_https_required");
    const userId = mxid.parse(profile?.userId ?? required("MATRIX_USER_ID"));
    store = new ConnectorStore(profiles?.databasePath ?? process.env.MATRIX_STORE_PATH ?? "state/matrix.sqlite", userId);
    const cardUrl = profile ? profile.backend?.cardUrl : process.env.A2A_AGENT_CARD_URL;
    store.bindExecution(cardUrl);
    backend = cardUrl ? new A2ABackend(cardUrl, profile?.backend?.token ?? secret("A2A_ENDPOINT_TOKEN", false),
      profile ? profile.backend!.allowLocal : process.env.A2A_ALLOW_LOCAL === "true") : undefined;
    const token = profile?.accessToken ?? secret("MATRIX_ACCESS_TOKEN");
    const transport = new SdkMatrixTransport(url.toString(), token, userId, profile && profiles ? profileClient(profile, profiles) : undefined);
    connector = new MatrixConnector(userId, store, transport, backend, Number(process.env.MATRIX_POLL_MS ?? "1000"));
    for (const address of (profile ? "" : process.env.MATRIX_ALLOWED_SENDERS ?? "").split(",").filter(Boolean)) {
      if (!store.get("policies", address)) await connector.updateContact({ address, note: "Provisioned receive and execution permission", receive: "allow", execution: "allow" } satisfies Contact);
    }
    const address = profile ? connectorAddress(profile.connectorUrl) : undefined;
    const port = address ? Number(address.port || "80") : Number(process.env.PORT ?? "8787");
    const publicBaseUrl = address?.origin ?? (process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
    const app = createConnectorApp(connector, profile?.gatewayToken ?? secret("CONNECTOR_API_TOKEN"), publicBaseUrl);
    await connector.start();
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, address?.hostname.replace(/^\[|\]$/g, "") ?? process.env.HOST ?? "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    process.stdout.write(JSON.stringify({ event: "matrix.listening", userId, port, ...(profiles ? { profile: profiles.name } : {}) }) + "\n");
    const onSignal = () => { void stop().catch(() => { process.exitCode = 1; }); };
    process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  } catch (error) { await stop(); throw profiles ? authError(error) : error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConnector().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "startup_failed"}\n`); process.exitCode = 1; });
}
