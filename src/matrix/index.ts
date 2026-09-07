import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import { agentCardHandler, jsonRpcHandler, restHandler, type UserBuilder } from "@a2a-js/sdk/server/express";
import { A2ABackend } from "./backend.js";
import { MatrixConnector, type Contact } from "./connector.js";
import { MatrixA2AHandler, requestSignal } from "./gateway.js";
import { ConnectorStore } from "./store.js";
import { SdkMatrixTransport } from "./transport.js";
import { mxid } from "./protocol.js";
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
    res.json({ userId: connector.userId, lastSyncAt: connector.lastSyncAt, lastError: connector.lastError, counts,
      outboxErrors: connector.store.entries<{ status: string; error?: string }>("outbox")
        .filter((r) => r.value.status === "queued" && r.value.error).map((r) => ({ id: r.id, error: r.value.error })),
      protocolErrors: connector.store.entries("protocol_errors").slice(-20).map((r) => r.value) });
  });
  app.get("/api/contacts", (_req, res) => res.json({ data: connector.contacts() }));
  app.post("/api/contacts", (req, res) => {
    const contact = z.object({ address: mxid, note: z.string().max(500).default(""),
      receive: z.enum(["allow", "ask", "deny"]).default("ask"),
      execution: z.enum(["allow", "ask", "deny"]).default("ask") }).strict().parse(req.body);
    connector.setContact(contact); res.status(201).json({ data: contact });
  });
  app.delete("/api/contacts/:address", (req, res) => { connector.store.delete("contacts", req.params.address); res.status(204).end(); });
  app.get("/api/requests", (_req, res) => res.json({ data: connector.pending() }));
  app.post("/api/requests/:id/approve", (req, res) => { connector.approve(req.params.id); res.status(204).end(); });
  app.post("/api/requests/:id/reject", (req, res) => { connector.deny(req.params.id); res.status(204).end(); });
  app.get("/api/invites", (_req, res) => res.json({ data: connector.store.entries("invites").map((r) => r.value) }));
  app.post("/api/invites/:room/accept", async (req, res) => {
    if (!connector.store.get("invites", req.params.room)) { res.status(404).json({ error: "invite_not_found" }); return; }
    await connector.transport.join(req.params.room); res.status(204).end();
  });
  app.get("/api/conversations", (_req, res) => res.json({ data: connector.store.entries("conversations").map((r) => r.value) }));
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
    try { server?.close(); await connector?.stop(); await backend?.close(); store?.close(); }
    finally { release?.(); }
  };
  try {
    const profile = profiles?.require();
    const url = new URL(profile?.homeserver ?? required("MATRIX_HOMESERVER_URL"));
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (profile || process.env.MATRIX_ALLOW_HTTP === "true"))) throw new Error("matrix_https_required");
    const userId = mxid.parse(profile?.userId ?? required("MATRIX_USER_ID"));
    store = new ConnectorStore(profiles?.databasePath ?? process.env.MATRIX_STORE_PATH ?? "state/matrix.sqlite", userId);
    const cardUrl = profile ? profile.backend?.cardUrl : process.env.A2A_AGENT_CARD_URL;
    if (store.get<string>("meta", "backend") && store.get<string>("meta", "backend") !== (cardUrl ?? "")) {
      throw new Error("backend_changed_use_explicit_context_migration_or_new_store");
    }
    store.set("meta", "backend", cardUrl ?? "");
    backend = cardUrl ? new A2ABackend(cardUrl, profile?.backend?.token ?? secret("A2A_ENDPOINT_TOKEN", false),
      profile ? profile.backend!.allowLocal : process.env.A2A_ALLOW_LOCAL === "true") : undefined;
    const token = profile?.accessToken ?? secret("MATRIX_ACCESS_TOKEN");
    const transport = new SdkMatrixTransport(url.toString(), token, userId, profile && profiles ? profileClient(profile, profiles) : undefined);
    connector = new MatrixConnector(userId, store, transport, backend, Number(process.env.MATRIX_POLL_MS ?? "1000"));
    for (const address of (profile ? "" : process.env.MATRIX_ALLOWED_SENDERS ?? "").split(",").filter(Boolean)) {
      if (!connector.contact(address)) connector.setContact({ address, note: "Provisioned receive and execution permission", receive: "allow", execution: "allow" } satisfies Contact);
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
