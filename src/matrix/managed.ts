import { ExternalIdentitySessions, type ExternalIdentityConfig } from "./external-identity.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { MatrixConnector } from "./connector.js";
import { ConnectorStore } from "./store.js";
import { createConnectorApp } from "./index.js";
import { ApplicationInbox, ApplicationTransport } from "./application-service.js";
import { digest, mxid } from "./protocol.js";
import { WorkError } from "./cli-work.js";
import type { MatrixTransport } from "./transport.js";

export const agentName = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export interface ManagedAgent {
  id: string; owner: string; name: string; address: string; matrixId: string;
  createdAt: string; status: "provisioning" | "active";
}
interface Instance { id: string; agentId: string; name: string; tokenHash: string; createdAt: string; lastSeen: string | null; revoked: boolean; }
export interface ServiceConfig { serverName: string; homeserver: string; publicUrl: string; stateDir: string; asToken: string; hsToken: string; externalIdentity?: ExternalIdentityConfig; trustedProxies?: string[]; }
interface Runtime { connector: MatrixConnector; app: ReturnType<typeof createConnectorApp>; token: string; }
export interface ServiceDependencies {
  authenticate?: (token: string) => Promise<string>;
  provision?: (agent: ManagedAgent) => Promise<void>;
  transport?: (agent: ManagedAgent, inbox: ApplicationInbox) => MatrixTransport;
}
const newToken = () => randomBytes(32).toString("base64url");
function bearer(req: express.Request): string { return req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? ""; }
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function publicInstance({ tokenHash: _hash, ...instance }: Instance) { return instance; }

export class ManagedService {
  readonly store: ConnectorStore;
  readonly inbox: ApplicationInbox;
  readonly externalIdentity: ExternalIdentitySessions | undefined;
  private runtimes = new Map<string, Promise<Runtime>>();
  constructor(readonly config: ServiceConfig, readonly dependencies: ServiceDependencies = {}) {
    if (!/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(config.serverName)) throw new Error("invalid_server_name");
    for (const raw of [config.homeserver, config.publicUrl]) {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_service_url");
    }
    if (config.asToken.length < 32 || config.hsToken.length < 32 || config.asToken === config.hsToken) throw new Error("distinct_application_service_secrets_required");
    this.store = new ConnectorStore(join(config.stateDir, "registry.sqlite"), config.serverName);
    this.inbox = new ApplicationInbox(this.store, (user) => this.store.get<string>("matrix_agents", user));
    this.externalIdentity=config.externalIdentity?new ExternalIdentitySessions(this,config.externalIdentity):undefined;
  }
  agents(owner?: string): ManagedAgent[] {
    return this.store.entries<ManagedAgent>("agents").map((r) => r.value).filter((a) => !owner || a.owner === owner);
  }
  agent(id: string): ManagedAgent {
    const agent = this.store.get<ManagedAgent>("agents", id);
    if (!agent) throw new WorkError("agent_not_found", 404);
    return agent;
  }
  owned(id: string, owner: string): ManagedAgent {
    const agent = this.agent(id);
    if (agent.owner !== owner) throw new WorkError("agent_not_found", 404);
    return agent;
  }
  async authenticate(token: string): Promise<string> {
    if (!token || token.startsWith("ari_")) throw new WorkError("account_login_required", 401);
    if(token.startsWith("ars_")){if(!this.externalIdentity)throw new WorkError("account_session_invalid",401);return this.externalIdentity.authenticate(token);}
    let user: string;
    if (this.dependencies.authenticate) user = await this.dependencies.authenticate(token);
    else {
      const response = await fetch(`${this.config.homeserver}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new WorkError("account_session_invalid", 401);
      user = z.object({ user_id: mxid }).parse(await response.json()).user_id;
    }
    mxid.parse(user);
    if (!user.endsWith(`:${this.config.serverName}`) || user.startsWith("@_ar_")) throw new WorkError("local_owner_account_required", 403);
    return user;
  }
  async create(owner: string, name: string): Promise<ManagedAgent> {
    agentName.parse(name);
    let agent = this.agents(owner).find((a) => a.name === name);
    if (!agent) {
      if (this.agents(owner).length >= 50) throw new WorkError("agent_limit_reached", 429);
      const id = randomUUID();
      const localpart = owner.slice(1, owner.indexOf(":"));
      agent = { id, owner, name, address: `${localpart}/${name}@${this.config.serverName}`,
        matrixId: `@_ar_${id.replaceAll("-", "")}:${this.config.serverName}`, createdAt: new Date().toISOString(), status: "provisioning" };
      this.store.transaction(() => {
        this.store.set("agents", id, agent);
        this.store.set("matrix_agents", agent!.matrixId, id);
      });
    }
    await this.runtime(agent.id);
    return this.agent(agent.id);
  }
  runtime(id: string): Promise<Runtime> {
    let pending = this.runtimes.get(id);
    if (!pending) {
      pending = this.open(this.agent(id)).catch((error) => { this.runtimes.delete(id); throw error; });
      this.runtimes.set(id, pending);
    }
    return pending;
  }
  private async open(agent: ManagedAgent): Promise<Runtime> {
    if (this.dependencies.provision) await this.dependencies.provision(agent);
    else {
      const response = await fetch(`${this.config.homeserver}/_matrix/client/v3/register`, {
        method: "POST", headers: { Authorization: `Bearer ${this.config.asToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "m.login.application_service", username: agent.matrixId.slice(1).split(":")[0], inhibit_login: true }),
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as { errcode?: string };
      if (!response.ok && body.errcode !== "M_USER_IN_USE") throw new WorkError("matrix_agent_provisioning_failed", 502);
    }
    const store = new ConnectorStore(join(this.config.stateDir, "agents", `${agent.id}.sqlite`), agent.matrixId);
    // This is an AS-owned journal, not an account restored from Matrix history.
    if (!store.get("meta", "sync")) store.set("meta", "sync", "0");
    const transport = this.dependencies.transport?.(agent, this.inbox) ?? new ApplicationTransport(
      this.config.homeserver, this.config.asToken, agent.matrixId, agent.id, this.inbox);
    const connector = new MatrixConnector(agent.matrixId, store, transport, undefined, 250);
    try {
      if (!store.get("meta", "managed_initialized")) {
        await connector.updateContact({ address: agent.owner, note: "Owner", receive: "allow", execution: "allow" });
        await transport.data?.displayName(agent.name);
        store.set("meta", "managed_initialized", true);
      }
      await connector.start();
    } catch (error) { await connector.stop(); store.close(); throw error; }
    this.store.set("agents", agent.id, { ...agent, status: "active" });
    const token = newToken();
    return { connector, token, app: createConnectorApp(connector, token, `${this.config.publicUrl}/agents/${agent.id}/gateway`) };
  }
  instances(agentId: string) { return this.store.entries<Instance>("instances").map((r) => r.value).filter((i) => i.agentId === agentId).map(publicInstance); }
  issue(agentId: string, name: string): { instance: ReturnType<typeof publicInstance>; token: string; gatewayUrl: string } {
    this.agent(agentId); agentName.parse(name);
    const same = this.store.entries<Instance>("instances").map((r) => r.value).find((i) => i.agentId === agentId && i.name === name);
    if (!same && this.instances(agentId).length >= 50) throw new WorkError("instance_limit_reached", 429);
    const token = `ari_${newToken()}`;
    const instance: Instance = { id: same?.id ?? randomUUID(), agentId, name, tokenHash: digest(token),
      createdAt: same?.createdAt ?? new Date().toISOString(), lastSeen: same?.lastSeen ?? null, revoked: false };
    this.store.set("instances", instance.id, instance);
    return { instance: publicInstance(instance), token, gatewayUrl: `${this.config.publicUrl}/agents/${agentId}/gateway` };
  }
  instance(token: string, agentId: string): Instance {
    if (!token.startsWith("ari_")) throw new WorkError("instance_token_required", 401);
    const hash = digest(token);
    const instance = this.store.entries<Instance>("instances").map((r) => r.value).find((i) => equal(i.tokenHash, hash));
    if (!instance || instance.revoked || instance.agentId !== agentId) throw new WorkError("instance_unauthorized", 401);
    this.store.set("instances", instance.id, { ...instance, lastSeen: new Date().toISOString() });
    return instance;
  }
  async revoke(agentId: string, instanceId: string): Promise<void> {
    const instance = this.store.get<Instance>("instances", instanceId);
    if (!instance || instance.agentId !== agentId) throw new WorkError("instance_not_found", 404);
    this.store.set("instances", instanceId, { ...instance, revoked: true });
    const { connector } = await this.runtime(agentId);
    for (const work of connector.cli!.list()) if (work.worker === instance.id) await connector.cli!.cancel(work.id);
  }
  async start(): Promise<void> { for (const agent of this.agents()) await this.runtime(agent.id); }
  async close(): Promise<void> {
    for (const pending of this.runtimes.values()) {
      try { const { connector } = await pending; await connector.stop(); connector.store.close(); } catch { /* Failed initialization already closed its store. */ }
    }
    this.runtimes.clear(); this.store.close();
  }
}

export function createManagedApp(service: ManagedService) {
  const app = express(); app.disable("x-powered-by");
  app.set("trust proxy", service.config.trustedProxies ?? false);
  app.use(express.json({ limit: "2mb" }));
  app.get("/health/live", (_req, res) => res.json({ status: "ok", component: "agent-service" }));
  app.use("/_matrix/app/v1", (req, res, next) => {
    if (!equal(bearer(req), service.config.hsToken) ||
      (req.query.access_token !== undefined && req.query.access_token !== service.config.hsToken)) {
      res.status(403).json({ errcode: "M_FORBIDDEN", error: "unauthorized" }); return;
    }
    next();
  });
  app.put("/_matrix/app/v1/transactions/:id", (req, res) => { service.inbox.receive(req.params.id, req.body); res.json({}); });
  app.post("/_matrix/app/v1/ping", (_req, res) => res.json({}));
  app.get("/_matrix/app/v1/users/:user", (req, res) => {
    const exists = service.store.get("matrix_agents", req.params.user);
    res.status(exists ? 200 : 404).json(exists ? {} : { errcode: "M_NOT_FOUND" });
  });
  app.use("/_matrix/app/v1", (_req, res) => res.status(404).json({ errcode: "M_UNRECOGNIZED" }));
  const root = "/_agent-router/v1";
  // Limit before authentication or provisioning. Forwarded IPs are used only
  // when the operator explicitly trusts the connecting proxy address.
  app.use(root, rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
    message: { error: "rate_limit_exceeded" } }));
  app.use(`${root}/auth`, rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
    message: { error: "rate_limit_exceeded" } }));
  app.post(`${root}/auth/exchange`, async(req,res)=>{
    if(!service.externalIdentity)throw new WorkError("external_identity_disabled",503);
    const body=z.object({provider:z.string().max(48),accessToken:z.string().min(1).max(8192)}).strict().parse(req.body);
    res.set("Cache-Control","no-store");
    res.json(await service.externalIdentity.exchange(body.provider,body.accessToken));
  });
  app.delete(`${root}/auth/session`,(req,res)=>{
    if(!service.externalIdentity)throw new WorkError("account_session_invalid",401);
    service.externalIdentity.revoke(bearer(req));res.status(204).end();
  });
  app.get(`${root}/directory`, (req, res) => {
    const address = z.string().min(1).max(512).parse(req.query.address);
    const agent = service.agents().find((a) => a.address === address && a.status === "active");
    if (!agent) throw new WorkError("agent_not_found", 404);
    res.json({ id: agent.id, address: agent.address, owner: agent.owner, name: agent.name, matrixId: agent.matrixId });
  });
  app.use(`${root}/agents/:agentId/gateway`, async (req, res, next) => {
    const agentId = String(req.params.agentId), token = bearer(req);
    if (token.startsWith("ari_")) {
      const instance = service.instance(token, agentId);
      const read = req.method === "GET" && /^\/(health\/ready|api\/(status|inbox|work\/[^/]+|contacts|conversations))$/.test(req.path);
      const write = req.method === "POST" && /^\/api\/(work\/claim|work\/[^/]+\/update|messages|conversations)$/.test(req.path);
      const a2a = /^(GET|POST)$/.test(req.method) && /^\/agents\/[^/]+\/(a2a\/|\.well-known\/agent-card\.json)/.test(req.path);
      if (!read && !write && !a2a) throw new WorkError("owner_permission_required", 403);
      res.locals.workerId = instance.id;
      res.locals.validateWorker = () => service.instance(token, agentId);
    } else service.owned(agentId, await service.authenticate(token));
    const runtime = await service.runtime(agentId);
    req.headers.authorization = `Bearer ${runtime.token}`;
    runtime.app(req, res, next);
  });
  app.use(root, async (req, res, next) => { res.locals.owner = await service.authenticate(bearer(req)); next(); });
  app.get(`${root}/agents`, (_req, res) => res.json({ data: service.agents(res.locals.owner) }));
  app.post(`${root}/agents`, async (req, res) => {
    const { name } = z.object({ name: agentName }).strict().parse(req.body);
    res.status(201).json(await service.create(res.locals.owner, name));
  });
  app.use(`${root}/agents/:agentId`, (req, res, next) => { service.owned(String(req.params.agentId), res.locals.owner); next(); });
  app.get(`${root}/agents/:agentId`, (req, res) => res.json(service.agent(req.params.agentId)));
  app.get(`${root}/agents/:agentId/instances`, (req, res) => res.json({ data: service.instances(req.params.agentId) }));
  app.post(`${root}/agents/:agentId/instances`, (req, res) => {
    const { name } = z.object({ name: agentName }).strict().parse(req.body);
    res.status(201).json(service.issue(req.params.agentId, name));
  });
  app.delete(`${root}/agents/:agentId/instances/:instanceId`, async (req, res) => {
    await service.revoke(req.params.agentId, req.params.instanceId); res.status(204).end();
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof WorkError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .json({ error: error instanceof WorkError ? error.message : error instanceof z.ZodError ? "invalid_request" : "operation_failed" });
  });
  return app;
}
