import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { privateFile } from "../services/feishu/cli.js";
import {
  agentChannelConfigSchema,
  createChannelRuntime,
  loadChannelConfiguration,
  type AgentChannelConfig,
  type ChannelConfiguration,
} from "../service/channels.js";
import type { ManagedAgent, ManagedService } from "../matrix/managed.js";
import type { MatrixConnector } from "../matrix/connector.js";
import { WorkError } from "../matrix/cli-work.js";

const hostSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    label: z.string().min(1).max(100),
    url: z.url(),
    tokenFile: z.string().min(1),
    runtimeId: z.string().min(1).max(160),
    owners: z.array(z.string().min(1)).min(1),
  })
  .strict();
export const onboardingOptionsSchema = z
  .object({
    hosts: z.array(hostSchema).max(100).default([]),
    registration: z.boolean().default(false),
    productLoginUrl: z.url().optional(),
    mailServices: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
            label: z.string().min(1).max(100),
            url: z.url(),
            attachmentOrigins: z.array(z.url()).default([]),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    targets: z.array(z.string().min(1).max(512)).max(100).default([]),
  })
  .strict();
export type OnboardingOptions = z.infer<typeof onboardingOptionsSchema>;

/** Owner-scoped configuration; browsers select an operator-approved Host, never arbitrary server URLs/files. */
export class OnboardingConfiguration {
  readonly directory: string;
  readonly options: OnboardingOptions;
  private service!: ManagedService;
  private pending = new Map<string, AgentChannelConfig>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly stateDirectory: string,
    optionsFile: string,
    readonly initial?: ChannelConfiguration,
  ) {
    const base = dirname(resolve(optionsFile));
    this.options = onboardingOptionsSchema.parse(
      JSON.parse(readFileSync(optionsFile, "utf8")),
    );
    if (
      new Set(this.options.hosts.map((host) => host.id)).size !==
        this.options.hosts.length ||
      new Set(this.options.mailServices.map((mail) => mail.id)).size !==
        this.options.mailServices.length
    )
      throw new Error("duplicate_onboarding_profile");
    for (const host of this.options.hosts) {
      host.tokenFile = resolve(base, host.tokenFile);
      const url = new URL(host.url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new Error("invalid_host_url");
    }
    for (const raw of [
      ...this.options.mailServices.map((mail) => mail.url),
      ...(this.options.productLoginUrl ? [this.options.productLoginUrl] : []),
    ]) {
      const url = new URL(raw);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new Error("invalid_onboarding_url");
    }
    this.directory = resolve(stateDirectory, "onboarding");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    privateFile(join(this.directory, ".gitignore"), "*\n");
  }
  attach(service: ManagedService) {
    this.service = service;
  }
  agentDirectory(id: string): string {
    z.uuid().parse(id);
    return join(this.directory, "agents", id);
  }
  configuration(agent: ManagedAgent): AgentChannelConfig | undefined {
    const pending = this.pending.get(agent.id);
    if (pending) return pending;
    const file = join(this.agentDirectory(agent.id), "channels.json");
    if (existsSync(file)) return loadChannelConfiguration(file).agents[0];
    const source = this.initial?.agents.find(
      (item) => item.agentId === agent.id,
    );
    if (!source) return undefined;
    const copy = structuredClone(source),
      base = this.initial!.directory;
    if (copy.host) copy.host.tokenFile = resolve(base, copy.host.tokenFile);
    for (const connection of copy.connections) {
      if ("credentialsFile" in connection && connection.credentialsFile)
        connection.credentialsFile = resolve(base, connection.credentialsFile);
      if ("appSecretFile" in connection && connection.appSecretFile)
        connection.appSecretFile = resolve(base, connection.appSecretFile);
      if ("botTokenFile" in connection)
        connection.botTokenFile = resolve(base, connection.botTokenFile);
      if ("apiKeyFile" in connection)
        connection.apiKeyFile = resolve(base, connection.apiKeyFile);
    }
    return copy;
  }
  private runtime(
    agent: ManagedAgent,
    connector: MatrixConnector,
    config?: AgentChannelConfig,
  ) {
    if (!config) return undefined;
    return createChannelRuntime(
      agent,
      connector,
      config,
      this.agentDirectory(agent.id),
      (name) => {
        const issued = this.service.issue(agent.id, name);
        return {
          id: issued.instance.id,
          validate: () => {
            this.service.instance(issued.token, agent.id);
          },
        };
      },
    );
  }
  factory = async (agent: ManagedAgent, connector: MatrixConnector) =>
    this.runtime(agent, connector, this.configuration(agent));
  hosts(owner: string) {
    return this.options.hosts.filter((host) => host.owners.includes(owner));
  }
  assertTelegramAvailable(agentId: string, token: string) {
    for (const agent of this.service.agents())
      for (const connection of this.configuration(agent)?.connections ?? []) {
        if (connection.kind !== "telegram") continue;
        const existing = readFileSync(connection.botTokenFile, "utf8").trim();
        if (existing.split(":")[0] === token.split(":")[0])
          throw new WorkError("telegram_bot_already_connected", 409);
      }
  }
  async host(owner: string, agentId: string, hostId: string) {
    const host = this.hosts(owner).find((item) => item.id === hostId);
    if (!host) throw new WorkError("host_not_assigned_to_account", 403);
    return this.edit(owner, agentId, (config) => {
      config.host = {
        url: host.url,
        tokenFile: host.tokenFile,
        runtimeId: host.runtimeId,
        instanceName: "channel-host",
        instructions: "",
      };
    });
  }
  async edit(
    owner: string,
    agentId: string,
    update: (config: AgentChannelConfig) => void,
    signal?: AbortSignal,
  ) {
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted();
        const agent = this.service.owned(agentId, owner),
          directory = this.agentDirectory(agentId);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const prior = this.configuration(agent);
        const configurationFile = join(directory, "channels.json");
        const priorFile = existsSync(configurationFile)
          ? readFileSync(configurationFile, "utf8")
          : undefined;
        let commitAttempted = false;
        const config = agentChannelConfigSchema.parse(
          structuredClone(prior ?? { agentId, connections: [] }),
        );
        update(config);
        agentChannelConfigSchema.parse(config);
        // Validate all accounts together before replacing a connection. Never start two consumers for one account.
        const all = this.service
          .agents()
          .map((item) =>
            item.id === agentId ? config : this.configuration(item),
          )
          .filter(Boolean) as AgentChannelConfig[];
        const validationFile = join(this.directory, "validation.json");
        privateFile(validationFile, { agents: all });
        try {
          loadChannelConfiguration(validationFile);
        } finally {
          unlinkSync(validationFile);
        }
        const runtime = await this.service.runtime(agentId),
          priorScope = runtime.connector.store.get<string>(
            "communication_host",
            "scope",
          );
        const hasRuns =
          runtime.connector.store.entries("communication_runs").length > 0;
        const restore = () => {
          if (!hasRuns) {
            if (priorScope)
              runtime.connector.store.set(
                "communication_host",
                "scope",
                priorScope,
              );
            else runtime.connector.store.delete("communication_host", "scope");
          }
          this.pending.delete(agentId);
          if (commitAttempted) {
            if (priorFile !== undefined)
              privateFile(configurationFile, priorFile);
            else if (existsSync(configurationFile))
              unlinkSync(configurationFile);
          }
        };
        await this.service.configureRuntime(
          agentId,
          async (agent, connector) => {
            signal?.throwIfAborted();
            if (!hasRuns) connector.store.delete("communication_host", "scope");
            this.pending.set(agentId, config);
            return this.runtime(agent, connector, config);
          },
          async (agent, connector) => {
            restore();
            return this.runtime(agent, connector, prior);
          },
          () => {
            signal?.throwIfAborted();
            commitAttempted = true;
            privateFile(configurationFile, { agents: [config] });
            this.pending.delete(agentId);
          },
        );
        return this.summary(agent);
      });
    this.queue = operation.catch(() => {});
    return operation;
  }
  summary(agent: ManagedAgent) {
    const config = this.configuration(agent);
    const profile =
      config?.host &&
      this.hosts(agent.owner).find(
        (host) =>
          host.url === config.host!.url &&
          host.tokenFile === config.host!.tokenFile &&
          host.runtimeId === config.host!.runtimeId,
      );
    return {
      agent,
      host: config?.host
        ? { runtimeId: config.host.runtimeId, profileId: profile?.id ?? null }
        : null,
      connections: (config?.connections ?? []).map((connection) => ({
        id: connection.id,
        kind: connection.kind,
        ...(connection.kind === "feishu"
          ? { personalTools: connection.personalTools }
          : {}),
      })),
    };
  }
}
