import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { ManagedAgent, ServiceExtension } from "../matrix/managed.js";
import type { MatrixConnector } from "../matrix/connector.js";
import { CommunicationCore } from "../communication/core.js";
import { ServiceHttp } from "../http.js";
import { HttpAgentHost, type HostPort } from "../execution/host.js";
import { RunObservation } from "../execution/observation.js";
import { HostWorker } from "../execution/host-worker.js";
import { WorkSessions } from "../execution/sessions.js";
import { key } from "../execution/protocol.js";
import { ChannelTools } from "../communication/tools.js";
import { personId, type IdentityProvider, type PersonRegistry } from "../ledger/registry.js";
import { mailPairingCommand, pairingCommand, REPLIES, senderIdentities, type Identities } from "../ledger/identity.js";
import { AgentLedger } from "../ledger/ledger.js";
import { LedgerControl } from "../ledger/control.js";
import { ROOM_CONNECTION, WEB_CONNECTION } from "../ledger/surfaces.js";
import type { HubRooms } from "../ledger/rooms.js";
import type { OwnerAttachments } from "../ledger/blobs-hub.js";
import type { ChannelFiles } from "../channels/api.js";
import { channelModule, connectionSchema, findChannelModule, RoomChannel, WebChannel } from "../channels/registry.js";

const file = z.string().min(1);
export const agentChannelConfigSchema = z.object({ agentId: z.uuid(), connections: z.array(connectionSchema).max(20),
  host: z.object({ binding: z.string().min(1).optional(), url: z.url().optional(), tokenFile: file.optional(), runtimeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/),
    instanceName: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/).default("channel-host"), instructions: z.string().max(200_000).default("") }).strict().superRefine((host, context) => {
    if (host.binding ? host.url !== undefined || host.tokenFile !== undefined : !host.url || !host.tokenFile)
      context.addIssue({ code: "custom", message: "host_requires_binding_or_http_credentials" });
  }).optional() }).strict();
export const channelConfigSchema = z.object({ agents: z.array(agentChannelConfigSchema).min(1).max(100) }).strict().superRefine((config, context) => {
  if (new Set(config.agents.map((agent) => agent.agentId)).size !== config.agents.length) context.addIssue({ code: "custom", message: "duplicate_agent_id" });
  for (const agent of config.agents) {
    if (new Set(agent.connections.map((item) => item.id)).size !== agent.connections.length) context.addIssue({ code: "custom", message: "duplicate_connection_id" });
    for (const kind of new Set(agent.connections.map((item) => item.kind)))
      if (findChannelModule(kind)?.singleton && agent.connections.filter((item) => item.kind === kind).length > 1) context.addIssue({ code: "custom", message: `one_${kind}_connection_per_agent` });
    if (agent.connections.some((item) => item.id === WEB_CONNECTION)) context.addIssue({ code: "custom", message: "connection_id_reserved_for_web" });
    if (agent.connections.some((item) => item.id === ROOM_CONNECTION)) context.addIssue({ code: "custom", message: "connection_id_reserved_for_room" });
    for (const item of agent.connections)
      for (const message of findChannelModule(item.kind)?.validate?.(item) ?? []) context.addIssue({ code: "custom", message });
  }
});
export type AgentChannelConfig = z.infer<typeof agentChannelConfigSchema>;
export interface ChannelConfiguration { agents: AgentChannelConfig[]; directory: string; }
/** Credential files of a configuration, resolved against its directory. */
export function channelFiles(directory: string): ChannelFiles {
  return { directory, path: (path) => resolve(directory, path), read: (path) => readFileSync(resolve(directory, path), "utf8").trim(),
    secret: (path) => secret(directory, path) };
}
export function loadChannelConfiguration(path: string): ChannelConfiguration {
  const config = { ...channelConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))), directory: dirname(resolve(path)) };
  const accounts = new Set<string>(), files = channelFiles(config.directory);
  for (const agent of config.agents) for (const item of agent.connections) {
    const identity = key(item.kind, channelModule(item.kind).account(item, { agentId: agent.agentId, files }));
    if (accounts.has(identity)) throw new Error("channel_account_configured_more_than_once");
    accounts.add(identity);
  }
  return config;
}
function secret(directory: string, path: string): string {
  const value = readFileSync(resolve(directory, path), "utf8").trim();
  if (!value) throw new Error("empty_channel_credential");
  return value;
}

/**
 * Owner resolution by person and the `/link` control path for one agent's channels (ADR 0005 18.1, 18.4).
 * Pairing only matches the agent owner's codes, so it links the owner's own identities; strangers keep the
 * visitor flow. Registry or hub errors never fail a receipt: resolution falls back to configured addresses.
 */
export function identityHooks(identity: Identities, ownerId: string, namespaces: Map<string, { provider: IdentityProvider; namespace: string }>,
  mailPairing: Set<string>): NonNullable<CommunicationCore["identity"]> {
  const scoped = (connectionId: string, source: Parameters<typeof senderIdentities>[2]) => {
    const scope = namespaces.get(connectionId); return scope ? senderIdentities(scope.provider, scope.namespace, source) : undefined;
  };
  return {
    person: (connectionId, source) => { try { const ids = scoped(connectionId, source); return ids ? identity.resolve(ids) : undefined; } catch { return undefined; } },
    seen: (connectionId, source) => { const ids = scoped(connectionId, source); if (ids) identity.seen(ids[0]!); },
    pair: (connectionId, source) => {
      const scope = namespaces.get(connectionId); if (!scope) return undefined;
      const mail = scope.provider === "grove-mail" || scope.provider === "agentmail";
      const code = mail ? mailPairingCommand(source) : pairingCommand(source.text);
      if (!code) return undefined;
      // In groups the command is dropped without a reply, so a code is never confirmed in front of others.
      if (source.scope !== "direct") return {};
      if (mail && !(mailPairing.has(connectionId) && source.native?.senderVerified === true)) return { reply: REPLIES.unverified };
      try { return { reply: identity.attempt(ownerId, scoped(connectionId, source)!, code).reply }; }
      catch { return { reply: "暂时无法关联，请稍后再试。" }; }
    },
  };
}

export async function createChannelRuntime(agent: ManagedAgent, connector: MatrixConnector, config: AgentChannelConfig,
  directory: string, issue: (name: string) => { id: string; validate: () => void; wake?: () => void }, suppliedHost?: HostPort,
  options: { ownedAgent?(matrixId: string): boolean; persons?: PersonRegistry | undefined; identity?: Identities | undefined;
    attachments?: OwnerAttachments | undefined;
    /** The owner's hub rooms (ADR 0005 phase 5); registers the `room` connection. */
    rooms?: (() => HubRooms | undefined) | undefined;
    /** False while Matrix is off for the deployment or this agent (ADR 0005 19.2); default true. */
    matrix?: boolean | undefined } = {}): Promise<ServiceExtension> {
  if (!connector.cli) throw new Error("channels_require_durable_work_queue");
  const core = new CommunicationCore(agent.id, connector.store, connector.cli, () => connector.assertLease());
  // Ledger identity (ADR 0005 section 9): who is speaking, scoped by provider and namespace. Routing is unchanged.
  const owner = personId(agent.owner), namespaces = new Map<string, { provider: IdentityProvider; namespace: string }>();
  core.ownerPersonId = owner;
  if (options.persons) core.persons = (connectionId, sender) => {
    const scope = namespaces.get(connectionId); return scope ? options.persons!.resolve(scope.provider, scope.namespace, sender) : undefined;
  };
  const mailPairing = new Set<string>();
  if (options.identity) core.identity = identityHooks(options.identity, agent.owner, namespaces, mailPairing);
  // Matrix connections stay configured but are not registered while Matrix is off; status shows them as disabled.
  const disabled = options.matrix === false ? config.connections.filter((item) => item.kind === "matrix") : [];
  const context = { agentId: agent.id, owner: agent.owner, files: channelFiles(directory),
    services: { matrix: { connector, trusted: (member: string) => member === agent.owner || Boolean(options.ownedAgent?.(member)) } } };
  for (const definition of config.connections) {
    if (definition.kind === "matrix" && options.matrix === false) continue;
    const channel = await channelModule(definition.kind).create(definition, context);
    const { adapter } = channel, ownerAddresses = channel.ownerAddresses ?? definition.ownerAddresses, namespace = channel.namespace ?? "";
    namespaces.set(definition.id, { provider: definition.kind, namespace });
    if (channel.mailPairing) mailPairing.add(definition.id);
    // Identity seeding is shadow data: a registry error never blocks the channel.
    try { for (const address of ownerAddresses) options.persons?.link(owner, definition.kind, namespace, address, "config"); } catch { /* Seeded again on the next start. */ }
    core.register({ id: definition.id, ownerAddresses, peerAddresses: definition.peerAddresses, groupIds: definition.groupIds }, adapter,
      channel.reload ?? (() => adapter));
    if (channel.eager) await adapter.start(core.context(definition.id));
  }
  // Owner web messages (ADR 0005 phase 3, `ledgerSend`): replies to it are recorded, not sent. Without the flag the
  // connection is not registered, so channel status and dispatch are unchanged.
  const web = AgentLedger.attached(connector.store)?.authoritative ? new WebChannel(core, agent.owner, options.attachments) : undefined;
  if (web) core.register({ id: WEB_CONNECTION, ownerAddresses: [owner] }, web);
  // Hub rooms (ADR 0005 phase 5). Only the owner's addressed room messages arrive here, through the fan-out worker.
  const room = options.rooms ? new RoomChannel(core, agent.id, agent.owner, options.rooms) : undefined;
  if (room) core.register({ id: ROOM_CONNECTION, ownerAddresses: [agent.owner] }, room);
  let worker: HostWorker | undefined;
  if (config.host) {
    const instance = issue(config.host.instanceName);
    if (config.host.binding && !suppliedHost) throw new Error("host_binding_provider_required");
    const host = suppliedHost ?? new HttpAgentHost(new ServiceHttp(config.host.url!, secret(directory, config.host.tokenFile!)));
    const channelTools = new ChannelTools(core, host);
    worker = new HostWorker(agent.id, instance.id, connector.store, connector.cli,
      host, config.host.runtimeId,
      config.host.instructions, () => { connector.assertLease(); instance.validate(); }, (taskId, answer) => core.saveResult(taskId, answer),
      { definitions: [channelTools.definition],
        instructions: "\nUse the channel tool to inspect native communication capabilities and send files or supported native content. Never automatically repeat an operation with an uncertain outcome.\n",
        allowed: (_conversationId, taskId) => Boolean(core.input(taskId)),
        execute: (call) => channelTools.execute(call) }, core, instance.wake, {
          // Private groups (owner plus the owner's agents) get the owner's grants; mixed groups do not.
          admission: (contextId, taskId) => core.isOwnerTask(contextId, taskId) || core.isPrivateGroupOwnerTask(contextId, taskId)
            ? { kind: "owner", owner: agent.owner, agentId: agent.id, reference: taskId } : undefined,
        });
  }
  const observation = worker ? new RunObservation(connector.store, connector.cli, worker.host) : undefined;
  // Phase 4 (ADR 0005 section 16): one card record for every answer surface, and owner control over the session.
  const control = core.ledger ? new LedgerControl({ agentId: agent.id, ownerPersonId: owner, store: connector.store, ledger: core.ledger, core,
    work: connector.cli, observation, host: worker?.host, ...(worker ? { closeUnknown: (claimId: string) => worker!.closeUnknown(claimId) } : {}),
    ...(options.attachments ? { releaseAttachments: (ids: string[]) => options.attachments!.releaseAgent(agent.owner, agent.id, ids) } : {}) }) : undefined;
  if (worker) worker.control = control;
  if (worker || control) core.control = async (input) => Boolean(await control?.command(input)) || Boolean(await worker?.handleInput(input));
  const sessions = worker ? new WorkSessions(agent.id, agent.owner, config.host!.runtimeId, worker.instanceId,
    connector.store, connector.cli, worker.host, core, () => connector.assertLease(), input => worker!.dependencyWait(input)) : undefined;
  if (worker && sessions) worker.prepareSession = (contextId, taskId) => sessions.prepareChannelSession(contextId, taskId);
  const controller = new AbortController();
  let loops: Promise<void>[] = [];
  const loop = async (operation: () => Promise<void>, interval: number) => {
    while (!controller.signal.aborted) {
      try { await operation(); } catch { /* Durable records remain pending; status exposes channel/Host failures. */ }
      try { await sleep(interval, undefined, { signal: controller.signal }); } catch { break; }
    }
  };
  return {
    start: async () => { await core.start(); loops = [loop(async () => { await core.reconnect(); await core.dispatch(); await core.flush(); }, 250),
      ...(worker ? [loop(() => worker!.tick(), 1000)] : [])]; },
    stop: async () => { controller.abort(); await core.stop(); await Promise.allSettled(loops); },
    status: () => {
      const status = core.status();
      return { ...status, connections: [...status.connections, ...disabled.map((item) => ({ id: item.id, kind: item.kind, started: false,
        capabilities: null, error: null, disabled: "matrix_off" }))], host: worker?.status() ?? null };
    },
    communication: core, ...(web ? { web } : {}), ...(control ? { control } : {}), ...(room ? { room } : {}),
    ...(observation ? { observation } : {}),
    ...(sessions ? { sessions } : {}),
    resolve: async (callId, result) => {
      if (!worker) throw new Error("host_not_configured");
      const call = worker.status().calls.find((item) => item.id === callId);
      if (!control || !call) { await worker.resolve(callId, result); return "accepted"; }
      return control.record(call.runId, callId, { by: owner, surface: "run-api", result }, () => worker!.resolve(callId, result));
    },
    reconcile: async (claimId, runId) => { if (!worker) throw new Error("host_not_configured"); await worker.reconcile(claimId, runId); },
    closeUnknown: async (claimId) => { if (!worker) throw new Error("host_not_configured"); await worker.closeUnknown(claimId); },
    readAttachment: (inputId, reference) => core.readStoredAttachment(inputId, reference),
  };
}
