import { ExternalIdentitySessions, type ExternalIdentityConfig } from "./external-identity.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
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
import { DormantTransport, type MatrixTransport } from "./transport.js";
import { AgentLedger } from "../ledger/ledger.js";
import { OwnerHubs } from "../ledger/hub.js";
import { PersonRegistry, personId } from "../ledger/registry.js";
import { Identities } from "../ledger/identity.js";
import { SynapseWhoamiAuthenticator, createWebLedger } from "../ledger/web.js";
import { RoomFanout } from "../ledger/rooms-fanout.js";
import { CloudflareAccessAuthenticator, CompositeAuthenticator, IdentityError, assertEdgeOwners, type EdgeIdentityConfig,
  type OwnerPrincipal, type OwnerRequest } from "../auth/edge-identity.js";
import { createBlobStore, type BlobStore, type BlobStoreConfig } from "../ledger/blobs.js";
import { OwnerAttachments } from "../ledger/blobs-hub.js";
import type { AttachmentReference, MediaContent } from "../communication/types.js";

export const agentName = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
/**
 * ADR 0005 19.1: `none` never had a Matrix account (created while Matrix was off), `dormant` has an Application Service
 * account that is not used, `active` is provisioned and its Matrix adapter runs. A missing value is `active` (legacy).
 */
export type MatrixState = "active" | "dormant" | "none";
export interface ManagedAgent {
  /** `matrixId` is the agent's runtime identity whether or not it is registered on a homeserver. */
  id: string; owner: string; name: string; address: string; matrixId: string;
  createdAt: string; status: "provisioning" | "active" | "deleting"; matrix?: MatrixState;
}
/** Agent API responses: the stored record with `matrix` as `{ state, userId }` (the effective state). */
export type PublicAgent = Omit<ManagedAgent, "matrix"> & { matrix: { state: MatrixState; userId: string | null } };
interface Instance { id: string; agentId: string; name: string; tokenHash: string; createdAt: string; lastSeen: string | null; revoked: boolean; }
export interface ServiceConfig { serverName: string; publicUrl: string; stateDir: string;
  /** Matrix Application Service settings; required and used only while `matrix.enabled` is not false. */
  homeserver?: string; asToken?: string; hsToken?: string;
  /**
   * ADR 0005 19.1, `AGENT_MATRIX=on|off` (default on). Off: Router makes no homeserver request at all, mounts no
   * Application Service routes, creates agents with `matrix: "none"` and runs every agent with a dormant transport.
   * `serverName` stays required (it is the owner-id namespace).
   */
  matrix?: { enabled: boolean };
  externalIdentity?: ExternalIdentityConfig; trustedProxies?: string[];
  /** ADR 0005 `ledger_read`: serve the read-only web history API and event socket from the owner ledger. */
  ledgerRead?: boolean;
  /** ADR 0005 `send` (phase 3, needs `ledgerRead`): owner web messages through the web channel; dispatch and flush read the ledger. */
  ledgerSend?: boolean;
  /** ADR 0005 `cards` (phase 4, `AGENT_LEDGER_CARDS`, needs `ledgerSend`): card answers over HTTP; first answer wins. */
  ledgerCards?: boolean;
  /** ADR 0005 `reset` (phase 4, `AGENT_LEDGER_CONTROL`, needs `ledgerSend`): cancel, steer, reset ("新对话") and purge. */
  ledgerControl?: boolean;
  /** ADR 0005 `groups` (phase 5, `AGENT_LEDGER_GROUPS`, needs `ledgerSend`): native hub rooms, fan-out to agents and room commands. */
  ledgerGroups?: boolean;
  /** ADR 0005 18.2: verify the Cloudflare Access JWT and map its email (or service token) to an owner. */
  edgeIdentity?: EdgeIdentityConfig;

  /** ADR 0005 `identity` (phase 6, `AGENT_LEDGER_IDENTITY`): owner resolution by person, `/link` pairing and the identity routes (with `ledgerRead`). */
  ledgerIdentity?: boolean; }
export interface ServiceExtension {
  observation?: import("../execution/observation.js").RunObservation;
  sessions?: import("../execution/sessions.js").WorkSessions;
  /** The channel core and its web channel (ADR 0005 phase 3). */
  communication?: import("../communication/core.js").CommunicationCore;
  web?: import("../ledger/surfaces.js").WebIngress;
  /** Phase 4 cards and control (ADR 0005 section 16). */
  control?: import("../ledger/control.js").LedgerControl;
  /** The hub room channel (ADR 0005 phase 5). */
  room?: import("../ledger/rooms.js").RoomDelivery;
  start(): Promise<void>; stop(): Promise<void>; status(): unknown;
  resolve(callId: string, result: unknown): Promise<void | "accepted" | "stale">;
  reconcile(claimId: string, runId: string): Promise<void>;
  closeUnknown(claimId: string): Promise<void>;
}
interface Runtime { connector: MatrixConnector; app: ReturnType<typeof createConnectorApp>; token: string; extension?: ServiceExtension | undefined; }
export interface ServiceDependencies {
  authenticate?: (token: string) => Promise<string>;
  /** Replaces `<teamDomain>/cdn-cgi/access/certs` (tests). */
  edgeIdentityCerts?: URL;
  provision?: (agent: ManagedAgent) => Promise<void>;
  transport?: (agent: ManagedAgent, inbox: ApplicationInbox) => MatrixTransport;
  configure?: (agent: ManagedAgent, connector: MatrixConnector) => Promise<ServiceExtension | undefined>;
  /** Replaces Matrix account deactivation (tests and non-Synapse deployments). */
  deprovision?: (agent: ManagedAgent) => Promise<void>;
  /** Product teardown (environments, Host) while the Agent still exists; failure keeps the Agent. */
  beforeDelete?: (agent: ManagedAgent) => Promise<void>;
  /** Product state purge after Router state is gone. */
  afterDelete?: (agent: ManagedAgent) => Promise<void>;
}
// ---- ADR 0005 phase 4 (attachments). Separate declarations (merged by TypeScript) keep the phase 3 edits above apart. ----
export interface ServiceConfig {
  /** ADR 0005 `attachments` (phase 4, `AGENT_LEDGER_ATTACHMENTS`, needs `ledgerSend`): upload/download routes, attachments on send and `features.attachments`. */
  ledgerAttachments?: boolean;
  /** Blob store for attachments; default `LocalBlobStore` under `<stateDir>/blobs`. R2 credentials are read from files. */
  blobStore?: BlobStoreConfig;
  /** Per-owner quota over distinct blobs; default 5 GiB. */
  attachmentQuotaBytes?: number;
}
export interface ServiceExtension {
  /** Read one attachment of a stored inbound message (lazy promotion into the blob store). */
  readAttachment?(inputId: string, reference: AttachmentReference): Promise<MediaContent>;
}
export interface ServiceDependencies {
  /** Replaces the configured blob store (tests, embedders with their own storage). */
  blobStore?: BlobStore;
}
// ---- end phase 4 ----
/** Registry collections of the removed visitor channel ledger (`ChannelRouter`); deleted once by a migration. */
export const LEGACY_CHANNEL_COLLECTIONS = ["channel_entries", "channel_visitors", "channel_events", "channel_contexts", "channel_reply_attachments"];
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
  readonly persons: PersonRegistry;
  readonly hubs: OwnerHubs;
  readonly identity: Identities | undefined;
  readonly web: ReturnType<typeof createWebLedger> | undefined;
  readonly edgeIdentity: CloudflareAccessAuthenticator | undefined;
  private readonly owners: CompositeAuthenticator;
  /** Attachments and blob store (ADR 0005 16.5); only with `ledgerSend` and `ledgerAttachments`. */
  readonly attachments: OwnerAttachments | undefined;
  private readonly ledgers = new Map<string, AgentLedger>();
  /** The hub room fan-out worker (phase 5); present with `ledgerGroups`. */
  readonly fanout: RoomFanout | undefined;
  private runtimes = new Map<string, Promise<Runtime>>();
  private configurations = new Map<string, Promise<void>>();
  private deleteGuards: Array<(agentId: string) => void> = [];
  constructor(readonly config: ServiceConfig, readonly dependencies: ServiceDependencies = {}) {
    if (!/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(config.serverName)) throw new Error("invalid_server_name");
    const matrixOn = config.matrix?.enabled !== false;
    if (matrixOn && !config.homeserver) throw new Error("matrix_homeserver_required");
    for (const raw of matrixOn ? [config.homeserver!, config.publicUrl] : [config.publicUrl]) {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_service_url");
    }
    if (matrixOn && (!config.asToken || !config.hsToken || config.asToken.length < 32 || config.hsToken.length < 32 || config.asToken === config.hsToken))
      throw new Error("distinct_application_service_secrets_required");
    if (matrixOn && config.externalIdentity && !config.externalIdentity.adminToken) throw new Error("matrix_admin_token_required");
    // Without Matrix the console can only send through the ledger (ADR 0005 15.3).
    if (!matrixOn && config.ledgerRead && !config.ledgerSend) throw new Error("matrix_off_requires_ledger_send");
    this.store = new ConnectorStore(join(config.stateDir, "registry.sqlite"), config.serverName);
    // Only agents whose Matrix adapter runs get queued events; a dormant agent's rooms stay joined but are ignored (19.1).
    this.inbox = new ApplicationInbox(this.store, (user) => this.store.get<string>("matrix_agents", user),
      (agentId) => { const agent = this.store.get<ManagedAgent>("agents", agentId); return !agent || this.matrixState(agent) === "active"; });
    this.externalIdentity=config.externalIdentity?new ExternalIdentitySessions(this,config.externalIdentity):undefined;
    // The legacy visitor channel ledger (`ChannelRouter`, AgentMail entries) was removed; its records go with it.
    this.store.migrate(1, `DELETE FROM documents WHERE collection IN (${LEGACY_CHANNEL_COLLECTIONS.map((name) => `'${name}'`).join(",")})`, "legacy_channels_removed");
    this.persons = new PersonRegistry(this.store);
    this.hubs = new OwnerHubs(config.stateDir, {
      owns: (owner, agentId) => this.store.get<ManagedAgent>("agents", agentId)?.owner === owner,
      agentName: (agentId) => this.store.get<ManagedAgent>("agents", agentId)?.name ?? agentId,
      ledger: (agentId) => this.ledgers.get(agentId),
      personName: (id) => this.persons.person(id)?.displayName,
      groups: Boolean(config.ledgerRead && config.ledgerSend && config.ledgerGroups),
    });
    this.identity = config.ledgerIdentity ? new Identities(this.persons, this.hubs) : undefined;
    this.fanout = config.ledgerRead && config.ledgerSend && config.ledgerGroups ? new RoomFanout(this.hubs, {
      owners: () => [...new Set(this.agents().filter((agent) => agent.status === "active").map((agent) => agent.owner))],
      channel: async (agentId) => this.agent(agentId).status === "active" ? (await this.runtime(agentId)).extension?.room : undefined,
    }) : undefined;
    if (config.edgeIdentity) assertEdgeOwners(config.edgeIdentity, config.serverName);
    this.edgeIdentity = config.edgeIdentity ? new CloudflareAccessAuthenticator(config.edgeIdentity, { persons: this.persons, origins: [new URL(config.publicUrl).origin],
      ...(dependencies.edgeIdentityCerts ? { certsUrl: dependencies.edgeIdentityCerts } : {}) }) : undefined;
    this.owners = new CompositeAuthenticator(async (token) => {
      const ownerId = await this.authenticate(token);
      return { personId: personId(ownerId), ownerId, via: "bearer", matrixUserId: ownerId };
    }, this.edgeIdentity);
    const whoami = new SynapseWhoamiAuthenticator((token) => this.authenticate(token));
    this.attachments = config.ledgerRead && config.ledgerSend && config.ledgerAttachments ? new OwnerAttachments({ hubs: this.hubs,
      store: dependencies.blobStore ?? createBlobStore(config.blobStore, config.stateDir), quotaBytes: config.attachmentQuotaBytes,
      tempDir: join(config.stateDir, "tmp", "uploads"), owned: (owner) => this.agents(owner).filter((agent) => agent.status === "active"),
      open: async (agentId) => { await this.runtime(agentId); }, ledger: (agentId) => this.ledgers.get(agentId),
      readChannel: async (agentId, inputId, reference) => {
        const read = (await this.runtime(agentId)).extension?.readAttachment;
        if (!read) throw new Error("channel_attachment_read_unsupported");
        return read(inputId, reference);
      } }) : undefined;
    this.attachments?.startSweeper();
    this.web = config.ledgerRead ? createWebLedger({ hubs: this.hubs, persons: this.persons, identity: this.identity,
      authenticator: new CompositeAuthenticator((token) => whoami.authenticate(token), this.edgeIdentity),
      send: config.ledgerSend, channel: async (agentId) => (await this.runtime(agentId)).extension?.web,
      cards: Boolean(config.ledgerSend && config.ledgerCards), reset: Boolean(config.ledgerSend && config.ledgerControl),
      control: async (agentId) => (await this.runtime(agentId)).extension?.control,
      groups: Boolean(config.ledgerSend && config.ledgerGroups), kick: () => this.fanout?.kick(),
      open: async (agentId) => { await this.runtime(agentId); }, owned: (owner) => this.agents(owner).filter((agent) => agent.status === "active"),
      attachments: this.attachments, matrix: this.matrixOn,
      debug: (agentId) => {
        const ledger = this.ledgers.get(agentId), store = ledger?.store;
        const count = (collection: string) => Number(store?.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE collection=?").get(collection)?.n ?? 0);
        return { ledger: ledger?.counts() ?? null, error: ledger?.lastError || null, timeline: count("timeline"), inbox: count("communication_inbox"),
          outbox: count("communication_outbox"), backfill: store?.get("meta", "ledger_backfill") ?? null };
      } }) : undefined;
  }
  /** Channel runtime options for hub rooms (phase 5). Without `groups` the room connection is not registered. */
  roomOptions(agent: ManagedAgent) {
    return this.fanout ? { rooms: () => this.hubs.hub(agent.owner).rooms } : {};
  }
  /** ADR 0005 19.1: the deployment switch (`AGENT_MATRIX`, default on). */
  get matrixOn(): boolean { return this.config.matrix?.enabled !== false; }
  /** The stored per-agent state; a legacy record without one is `active`. */
  matrixState(agent: ManagedAgent): MatrixState { return agent.matrix ?? "active"; }
  /** The state in effect: with the deployment off, an agent with an account is `dormant`. */
  effectiveMatrix(agent: ManagedAgent): MatrixState {
    const state = this.matrixState(agent);
    return state === "active" && !this.matrixOn ? "dormant" : state;
  }
  /** True when the agent's Matrix adapter runs (deployment on and agent `active`). Mau reads this for its connections. */
  matrixEnabled(agentId: string): boolean {
    const agent = this.store.get<ManagedAgent>("agents", agentId);
    return Boolean(agent) && this.effectiveMatrix(agent!) === "active";
  }
  /** Agent API shape (19.1): `matrix: { state, userId }`; `matrixId` stays for compatibility. */
  publicAgent(agent: ManagedAgent): PublicAgent {
    const state = this.effectiveMatrix(agent);
    return { ...agent, matrix: { state, userId: state === "none" ? null : agent.matrixId } };
  }
  /** Application Service settings; only reachable while the deployment has Matrix on. */
  matrixConfig(): { homeserver: string; asToken: string; hsToken: string } {
    if (!this.matrixOn || !this.config.homeserver || !this.config.asToken || !this.config.hsToken) throw new WorkError("matrix_disabled", 409);
    return { homeserver: this.config.homeserver, asToken: this.config.asToken, hsToken: this.config.hsToken };
  }
  /**
   * `PUT /agents/:id/matrix` (19.1, deployment on only). Enabling registers the account, restarts the runtime with the
   * Application Service transport and sets a new activation checkpoint; disabling makes the agent `dormant` (account
   * and rooms kept, adapter stopped). Refused while a run is active or unknown.
   */
  async setMatrix(owner: string, id: string, enabled: boolean): Promise<PublicAgent> {
    if (!this.matrixOn) throw new WorkError("matrix_disabled", 409);
    const agent = this.owned(id, owner);
    if (agent.status === "deleting") throw new WorkError("agent_deleting", 409);
    const target: MatrixState = enabled ? "active" : "dormant";
    if (this.matrixState(agent) === target) return this.publicAgent(agent);
    const previous = this.configurations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const operation = new Promise<void>((r) => { release = r; });
    this.configurations.set(id, operation);
    try {
      await previous.catch(() => {});
      const pending = this.runtimes.get(id), runtime = pending && await pending.catch(() => undefined);
      if (runtime && this.activeRun(runtime.connector)) throw new WorkError("agent_has_active_or_unknown_run", 409);
      const before = this.agent(id);
      if (runtime) {
        this.runtimes.delete(id); this.ledgers.delete(id);
        await runtime.extension?.stop(); await runtime.connector.stop(); runtime.connector.store.close();
      }
      this.store.transaction(() => {
        this.store.set("agents", id, { ...this.agent(id), matrix: target });
        this.store.set("matrix_agents", before.matrixId, id);
      });
    } finally {
      release();
      if (this.configurations.get(id) === operation) this.configurations.delete(id);
    }
    try { await this.runtime(id); }
    catch (error) {
      // The runtime must keep running: fall back to the previous state.
      this.store.set("agents", id, { ...this.agent(id), matrix: agent.matrix ?? "active" });
      await this.runtime(id).catch(() => undefined);
      throw error;
    }
    return this.publicAgent(this.agent(id));
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
  /**
   * The one entry point for owner-authenticated requests (ADR 0005 18.2): the Cloudflare Access JWT when edge identity is
   * configured and the assertion is present, otherwise the bearer token. `authenticate(token)` stays for token-only callers.
   */
  authenticateRequest(request: OwnerRequest): Promise<OwnerPrincipal> { return this.owners.authenticate(request); }
  async authenticate(token: string): Promise<string> {
    if (!token || token.startsWith("ari_")) throw new WorkError("account_login_required", 401);
    if(token.startsWith("ars_")){if(!this.externalIdentity)throw new WorkError("account_session_invalid",401);return this.externalIdentity.authenticate(token);}
    let user: string;
    if (this.dependencies.authenticate) user = await this.dependencies.authenticate(token);
    // ADR 0005 19.2: without Matrix there is no whoami; owners sign in through the edge identity (or `ars_` sessions).
    else if (!this.matrixOn) throw new WorkError("matrix_disabled", 401);
    else {
      const response = await fetch(`${this.matrixConfig().homeserver}/_matrix/client/v3/account/whoami`, {
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
      // Without Matrix the agent gets no account (ADR 0005 19.2); `matrixId` is still its runtime identity.
      agent = { id, owner, name, address: `${localpart}/${name}@${this.config.serverName}`,
        matrixId: `@_ar_${id.replaceAll("-", "")}:${this.config.serverName}`, createdAt: new Date().toISOString(), status: "provisioning",
        matrix: this.matrixOn ? "active" : "none" };
      this.store.transaction(() => {
        this.store.set("agents", id, agent);
        if (agent!.matrix === "active") this.store.set("matrix_agents", agent!.matrixId, id);
      });
    }
    await this.runtime(agent.id);
    return this.agent(agent.id);
  }
  runtime(id: string): Promise<Runtime> {
    let pending = this.runtimes.get(id);
    if (!pending) {
      if (this.agent(id).status === "deleting") return Promise.reject(new WorkError("agent_deleting", 409));
      pending = this.open(this.agent(id)).catch((error) => { this.runtimes.delete(id); throw error; });
      this.runtimes.set(id, pending);
    }
    return pending;
  }
  /** Replace only the product extension. The Matrix identity, queue and connector stay intact. */
  async configureRuntime(id: string, configure: NonNullable<ServiceDependencies["configure"]>,
    rollback: NonNullable<ServiceDependencies["configure"]> = this.dependencies.configure ?? (async () => undefined),
    commit: () => void = () => {}): Promise<void> {
    const operation = (this.configurations.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const runtime = await this.runtime(id);
      if (runtime.connector.store.entries<{ phase: string }>("communication_runs")
        .some(({ value }) => ["running", "submitting", "unknown"].includes(value.phase)))
        throw new WorkError("agent_has_active_or_unknown_run", 409);
      await runtime.extension?.stop();
      runtime.extension = undefined;
      let replacement: ServiceExtension | undefined;
      try {
        // A worker tick could have submitted work while stop was awaiting its loop.
        if (runtime.connector.store.entries<{ phase: string }>("communication_runs")
          .some(({ value }) => ["running", "submitting", "unknown"].includes(value.phase)))
          throw new WorkError("agent_has_active_or_unknown_run", 409);
        replacement = await configure(this.agent(id), runtime.connector);
        commit(); await replacement?.start(); runtime.extension = replacement;
      }
      catch (error) {
        await replacement?.stop();
        const restored = await rollback(this.agent(id), runtime.connector);
        await restored?.start(); runtime.extension = restored;
        throw error;
      }
    });
    this.configurations.set(id, operation);
    try { await operation; } finally { if (this.configurations.get(id) === operation) this.configurations.delete(id); }
  }
  private async provision(agent: ManagedAgent): Promise<void> {
    if (this.dependencies.provision) { await this.dependencies.provision(agent); return; }
    const { homeserver, asToken } = this.matrixConfig();
    const response = await fetch(`${homeserver}/_matrix/client/v3/register`, {
      method: "POST", headers: { Authorization: `Bearer ${asToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "m.login.application_service", username: agent.matrixId.slice(1).split(":")[0], inhibit_login: true }),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({})) as { errcode?: string };
    if (!response.ok && body.errcode !== "M_USER_IN_USE") throw new WorkError("matrix_agent_provisioning_failed", 502);
  }
  private async open(agent: ManagedAgent): Promise<Runtime> {
    // Matrix off for the deployment or the agent: no homeserver call, a dormant transport (ADR 0005 19.2).
    const matrix = this.matrixOn && this.matrixState(agent) === "active";
    if (matrix) await this.provision(agent);
    const store = new ConnectorStore(join(this.config.stateDir, "agents", `${agent.id}.sqlite`), agent.matrixId);
    // This is an AS-owned journal, not an account restored from Matrix history.
    if (!store.get("meta", "sync")) store.set("meta", "sync", "0");
    // A new activation checkpoint after a dormant period: queued and late Matrix events of that period are ignored (19.1).
    if (matrix && store.get("meta", "matrix_runtime") === "dormant") {
      store.set("meta", "matrix_activation", Date.now());
      const sequence = this.store.get<number>("meta", "as_sequence") ?? 0;
      if (Number(store.get<string>("meta", "sync") ?? 0) < sequence) store.set("meta", "sync", String(sequence));
    }
    store.set("meta", "matrix_runtime", matrix ? "active" : "dormant");
    // Shadow ledger (ADR 0005 phase 1): created before the channel runtime so its core writes into it.
    // A ledger that cannot open (migration or registry error) leaves the agent on the legacy path only.
    try {
      const ledger = AgentLedger.open(store);
      ledger.authoritative = Boolean(this.config.ledgerRead && this.config.ledgerSend);
      ledger.features = { cards: ledger.authoritative && Boolean(this.config.ledgerCards), reset: ledger.authoritative && Boolean(this.config.ledgerControl) };
      this.ledgers.set(agent.id, ledger);
      ledger.listen((sessionKey) => { if (this.ledgers.get(agent.id) === ledger) this.hubs.hub(agent.owner).publish(agent.id, sessionKey); });
      ledger.listenStream((sessionKey, turnId, text) => { if (this.ledgers.get(agent.id) === ledger) this.hubs.hub(agent.owner).stream(agent.id, sessionKey, turnId, text); });
      this.persons.ensurePerson(agent.owner, agent.owner.slice(1, agent.owner.indexOf(":")));
      this.persons.link(personId(agent.owner), "matrix", this.config.serverName, agent.owner, "config");
    } catch { /* Shadow only: the legacy runtime starts regardless. */ }
    const transport: MatrixTransport = !matrix ? new DormantTransport(agent.matrixId) : this.dependencies.transport?.(agent, this.inbox) ?? new ApplicationTransport(
      this.matrixConfig().homeserver, this.matrixConfig().asToken, agent.matrixId, agent.id, this.inbox);
    const connector = new MatrixConnector(agent.matrixId, store, transport, undefined, 250);
    let extension: ServiceExtension | undefined;
    try {
      if (!store.get("meta", "managed_initialized")) {
        // The owner contact is local without Matrix (no social account data).
        await connector.updateContact({ address: agent.owner, note: "Owner", receive: "allow", execution: "allow" });
        store.set("meta", "matrix_initialized", false);
        store.set("meta", "managed_initialized", true);
      }
      // The Matrix display name is set once the account is active; legacy agents (no flag) were initialized with it.
      if (matrix && store.get("meta", "matrix_initialized") === false) {
        const ownerContact = connector.contact(agent.owner);
        if (ownerContact) await connector.social?.saveContact(ownerContact);
        await transport.data?.displayName(agent.name);
        store.set("meta", "matrix_initialized", true);
      }
      extension = await this.dependencies.configure?.(agent, connector);
      await connector.start();
      await extension?.start();
    } catch (error) { this.ledgers.delete(agent.id); await extension?.stop(); await connector.stop(); store.close(); throw error; }
    this.store.set("agents", agent.id, { ...agent, status: "active" });
    try { this.hubs.hub(agent.owner).sync(agent.id); } catch { /* The hub catches up on the next publication. */ }
    const token = newToken();
    return { connector, token, extension, app: createConnectorApp(connector, token, `${this.config.publicUrl}/agents/${agent.id}/gateway`) };
  }
  /** Components holding per-Agent work Router does not see (e.g. connection setup) can veto deletion. */
  guardDelete(guard: (agentId: string) => void) { this.deleteGuards.push(guard); }
  /**
   * Delete an Agent: product teardown, stop its runtime, deactivate its Matrix account and remove its state.
   * Once Router state is touched the Agent stays `deleting`; repeating the call finishes the removal.
   */
  async delete(owner: string, id: string): Promise<void> {
    const agent = this.owned(id, owner);
    if (agent.status !== "deleting") {
      for (const guard of this.deleteGuards) guard(id);
      if (this.runtimes.has(id) && this.activeRun((await this.runtime(id)).connector)) throw new WorkError("agent_has_active_or_unknown_run", 409);
      // Product teardown may itself quiesce the runtime, so it runs before this method takes the Agent's lock.
      await this.dependencies.beforeDelete?.(agent);
    }
    const previous = this.configurations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const operation = new Promise<void>((r) => { release = r; });
    this.configurations.set(id, operation);
    try {
      await previous.catch(() => {});
      if (this.agent(id).status !== "deleting") {
        const pending = this.runtimes.get(id);
        const runtime = pending && await pending;
        if (runtime && this.activeRun(runtime.connector)) throw new WorkError("agent_has_active_or_unknown_run", 409);
        this.store.set("agents", id, { ...this.agent(id), status: "deleting" });
        this.forgetLedger(agent);
        if (runtime) {
          this.runtimes.delete(id);
          await runtime.extension?.stop(); await runtime.connector.stop(); runtime.connector.store.close();
        }
      }
      await this.deprovision(agent);
      this.purge(agent);
    } finally {
      release();
      if (this.configurations.get(id) === operation) this.configurations.delete(id);
    }
    await this.dependencies.afterDelete?.(agent);
  }
  private activeRun(connector: MatrixConnector) {
    return connector.store.entries<{ phase: string }>("communication_runs")
      .some(({ value }) => ["running", "submitting", "unknown"].includes(value.phase));
  }
  private async deprovision(agent: ManagedAgent) {
    // No account (`none`): nothing to deactivate. Matrix off or a dormant agent: deactivation is skipped and the account
    // is remembered, so `matrix forget` lists it (ADR 0005 19.2).
    if (this.matrixState(agent) === "none") return;
    if (this.effectiveMatrix(agent) !== "active") {
      this.store.set("matrix_orphans", agent.matrixId, { agentId: agent.id, owner: agent.owner, deletedAt: new Date().toISOString() });
      return;
    }
    if (this.dependencies.deprovision) { await this.dependencies.deprovision(agent); return; }
    // Synapse lets an application service deactivate its own users without interactive auth;
    // deactivation leaves every room, rejects invites and removes the user from the directory.
    const { homeserver, asToken } = this.matrixConfig();
    const response = await fetch(`${homeserver}/_matrix/client/v3/account/deactivate?user_id=${encodeURIComponent(agent.matrixId)}`, {
      method: "POST", headers: { Authorization: `Bearer ${asToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ erase: false }), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return;
    const body = await response.json().catch(() => ({})) as { errcode?: string };
    if (body.errcode === "M_USER_DEACTIVATED") return;
    throw new WorkError("matrix_agent_deactivation_failed", 502);
  }
  /** Drop the agent's ledger and hub index; a hub error never blocks deletion. */
  private forgetLedger(agent: ManagedAgent) {
    this.ledgers.delete(agent.id);
    try { this.hubs.hub(agent.owner).forget(agent.id); } catch { /* The index is rebuilt from ledgers. */ }
  }
  private purge(agent: ManagedAgent) {
    this.forgetLedger(agent);
    this.store.transaction(() => {
      for (const { id, value } of this.store.entries<Record<string, string>>("as_members")) {
        if (!(agent.id in value)) continue;
        const { [agent.id]: _removed, ...rest } = value;
        if (Object.keys(rest).length) this.store.set("as_members", id, rest); else this.store.delete("as_members", id);
      }
      this.store.db.prepare("DELETE FROM documents WHERE collection=?").run(`as_queue:${agent.id}`);
      for (const { id, value } of this.store.entries<{ agentId: string }>("instances")) if (value.agentId === agent.id) this.store.delete("instances", id);
      for (const { id, value } of this.store.entries<{ agentId: string }>("connection_setup_jobs")) if (value.agentId === agent.id) this.store.delete("connection_setup_jobs", id);
      this.store.delete("matrix_agents", agent.matrixId);
      this.store.delete("agents", agent.id);
    });
    const journal = join(this.config.stateDir, "agents", `${agent.id}.sqlite`);
    for (const file of [journal, `${journal}-wal`, `${journal}-shm`]) rmSync(file, { force: true });
    rmSync(join(this.config.stateDir, "connections", "agents", agent.id), { recursive: true, force: true });
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
  async start(): Promise<void> { for (const agent of this.agents()) if (agent.status !== "deleting") await this.runtime(agent.id); }
  async close(): Promise<void> {
    await this.fanout?.stop();
    await Promise.allSettled(this.configurations.values());
    for (const pending of this.runtimes.values()) {
      try { const { connector, extension } = await pending; await extension?.stop(); await connector.stop(); connector.store.close(); } catch { /* Failed initialization already closed its store. */ }
    }
    this.runtimes.clear(); this.ledgers.clear(); this.attachments?.stop(); this.web?.close(); this.hubs.close(); this.store.close();
  }
}

/** Synapse → Router Application Service API, authenticated with the HS token. */
function mountApplicationService(app: express.Express, service: ManagedService) {
  const { hsToken } = service.matrixConfig();
  app.use("/_matrix/app/v1", (req, res, next) => {
    if (!equal(bearer(req), hsToken) || (req.query.access_token !== undefined && req.query.access_token !== hsToken)) {
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
}
export function createManagedApp(service: ManagedService, setup?: express.Router) {
  const app = express(); app.disable("x-powered-by");
  app.set("trust proxy", service.config.trustedProxies ?? false);
  const jsonBody = express.json({ limit: "2mb" });
  // The authenticated runtime parses attachment-bearing updates with a separate bound.
  app.use((req, res, next) => {
    if (req.method === "POST" && /^\/_agent-router\/v1\/agents\/[^/]+\/gateway\/api\/work\/[^/]+\/update$/.test(req.path)) next();
    // Attachment uploads stream their raw body (any content type, including application/json) to the blob store.
    else if (req.method === "POST" && req.path === "/_agent-router/v1/web/attachments") next();
    else jsonBody(req, res, next);
  });
  app.get("/health/live", (_req, res) => res.json({ status: "ok", component: "agent-service" }));
  // ADR 0005 19.2: the Application Service routes exist only while Matrix is on (otherwise the generic 404 below).
  if (service.matrixOn) mountApplicationService(app, service);
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
    // Without an active Matrix account there is no Matrix address to reach the agent at (19.2).
    res.json({ id: agent.id, address: agent.address, owner: agent.owner, name: agent.name, matrixId: service.matrixEnabled(agent.id) ? agent.matrixId : null });
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
    } else service.owned(agentId, (await service.authenticateRequest(req)).ownerId);
    const runtime = await service.runtime(agentId);
    req.headers.authorization = `Bearer ${runtime.token}`;
    runtime.app(req, res, next);
  });
  if (service.web) app.use(`${root}/web`, service.web.router);
  app.use(root, async (req, res, next) => {
    const principal = await service.authenticateRequest(req);
    res.locals.principal = principal; res.locals.owner = principal.ownerId; next();
  });
  // The authenticated owner (CLI edge login, ADR 0005 18.3): works for every principal, with or without Matrix.
  app.get(`${root}/account`, (_req, res) => {
    const { ownerId, personId: person, via, email } = res.locals.principal as OwnerPrincipal;
    res.set("Cache-Control", "no-store").json({ owner: ownerId, personId: person, via, ...(email ? { email } : {}), matrix: service.matrixOn });
  });
  app.get(`${root}/agents`, (_req, res) => res.json({ data: service.agents(res.locals.owner).map((agent) => service.publicAgent(agent)) }));
  app.post(`${root}/agents`, async (req, res) => {
    const { name } = z.object({ name: agentName }).strict().parse(req.body);
    res.status(201).json(service.publicAgent(await service.create(res.locals.owner, name)));
  });
  app.use(`${root}/agents/:agentId`, (req, res, next) => { service.owned(String(req.params.agentId), res.locals.owner); next(); });
  app.get(`${root}/agents/:agentId`, (req, res) => res.json(service.publicAgent(service.agent(req.params.agentId))));
  app.put(`${root}/agents/:agentId/matrix`, async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const agent = await service.setMatrix(res.locals.owner, req.params.agentId, enabled);
    res.json(agent.matrix);
  });
  app.delete(`${root}/agents/:agentId`, async (req, res) => { await service.delete(res.locals.owner, req.params.agentId); res.status(204).end(); });
  if (setup) app.use(setup);
  const extension = async (id: string) => {
    const runtime = await service.runtime(id);
    if (!runtime.extension) throw new WorkError("channels_not_configured", 404);
    return runtime.extension;
  };
  app.get(`${root}/agents/:agentId/communication`, async (req, res) => res.json((await extension(req.params.agentId)).status()));
  const observation = async (agentId: string) => {
    const value = (await extension(agentId)).observation;
    if (!value) throw new WorkError("host_observation_unavailable", 409);
    return value;
  };
  const communication = `${root}/agents/:agentId/communication`;
  const sessions = async (agentId: string) => {
    const value = (await extension(agentId)).sessions;
    if (!value) throw new WorkError("host_sessions_unavailable", 409);
    return value;
  };
  app.get(`${communication}/sessions`, async (req, res) => res.json({ data: (await sessions(req.params.agentId)).list() }));
  app.get(`${communication}/sessions/:sessionId`, async (req, res) => res.json((await sessions(req.params.agentId)).getSession(req.params.sessionId)));
  app.post(`${communication}/sessions/:sessionId/native`, async (req, res) => {
    const body = z.object({ action: z.enum(["read", "history", "items", "rename", "archive", "unarchive", "delete"]),
      name: z.string().min(1).max(1000).optional(), limit: z.number().int().min(1).max(1000).optional(),
      cursor: z.string().max(10000).optional(), turnId: z.string().max(160).optional(),
      itemsView: z.enum(["notLoaded", "summary", "full"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional(),
    }).strict().parse(req.body);
    res.json(await (await sessions(req.params.agentId)).native(req.params.sessionId, body));
  });
  app.post(`${communication}/sessions/:sessionId/fork`, async (req, res) => {
    const body = z.object({ targetSessionId: z.string().min(1).max(160), entryId: z.string().max(160).optional(), beforeEntryId: z.string().max(160).optional() }).strict().parse(req.body);
    const { targetSessionId, ...options } = body;
    res.json(await (await sessions(req.params.agentId)).fork(req.params.sessionId, targetSessionId, options));
  });
  app.post(`${communication}/sessions/:sessionId/steer`, async (req, res) => {
    const body = z.object({ input: z.string().min(1).max(24_000) }).strict().parse(req.body);
    await (await sessions(req.params.agentId)).steer(req.params.sessionId, body.input); res.json({ status: "accepted" });
  });
  app.post(`${communication}/work-events`, async (req, res) => {
    const body = z.object({ eventId: z.string().min(1).max(160), sessionId: z.string().min(1).max(160).optional(), input: z.string().max(24_000),
      context: z.json().optional(), inputItems: z.array(z.record(z.string(), z.json())).max(100).optional(),
      settings: z.record(z.string(), z.json()).optional(), mode: z.enum(["turn", "compact"]).optional(),
    }).strict().parse(req.body);
    res.status(202).json(await (await sessions(req.params.agentId)).submit({ ...body,
      admission: { kind: "owner", owner: res.locals.owner, agentId: req.params.agentId, reference: body.eventId } }));
  });
  app.get(`${communication}/work-events/:eventId`, async (req, res) => res.json((await sessions(req.params.agentId)).get(req.params.eventId)));
  app.post(`${communication}/work-events/:eventId/cancel`, async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(await (await sessions(req.params.agentId)).cancel(req.params.eventId));
  });
  app.get(`${communication}/tasks`, async (req, res) => {
    const filter = z.object({ connectionId: z.string().min(1).max(64).optional(), target: z.string().min(1).max(1024).optional(),
      conversationId: z.string().min(1).max(160).optional(), before: z.string().min(1).max(160).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
    res.json((await observation(req.params.agentId)).tasks(filter));
  });
  app.get(`${communication}/runs/:claimId`, async (req, res) => res.json(await (await observation(req.params.agentId)).run(req.params.claimId)));
  app.get(`${communication}/runs/:claimId/events`, async (req, res) => {
    const { after, limit } = z.object({ after: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(1000).default(200) }).strict().parse(req.query);
    res.json(await (await observation(req.params.agentId)).events(req.params.claimId, after, limit));
  });
  app.post(`${communication}/runs/:claimId/calls/:callId/result`, async (req, res) => {
    const body = z.object({ result: z.json() }).strict().parse(req.body);
    const runtime = await extension(req.params.agentId), value = await observation(req.params.agentId);
    const resolve = () => value.resolve(req.params.claimId, req.params.callId, body.result);
    // One card record for every answer surface (ADR 0005 16.1): the first answer wins, a later one is stale.
    const runId = runtime.control ? value.store.get<{ runId?: string }>("communication_runs", req.params.claimId)?.runId : undefined;
    const status = runtime.control && runId ? await runtime.control.record(runId, req.params.callId, { by: personId(res.locals.owner), surface: "run-api", result: body.result }, resolve)
      : (await resolve(), "accepted");
    res.json({ status });
  });
  app.post(`${communication}/tasks/:taskId/cancel`, async (req, res) => {
    z.object({}).strict().parse(req.body);
    await (await observation(req.params.agentId)).cancel(req.params.taskId);
    res.json({ status: "accepted" });
  });
  app.post(`${root}/agents/:agentId/communication/calls/:callId/result`, async (req, res) => {
    const body = z.object({ result: z.json() }).strict().parse(req.body);
    const status = await (await extension(req.params.agentId)).resolve(req.params.callId, body.result); res.json({ status: status ?? "accepted" });
  });
  app.post(`${root}/agents/:agentId/communication/runs/:claimId/reconcile`, async (req, res) => {
    const body = z.object({ runId: z.string().min(1).max(160) }).strict().parse(req.body);
    await (await extension(req.params.agentId)).reconcile(req.params.claimId, body.runId); res.json({ status: "accepted" });
  });
  app.post(`${root}/agents/:agentId/communication/runs/:claimId/close`, async (req, res) => {
    z.object({}).strict().parse(req.body);
    await (await extension(req.params.agentId)).closeUnknown(req.params.claimId); res.json({ status: "closed" });
  });
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
      .json({ error: error instanceof WorkError ? error.message : error instanceof z.ZodError ? "invalid_request" : "operation_failed",
        ...(error instanceof WorkError && error.nativeError !== undefined ? { nativeError: error.nativeError } : {}),
        ...(error instanceof WorkError && error.fields ? error.fields : {}),
        ...(error instanceof IdentityError ? error.details : {}) });
  });
  return app;
}
