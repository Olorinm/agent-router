import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { privateFile } from "../services/feishu/cli.js";
import {
  agentChannelConfigSchema,
  createChannelRuntime,
  loadChannelConfiguration,
  type AgentChannelConfig,
} from "../service/channels.js";
import type { ManagedAgent, ManagedService } from "../matrix/managed.js";
import type { MatrixConnector } from "../matrix/connector.js";
import type { HostPort } from "../execution/host.js";
import type { ServiceHttp } from "../channels/http.js";
import { WorkError } from "../matrix/cli-work.js";
export interface HostBindingProvider {
  assertReady(agentId: string, binding: string): void;
  host(agentId: string, binding: string): HostPort;
  http(agentId: string, binding: string): ServiceHttp;
}

export const connectionOptionsSchema = z
  .object({
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
  })
  .strict();
export type ConnectionOptions = z.infer<typeof connectionOptionsSchema>;

/** Owner-scoped channel connections; Host bindings come only from trusted application code. */
export class ConnectionConfiguration {
  readonly directory: string;
  readonly options: ConnectionOptions;
  private service!: ManagedService;
  private pending = new Map<string, AgentChannelConfig>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly stateDirectory: string,
    options: string | z.input<typeof connectionOptionsSchema>,
    readonly hosts?: HostBindingProvider,
  ) {
    this.options = connectionOptionsSchema.parse(
      typeof options === "string" ? JSON.parse(readFileSync(options, "utf8")) : options,
    );
    if (new Set(this.options.mailServices.map((mail) => mail.id)).size !== this.options.mailServices.length)
      throw new Error("duplicate_mail_service");
    for (const raw of [...this.options.mailServices.map((mail) => mail.url)]) {
      const url = new URL(raw);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new Error("invalid_mail_service_url");
    }
    this.directory = resolve(stateDirectory, "connections");
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
    return undefined;
  }
  private runtime(
    agent: ManagedAgent,
    connector: MatrixConnector,
    config?: AgentChannelConfig,
  ) {
    if (!config) return undefined;
    if (config.host?.binding && !this.hosts) throw new WorkError("host_binding_provider_required", 503);
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
            if (config.host?.binding)
              this.hosts!.assertReady(agent.id, config.host.binding);
          },
        };
      },
      config.host?.binding
        ? this.hosts!.host(agent.id, config.host.binding)
        : undefined,
    );
  }
  factory = async (agent: ManagedAgent, connector: MatrixConnector) =>
    this.runtime(agent, connector, this.configuration(agent));
  assertTelegramAvailable(token: string) {
    for (const agent of this.service.agents())
      for (const connection of this.configuration(agent)?.connections ?? []) {
        if (connection.kind !== "telegram") continue;
        const existing = readFileSync(connection.botTokenFile, "utf8").trim();
        if (existing.split(":")[0] === token.split(":")[0])
          throw new WorkError("telegram_bot_already_connected", 409);
      }
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
        let hasRuns =
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
        try {
          await this.service.configureRuntime(
            agentId,
            async (agent, connector) => {
              signal?.throwIfAborted();
              hasRuns =
                connector.store.entries("communication_runs").length > 0;
              if (!hasRuns)
                connector.store.delete("communication_host", "scope");
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
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "host_binding_configuration_changed"
          )
            throw new WorkError(error.message, 409);
          throw error;
        }
        return this.summary(agent);
      });
    this.queue = operation.catch(() => {});
    return operation;
  }
  /** Quiesce delivery and reject running/unknown work before a trusted lifecycle operation. */
  async withStoppedRuntime(owner: string, agentId: string, operation: () => Promise<void>, rollback: () => Promise<void>) {
    this.service.owned(agentId, owner);
    await this.service.configureRuntime(agentId,
      async (agent, connector) => { await operation(); return this.factory(agent, connector); },
      async (agent, connector) => { await rollback(); return this.factory(agent, connector); });
  }
  summary(agent: ManagedAgent) {
    const config = this.configuration(agent);
    return {
      agent,
      host: config?.host
        ? { runtimeId: config.host.runtimeId }
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
