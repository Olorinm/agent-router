import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DurableStore } from "../communication/store.js";
import { WorkError } from "../matrix/cli-work.js";
import { ServiceHttp } from "../channels/http.js";
import { HttpAgentHost } from "../execution/host.js";
import { privateFile } from "../services/feishu/cli.js";
import type { OnboardingConfiguration } from "./configuration.js";
import type { ManagedService } from "../matrix/managed.js";

const key = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const remotePath = z
  .string()
  .refine(
    (p) =>
      p.startsWith("/") &&
      !p.includes("\0") &&
      posix.normalize(p) === p &&
      p !== "/",
    "absolute normalized path required",
  );
export const environmentOptionsSchema = z
  .object({
    configFile: z.string().min(1),
    modulePath: z.string().min(1).optional(),
    profiles: z
      .array(
        z
          .object({
            id: key,
            label: z.string().min(1).max(100),
            owners: z.array(z.string().min(1)).min(1),
            provider: z.string().min(1),
            template: z.string().min(1),
            kernel: z.string().min(1).max(48),
            runtimeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/),
            hostConfigFile: z.string().min(1),
            directory: remotePath.default("/home/user/.agent-host-service"),
            port: z.number().int().min(1).max(65535).default(37420),
            lifetimeSeconds: z.number().int().min(600).max(86400).default(3600),
            onTimeout: z.enum(["kill", "pause"]).default("kill"),
            files: z
              .array(
                z
                  .object({
                    source: z.string().min(1),
                    destination: remotePath,
                  })
                  .strict(),
              )
              .max(30)
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
type Profile = z.infer<typeof environmentOptionsSchema>["profiles"][number];
type Ref = { provider: string; id: string };
export interface EnvironmentProvider {
  create(input: {
    template: string;
    timeoutSeconds: number;
    onTimeout: "kill" | "pause";
    metadata: Record<string, string>;
  }): Promise<Ref>;
  list(metadata: Record<string, string>): Promise<Array<Ref>>;
  info(id: string): Promise<{ state: string }>;
  resume(id: string, seconds: number): Promise<{ state: string }>;
  pause(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  setTimeout(id: string, seconds: number): Promise<void>;
  httpEndpoint(
    id: string,
    port: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  exec(
    id: string,
    argv: string[],
    options: {
      onExit: (result: { exitCode: number | null }) => void;
      timeoutSeconds: number;
    },
  ): AsyncIterable<{ stream: string; text: string }>;
  writeFile(id: string, path: string, data: string | Uint8Array): Promise<void>;
}
export interface Environments {
  provider(id: string): EnvironmentProvider;
}
type Phase =
  | "creating"
  | "starting"
  | "ready"
  | "pausing"
  | "paused"
  | "resuming"
  | "deleting"
  | "deleted"
  | "needs_action";
interface Binding {
  agentId: string;
  operationId: string;
  profileId: string;
  profileHash: string;
  provider: string;
  phase: Phase;
  ref?: Ref;
  error?: string;
  updatedAt: string;
}
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const collection = "environments";
// Display labels and account assignment are not native execution identity.
const profileHash = ({
  owners: _owners,
  label: _label,
  ...execution
}: Profile) => hash(JSON.stringify(execution));

/** Product-owned provisioning journal; the external module alone operates cloud resources. */
export class EnvironmentOnboarding {
  readonly options: z.infer<typeof environmentOptionsSchema>;
  private readonly store: DurableStore;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly lease = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private manager: Promise<Environments> | undefined;
  private closed = false;
  private readonly controller = new AbortController();
  constructor(
    private readonly configuration: OnboardingConfiguration,
    private readonly service: ManagedService,
    options: z.infer<typeof environmentOptionsSchema>,
    base: string,
    private readonly load?: () => Promise<Environments>,
  ) {
    this.options = structuredClone(options);
    this.options.configFile = resolve(base, options.configFile);
    if (options.modulePath)
      this.options.modulePath = resolve(base, options.modulePath);
    if (
      new Set(options.profiles.map((p) => p.id)).size !==
      options.profiles.length
    )
      throw new Error("duplicate_environment_profile");
    for (const p of this.options.profiles) {
      p.hostConfigFile = resolve(base, p.hostConfigFile);
      for (const f of p.files) f.source = resolve(base, f.source);
    }
    this.store = new DurableStore(
      join(configuration.directory, "environments.sqlite"),
      service.config.serverName,
    );
    try {
      this.store.acquireLease(this.lease);
    } catch (error) {
      this.store.close();
      throw error;
    }
    // Interrupted mutations require explicit reconciliation, never a second create.
    for (const { value } of this.store.entries<Binding>(collection))
      if (
        ["creating", "starting", "pausing", "resuming", "deleting"].includes(
          value.phase,
        )
      )
        this.save({
          ...value,
          phase: "needs_action",
          error: "environment_operation_interrupted",
        });
    this.timer = setInterval(() => void this.maintain(), 30_000);
    this.timer.unref();
    // Lease refresh must be shorter than DurableStore's 30-second lease.
    this.leaseTimer = setInterval(() => {
      try {
        this.store.acquireLease(this.lease);
      } catch {
        clearInterval(this.timer);
        clearInterval(this.leaseTimer);
        this.controller.abort();
      }
    }, 10_000);
    this.leaseTimer.unref();
  }
  private leaseTimer: ReturnType<typeof setInterval>;
  private assertOpen() {
    if (this.closed || this.controller.signal.aborted)
      throw new WorkError("environment_coordinator_unavailable", 503);
    this.assertLease();
  }
  private assertLease() {
    const lease = this.store.get<{ owner: string; expires: number }>(
      "meta",
      "lease",
    );
    if (lease?.owner !== this.lease || lease.expires <= Date.now())
      throw new WorkError("environment_coordinator_unavailable", 503);
  }
  private save(record: Binding) {
    this.assertLease();
    this.store.set(collection, record.agentId, {
      ...record,
      updatedAt: new Date().toISOString(),
    });
  }
  private binding(id: string) {
    return this.store.get<Binding>(collection, id);
  }
  private async provider(record: Binding) {
    this.manager ??= this.load ? this.load() : this.importManager();
    try {
      return (await this.manager).provider(record.provider);
    } catch {
      this.manager = undefined;
      throw new WorkError("environment_provider_unavailable", 503);
    }
  }
  private async importManager(): Promise<Environments> {
    const specifier = this.options.modulePath
      ? pathToFileURL(this.options.modulePath).href
      : "@olorinm/agent-environment";
    const module = await import(specifier);
    if (typeof module.loadConfiguration !== "function")
      throw new Error("invalid_environment_module");
    return module.loadConfiguration(this.options.configFile);
  }
  profiles(owner: string) {
    return this.options.profiles.filter(
      (p) => p.owners.includes(owner) || p.owners.includes("*"),
    );
  }
  private profile(record: Binding): Profile {
    const p = this.options.profiles.find((p) => p.id === record.profileId);
    if (!p || profileHash(p) !== record.profileHash)
      throw new WorkError("environment_profile_changed", 409);
    return p;
  }
  summary(owner: string, agentId: string) {
    this.service.owned(agentId, owner);
    return this.view(this.binding(agentId));
  }
  private view(record: Binding | undefined) {
    return record
      ? {
          operationId: record.operationId,
          profileId: record.profileId,
          state: record.phase,
          busy: this.jobs.has(record.agentId),
          updatedAt: record.updatedAt,
          ...(record.error ? { error: record.error } : {}),
        }
      : null;
  }
  async begin(owner: string, agentId: string, profileId: string) {
    this.assertOpen();
    const agent = this.service.owned(agentId, owner);
    const profile = this.profiles(owner).find((p) => p.id === profileId);
    if (!profile) throw new WorkError("environment_profile_not_assigned", 403);
    const existing = this.binding(agentId);
    if (existing) {
      if (existing.profileId !== profileId)
        throw new WorkError("environment_already_bound", 409);
      return this.view(existing);
    }
    if (this.configuration.configuration(agent)?.host)
      throw new WorkError("host_already_bound", 409);
    // Validate private local inputs before making a billable request.
    this.bundle(profile);
    const record: Binding = {
      agentId,
      operationId: randomUUID(),
      profileId,
      profileHash: profileHash(profile),
      provider: profile.provider,
      phase: "creating",
      updatedAt: new Date().toISOString(),
    };
    const provider = await this.provider(record);
    this.assertOpen();
    const inserted = this.store.transaction(() =>
      this.store.insert(collection, agentId, record),
    );
    if (!inserted) {
      const winner = this.binding(agentId)!;
      if (winner.profileId !== profileId)
        throw new WorkError("environment_already_bound", 409);
      return this.view(winner);
    }
    this.launch(record, async () => {
      record.ref = await provider.create({
        template: profile.template,
        timeoutSeconds: profile.lifetimeSeconds,
        onTimeout: profile.onTimeout,
        metadata: { "router-operation": record.operationId },
      });
      this.save(record); // durable ID precedes bootstrap or further network work
      await this.bootstrap(owner, record, provider, profile);
    });
    return this.view(record);
  }
  private bundle(profile: Profile) {
    const content = readFileSync(profile.hostConfigFile, "utf8");
    const config = JSON.parse(content) as {
      runtimes?: Array<{ id: string; kernel: string }>;
      stateDirectory?: string;
    };
    if (
      !config.runtimes?.some(
        (r) => r.id === profile.runtimeId && r.kernel === profile.kernel,
      )
    )
      throw new WorkError("environment_runtime_profile_mismatch", 409);
    for (const file of profile.files) readFileSync(file.source);
    return content;
  }
  private launch(record: Binding, operation: () => Promise<void>) {
    if (this.jobs.has(record.agentId))
      throw new WorkError("environment_operation_running", 409);
    const job = Promise.resolve()
      .then(() => {
        this.assertOpen();
        return operation();
      })
      .catch((error) => {
        const code =
          error instanceof WorkError
            ? error.message
            : "environment_operation_unconfirmed";
        const unchanged =
          record.phase === "ready" &&
          code === "agent_has_active_or_unknown_run";
        this.save({
          ...record,
          phase: unchanged ? "ready" : "needs_action",
          error: code,
        });
      })
      .finally(() => {
        this.jobs.delete(record.agentId);
      });
    this.jobs.set(record.agentId, job);
    // A journal failure must stop new work, without an unhandled rejection.
    void job.catch(() => this.controller.abort());
  }
  private async exec(
    provider: EnvironmentProvider,
    id: string,
    argv: string[],
  ) {
    this.assertOpen();
    let exit: number | null = null;
    for await (const _ of provider.exec(id, argv, {
      timeoutSeconds: 60,
      onExit: (e) => {
        exit = e.exitCode;
      },
    })) {
      /* Never log private command output. */
    }
    if (exit !== 0)
      throw new WorkError("environment_bootstrap_command_failed", 502);
  }
  private token(record: Binding) {
    return join(
      this.configuration.agentDirectory(record.agentId),
      "environment-token",
    );
  }
  private async bootstrap(
    owner: string,
    record: Binding,
    provider: EnvironmentProvider,
    profile: Profile,
  ) {
    const id = record.ref!.id;
    record.phase = "starting";
    delete record.error;
    this.save(record);
    const config = this.bundle(profile),
      tokenFile = this.token(record);
    let token: string;
    try {
      token = readFileSync(tokenFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      token = randomBytes(32).toString("base64url");
      privateFile(tokenFile, token);
    }
    await this.exec(provider, id, ["mkdir", "-p", "--", profile.directory]);
    await this.exec(provider, id, ["chmod", "--", "700", profile.directory]);
    // The image's entrypoint is already waiting. Publish readiness only after all private files.
    for (const file of profile.files) {
      await this.exec(provider, id, [
        "mkdir",
        "-p",
        "--",
        posix.dirname(file.destination),
      ]);
      await this.exec(provider, id, [
        "chmod",
        "--",
        "700",
        posix.dirname(file.destination),
      ]);
      await provider.writeFile(id, file.destination, readFileSync(file.source));
      await this.exec(provider, id, ["chmod", "--", "600", file.destination]);
    }
    const dir = profile.directory;
    await provider.writeFile(id, posix.join(dir, "host.json.upload"), config);
    await provider.writeFile(id, posix.join(dir, "token.upload"), token);
    await this.exec(provider, id, [
      "chmod",
      "--",
      "600",
      posix.join(dir, "host.json.upload"),
      posix.join(dir, "token.upload"),
    ]);
    await this.exec(provider, id, [
      "mv",
      "--",
      posix.join(dir, "host.json.upload"),
      posix.join(dir, "host.json"),
    ]);
    await this.exec(provider, id, [
      "mv",
      "--",
      posix.join(dir, "token.upload"),
      posix.join(dir, "token"),
    ]);
    await provider.writeFile(
      id,
      posix.join(dir, "ready.json.upload"),
      JSON.stringify({
        version: 1,
        configSha256: hash(config),
        tokenSha256: hash(token),
      }),
    );
    await this.exec(provider, id, [
      "mv",
      "--",
      posix.join(dir, "ready.json.upload"),
      posix.join(dir, "ready.json"),
    ]);
    await this.ready(record, profile);
    await this.configuration.edit(owner, record.agentId, (config) => {
      config.host = {
        url: `https://${record.agentId}.environment.invalid`,
        tokenFile,
        runtimeId: profile.runtimeId,
        instanceName: "channel-host",
        instructions: "",
        environment: record.operationId,
      };
    });
    record.phase = "ready";
    delete record.error;
    this.save(record);
  }
  http(
    agentId: string,
    operationId: string,
    allowStarting = false,
  ): ServiceHttp {
    const coordinator = this;
    return new (class extends ServiceHttp {
      override async request(
        path: string,
        options: Parameters<ServiceHttp["request"]>[1] = {},
      ) {
        const record = coordinator.binding(agentId);
        if (
          !record?.ref ||
          record.operationId !== operationId ||
          (!allowStarting && record.phase !== "ready")
        )
          throw new WorkError("environment_not_ready", 409);
        const profile = coordinator.profile(record),
          provider = await coordinator.provider(record);
        const endpoint = await provider.httpEndpoint(
          record.ref.id,
          profile.port,
        );
        const headers = new Headers(endpoint.headers);
        new Headers(options.headers).forEach((v, k) => headers.set(k, v));
        return new ServiceHttp(
          endpoint.url,
          readFileSync(coordinator.token(record), "utf8").trim(),
        ).request(path, { ...options, headers });
      }
    })(`https://${agentId}.environment.invalid`, "");
  }
  host(agentId: string, operationId: string) {
    return new HttpAgentHost(this.http(agentId, operationId));
  }
  private async ready(record: Binding, profile: Profile) {
    const deadline = Date.now() + 180_000,
      http = this.http(record.agentId, record.operationId, true);
    for (;;) {
      this.assertOpen();
      try {
        const health = await http.request("/v1/health");
        const ready = await http.request("/v1/runtimes/inspect", {
          body: { runtimeId: profile.runtimeId },
        });
        if (health.protocolVersion === 1 && ready.available) return;
      } catch {
        /* Keep the same environment while the image starts. */
      }
      if (Date.now() > deadline)
        throw new WorkError("environment_host_not_ready", 409);
      await delay(1000, undefined, { signal: this.controller.signal });
    }
  }
  action(
    owner: string,
    agentId: string,
    action: "resume" | "pause" | "destroy" | "reconcile",
  ) {
    this.assertOpen();
    this.service.owned(agentId, owner);
    const record = this.binding(agentId);
    if (!record) throw new WorkError("environment_not_configured", 404);
    if (this.jobs.has(agentId))
      throw new WorkError("environment_operation_running", 409);
    if (record.phase === "deleted")
      throw new WorkError("environment_deleted_create_new_agent", 409);
    this.launch(record, async () => {
      const provider = await this.provider(record);
      if (!record.ref) {
        const found = await provider.list({
          "router-operation": record.operationId,
        });
        if (found.length !== 1)
          throw new WorkError(
            "environment_creation_requires_operator_reconciliation",
            409,
          );
        record.ref = { provider: record.provider, id: found[0]!.id };
        this.save(record);
      }
      const id = record.ref.id;
      if (action === "destroy" || action === "pause") {
        // Stop workers and reject active/uncertain native work before cloud lifecycle changes.
        await this.service.configureRuntime(
          agentId,
          async (agent, connector) => {
            record.phase = action === "destroy" ? "deleting" : "pausing";
            delete record.error;
            this.save(record);
            if (action === "destroy") {
              await provider.destroy(id);
              record.phase = "deleted";
            } else {
              await provider.pause(id);
              const deadline = Date.now() + 180_000;
              while ((await provider.info(id)).state !== "paused") {
                this.assertOpen();
                if (Date.now() > deadline)
                  throw new WorkError("environment_pause_unconfirmed", 409);
                await delay(1000, undefined, {
                  signal: this.controller.signal,
                });
              }
              record.phase = "paused";
            }
            this.save(record);
            return this.configuration.factory(agent, connector);
          },
          async (agent, connector) => {
            record.phase = "needs_action";
            record.error = "environment_lifecycle_unconfirmed";
            this.save(record);
            return this.configuration.factory(agent, connector);
          },
          () => {},
        );
        return;
      }
      const state = (await provider.info(id)).state;
      if (state === "missing")
        throw new WorkError(
          "environment_missing_explicit_replacement_required",
          409,
        );
      if (action === "reconcile" && state === "paused") {
        record.phase = "paused";
        delete record.error;
        this.save(record);
        return;
      }
      const profile = this.profile(record);
      record.phase = "resuming";
      delete record.error;
      this.save(record);
      if (
        (await provider.resume(id, profile.lifetimeSeconds)).state !== "running"
      )
        throw new WorkError("environment_resume_pending", 409);
      const config = this.configuration.configuration(
        this.service.agent(agentId),
      );
      if (!config?.host?.environment)
        await this.bootstrap(owner, record, provider, profile);
      else {
        await this.ready(record, profile);
        record.phase = "ready";
        delete record.error;
        this.save(record);
      }
    });
    return this.view(record);
  }
  assertReady(agentId: string, operationId: string) {
    const b = this.binding(agentId);
    this.assertOpen();
    if (b?.operationId !== operationId || b.phase !== "ready")
      throw new WorkError("environment_not_ready", 409);
  }
  private async maintain() {
    if (this.closed || this.controller.signal.aborted) return;
    for (const { value: record } of this.store.entries<Binding>(collection)) {
      if (
        record.phase !== "ready" ||
        !record.ref ||
        this.jobs.has(record.agentId)
      )
        continue;
      this.launch(record, async () => {
        const profile = this.profile(record),
          provider = await this.provider(record);
        if ((await provider.info(record.ref!.id)).state !== "running")
          throw new WorkError("environment_not_running_resume_required", 409);
        await provider.setTimeout(record.ref!.id, profile.lifetimeSeconds);
      });
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.leaseTimer);
    this.controller.abort();
    await Promise.allSettled(this.jobs.values());
    this.store.releaseLease(this.lease);
    this.store.close();
  }
}
