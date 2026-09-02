import amqp, {
  type Channel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from "amqplib";
import {
  Role,
  TaskState,
  type Message,
  type SendMessageResult,
  type Task,
} from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { ServerCallContext } from "@a2a-js/sdk/server";
import type { Pool, PoolClient } from "pg";
import type { RouterConfig } from "./config.js";
import { decryptSecret } from "./crypto.js";
import { withTransaction } from "./db.js";
import { logError, logInfo, safeError } from "./log.js";
import { textPart } from "./proxy-agent.js";
import type { AgentRegistry, RegisteredAgent } from "./registry.js";
import { parseDeliveryEnvelope, ROUTER_METADATA_KEY, type DeliveryEnvelope } from "./router-metadata.js";
import { RouterUser } from "./auth.js";
import { insertOutbox, type PostgresTaskStore } from "./task-store.js";
import type { TaskEventHub } from "./task-events.js";

const DELIVERY_EXCHANGE = "agent-router.inbound";
const DEAD_EXCHANGE = "agent-router.dead";

interface OutboxRow {
  id: string;
  kind: "deliver" | "cancel";
  payload: unknown;
}

interface BrokerEnvelope {
  outboxId: string;
  kind: "deliver" | "cancel";
  payload: unknown;
}

interface CancelEnvelope {
  tenant: string;
  ownerPrincipalId: string;
  routerTaskId: string;
  agentId: string;
  remoteTaskId: string;
  attempt: number;
}

export class DeliveryRuntime {
  private connection?: amqp.ChannelModel;
  private publisher?: ConfirmChannel;
  private consumer?: Channel;
  private stopped = false;
  private publisherLoop?: Promise<void>;
  private consumerRefreshLoop?: Promise<void>;
  private readonly consumingAgentIds = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly registry: AgentRegistry,
    private readonly taskStore: PostgresTaskStore,
    private readonly taskEvents: TaskEventHub,
    private readonly config: RouterConfig,
  ) {}

  async start(): Promise<void> {
    await this.taskEvents.recoverNonTerminal(this.pool);
    this.connection = await amqp.connect(this.config.rabbitmqUrl);
    this.connection.on("error", (error) => logError("rabbitmq.connection.error", error));
    this.connection.on("close", () => {
      if (!this.stopped) logError("rabbitmq.connection.closed", new Error("connection_closed"));
    });
    this.publisher = await this.connection.createConfirmChannel();
    this.consumer = await this.connection.createChannel();
    await Promise.all([this.publisher.assertExchange(DELIVERY_EXCHANGE, "direct", { durable: true }), this.publisher.assertExchange(DEAD_EXCHANGE, "direct", { durable: true })]);
    await Promise.all([this.consumer.assertExchange(DELIVERY_EXCHANGE, "direct", { durable: true }), this.consumer.assertExchange(DEAD_EXCHANGE, "direct", { durable: true })]);
    await this.consumer.prefetch(this.config.deliveryConcurrency);
    this.publisherLoop = this.runPublisherLoop();
    this.consumerRefreshLoop = this.runConsumerRefreshLoop();
    logInfo("delivery.started");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([this.publisherLoop, this.consumerRefreshLoop]);
    await this.consumer?.close().catch(() => undefined);
    await this.publisher?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  isReady(): boolean {
    return !this.stopped && Boolean(this.connection && this.publisher && this.consumer);
  }

  private async runPublisherLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const published = await this.publishBatch();
        if (published === 0) await delay(500);
      } catch (error) {
        logError("outbox.publish.failed", error);
        await delay(2000);
      }
    }
  }

  private async publishBatch(): Promise<number> {
    if (!this.publisher) throw new Error("rabbitmq_publisher_not_ready");
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<OutboxRow>(
        `SELECT id, kind, payload
           FROM outbox
          WHERE published_at IS NULL AND available_at <= now()
          ORDER BY id
          LIMIT 50
          FOR UPDATE SKIP LOCKED`,
      );
      for (const row of result.rows) {
        const agentId = agentIdFromPayload(row.payload);
        await ensureAgentTopology(this.publisher!, agentId);
        const body: BrokerEnvelope = { outboxId: row.id, kind: row.kind, payload: row.payload };
        this.publisher!.publish(
          DELIVERY_EXCHANGE,
          agentId,
          Buffer.from(JSON.stringify(body)),
          messageOptions(row.id),
        );
      }
      if (result.rows.length > 0) {
        await this.publisher!.waitForConfirms();
        await client.query(
          `UPDATE outbox SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL
            WHERE id = ANY($1::bigint[])`,
          [result.rows.map((row) => row.id)],
        );
      }
      return result.rows.length;
    });
  }

  private async runConsumerRefreshLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const agents = await this.registry.list();
        for (const agent of agents.filter((entry) => entry.status === "active")) {
          await this.ensureConsumer(agent);
        }
      } catch (error) {
        logError("delivery.consumer.refresh_failed", error);
      }
      await delay(5000);
    }
  }

  private async ensureConsumer(agent: RegisteredAgent): Promise<void> {
    if (!this.consumer || this.consumingAgentIds.has(agent.id)) return;
    const queue = await ensureAgentTopology(this.consumer, agent.id);
    await this.consumer.consume(queue, (message) => void this.handleMessage(message), { noAck: false });
    this.consumingAgentIds.add(agent.id);
    logInfo("delivery.consumer.ready", { agentId: agent.id, address: agent.address });
  }

  private async handleMessage(message: ConsumeMessage | null): Promise<void> {
    if (!message || !this.consumer) return;
    try {
      const broker = parseBrokerEnvelope(message.content);
      if (broker.kind === "deliver") {
        await this.deliver(parseDeliveryEnvelope(broker.payload));
      } else {
        await this.cancel(parseCancelEnvelope(broker.payload));
      }
      this.consumer.ack(message);
    } catch (error) {
      logError("delivery.message.rejected", error);
      this.consumer.nack(message, false, false);
    }
  }

  private async deliver(envelope: DeliveryEnvelope): Promise<void> {
    const context = contextForOwner(envelope.ownerPrincipalId, envelope.tenant);
    const current = await this.taskStore.load(envelope.routerTaskId, context);
    if (!current || isTerminal(current.status?.state)) {
      await recordAttempt(this.pool, envelope, "skipped", undefined, 0);
      return;
    }
    const agent = await this.registry.getById(envelope.agentId);
    if (!agent || agent.status !== "active") {
      await this.retryOrFail(envelope, current, context, new Error("target_agent_unavailable"));
      return;
    }

    const startedAt = Date.now();
    await setBindingState(this.pool, envelope, "delivering");
    await recordAttempt(this.pool, envelope, "started", undefined, 0);
    current.status = {
      state: TaskState.TASK_STATE_WORKING,
      timestamp: new Date().toISOString(),
      message: statusMessage(current, `Delivering to ${agent.displayName}.`),
    };
    await this.taskStore.save(current, context);
    this.taskEvents.publishStatus(current);

    try {
      const result = await this.callRemoteAgent(agent, envelope);
      if (!("messageId" in result)) {
        await setRemoteBinding(this.pool, envelope, result.id, result.contextId);
        const latest = await this.taskStore.load(envelope.routerTaskId, context);
        if (latest?.status?.state === TaskState.TASK_STATE_CANCELED) {
          await this.cancelRemoteTask(agent, result.id).catch((error) =>
            logError("delivery.remote_cancel_after_race_failed", error, { taskId: envelope.routerTaskId }),
          );
          await setBindingCanceled(this.pool, envelope);
          return;
        }
      }
      const finalResult = await this.waitForTerminalResult(agent, result);
      const latest = (await this.taskStore.load(envelope.routerTaskId, context)) ?? current;
      if (latest.status?.state === TaskState.TASK_STATE_CANCELED) {
        if (!("messageId" in finalResult)) {
          await this.cancelRemoteTask(agent, finalResult.id).catch(() => undefined);
        }
        await setBindingCanceled(this.pool, envelope);
        return;
      }
      const mapped = mapRemoteResult(latest, finalResult);
      await this.taskStore.save(mapped.task, context);
      this.taskEvents.publishFinal(mapped.task);
      await withTransaction(this.pool, async (client) => {
        await client.query(
          `UPDATE task_bindings SET
             remote_task_id = $4,
             remote_context_id = $5,
             delivery_state = 'delivered',
             updated_at = now()
           WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
          [envelope.tenant, envelope.ownerPrincipalId, envelope.routerTaskId, mapped.remoteTaskId ?? null, mapped.remoteContextId ?? null],
        );
        await insertAttempt(client, envelope, "delivered", undefined, Date.now() - startedAt);
        await client.query(
          `INSERT INTO audit_logs(principal_id, action, target, outcome, facts)
           VALUES ($1, 'task.deliver', $2, 'success', $3::jsonb)`,
          [envelope.ownerPrincipalId, envelope.agentAddress, JSON.stringify({ taskId: envelope.routerTaskId, attempt: envelope.attempt })],
        );
      });
      logInfo("delivery.completed", { taskId: envelope.routerTaskId, agentId: envelope.agentId, attempt: envelope.attempt });
    } catch (error) {
      await this.retryOrFail(envelope, current, context, error, Date.now() - startedAt);
    }
  }

  private async callRemoteAgent(agent: RegisteredAgent, envelope: DeliveryEnvelope): Promise<SendMessageResult> {
    const client = await new ClientFactory().createFromAgentCard(agent.sourceAgentCard);
    const serviceParameters: Record<string, string> = {};
    if (agent.endpointAuthCiphertext) {
      serviceParameters.Authorization = `Bearer ${decryptSecret(agent.endpointAuthCiphertext, this.config.encryptionKey)}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("delivery_timeout")), this.config.deliveryTimeoutMs);
    try {
      return await client.sendMessage(
        {
          message: withoutRouterTaskIdentity(envelope.message),
          configuration: {
            acceptedOutputModes: [],
            returnImmediately: true,
            historyLength: 20,
            taskPushNotificationConfig: undefined,
          },
          metadata: { routerTaskId: envelope.routerTaskId },
          tenant: "",
        },
        { signal: controller.signal, serviceParameters },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitForTerminalResult(agent: RegisteredAgent, initial: SendMessageResult): Promise<SendMessageResult> {
    if ("messageId" in initial || isTerminal(initial.status?.state)) return initial;
    const client = await new ClientFactory().createFromAgentCard(agent.sourceAgentCard);
    const serviceParameters: Record<string, string> = {};
    if (agent.endpointAuthCiphertext) {
      serviceParameters.Authorization = `Bearer ${decryptSecret(agent.endpointAuthCiphertext, this.config.encryptionKey)}`;
    }
    const deadline = Date.now() + this.config.deliveryTimeoutMs;
    let task = initial;
    while (!isTerminal(task.status?.state)) {
      if (Date.now() >= deadline) throw new Error("remote_task_timeout");
      await delay(1000);
      task = await client.getTask({ id: task.id, historyLength: 20, tenant: "" }, { serviceParameters });
    }
    return task;
  }

  private async retryOrFail(
    envelope: DeliveryEnvelope,
    task: Task,
    context: ServerCallContext,
    error: unknown,
    durationMs = 0,
  ): Promise<void> {
    const nextAttempt = envelope.attempt + 1;
    const message = safeError(error);
    if (nextAttempt < this.config.deliveryMaxAttempts) {
      const retryEnvelope = { ...envelope, attempt: nextAttempt };
      const availableAt = new Date(Date.now() + retryDelayMs(this.config.deliveryRetryBaseMs, nextAttempt));
      task.status = {
        state: TaskState.TASK_STATE_SUBMITTED,
        timestamp: new Date().toISOString(),
        message: statusMessage(task, `Delivery delayed; retry ${nextAttempt} scheduled.`),
      };
      await this.taskStore.save(task, context);
      this.taskEvents.publishStatus(task);
      await withTransaction(this.pool, async (client) => {
        await insertOutbox(
          client,
          "deliver",
          retryEnvelope,
          `deliver:${envelope.tenant}:${envelope.ownerPrincipalId}:${envelope.routerTaskId}:${nextAttempt}`,
          availableAt,
        );
        await client.query(
          `UPDATE task_bindings SET delivery_state = 'queued', updated_at = now()
            WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
          [envelope.tenant, envelope.ownerPrincipalId, envelope.routerTaskId],
        );
        await insertAttempt(client, envelope, "retrying", message, durationMs);
      });
      logError("delivery.retry_scheduled", error, { taskId: envelope.routerTaskId, attempt: nextAttempt });
      return;
    }

    task.status = {
      state: TaskState.TASK_STATE_FAILED,
      timestamp: new Date().toISOString(),
      message: statusMessage(task, "Delivery failed after the retry limit."),
    };
    await this.taskStore.save(task, context);
    this.taskEvents.publishStatus(task);
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE task_bindings SET delivery_state = 'failed', updated_at = now()
          WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
        [envelope.tenant, envelope.ownerPrincipalId, envelope.routerTaskId],
      );
      await insertAttempt(client, envelope, "failed", message, durationMs);
    });
    logError("delivery.failed", error, { taskId: envelope.routerTaskId, attempt: nextAttempt });
  }

  private async cancel(envelope: CancelEnvelope): Promise<void> {
    const agent = await this.registry.getById(envelope.agentId);
    if (!agent || agent.status !== "active") throw new Error("cancel_target_agent_unavailable");
    await this.cancelRemoteTask(agent, envelope.remoteTaskId);
    await this.pool.query(
      `UPDATE task_bindings SET delivery_state = 'canceled', updated_at = now()
        WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
      [envelope.tenant, envelope.ownerPrincipalId, envelope.routerTaskId],
    );
  }

  private async cancelRemoteTask(agent: RegisteredAgent, remoteTaskId: string): Promise<void> {
    const client = await new ClientFactory().createFromAgentCard(agent.sourceAgentCard);
    const serviceParameters: Record<string, string> = {};
    if (agent.endpointAuthCiphertext) {
      serviceParameters.Authorization = `Bearer ${decryptSecret(agent.endpointAuthCiphertext, this.config.encryptionKey)}`;
    }
    await client.cancelTask({ id: remoteTaskId, tenant: "", metadata: {} }, { serviceParameters });
  }
}

async function ensureAgentTopology(channel: Channel, agentId: string): Promise<string> {
  const queue = `agent.${agentId}`;
  const deadQueue = `${queue}.dead`;
  await channel.assertExchange(DELIVERY_EXCHANGE, "direct", { durable: true });
  await channel.assertExchange(DEAD_EXCHANGE, "direct", { durable: true });
  await channel.assertQueue(deadQueue, { durable: true });
  await channel.bindQueue(deadQueue, DEAD_EXCHANGE, agentId);
  await channel.assertQueue(queue, {
    durable: true,
    arguments: { "x-dead-letter-exchange": DEAD_EXCHANGE, "x-dead-letter-routing-key": agentId },
  });
  await channel.bindQueue(queue, DELIVERY_EXCHANGE, agentId);
  return queue;
}

function messageOptions(outboxId: string): Options.Publish {
  return {
    persistent: true,
    contentType: "application/json",
    messageId: `outbox-${outboxId}`,
    timestamp: Date.now(),
  };
}

function parseBrokerEnvelope(buffer: Buffer): BrokerEnvelope {
  const value = JSON.parse(buffer.toString("utf8")) as Partial<BrokerEnvelope>;
  if (!value.outboxId || (value.kind !== "deliver" && value.kind !== "cancel") || value.payload === undefined) {
    throw new Error("broker_envelope_invalid");
  }
  return value as BrokerEnvelope;
}

export function parseCancelEnvelope(value: unknown): CancelEnvelope {
  if (typeof value !== "object" || value === null) throw new Error("cancel_envelope_invalid");
  const object = value as Record<string, unknown>;
  const required = ["tenant", "ownerPrincipalId", "routerTaskId", "agentId", "remoteTaskId"] as const;
  for (const field of required) if (typeof object[field] !== "string") throw new Error("cancel_envelope_invalid");
  for (const field of required.filter((entry) => entry !== "tenant")) {
    if (!object[field]) throw new Error("cancel_envelope_invalid");
  }
  return {
    tenant: object.tenant as string,
    ownerPrincipalId: object.ownerPrincipalId as string,
    routerTaskId: object.routerTaskId as string,
    agentId: object.agentId as string,
    remoteTaskId: object.remoteTaskId as string,
    attempt: typeof object.attempt === "number" ? object.attempt : 0,
  };
}

function agentIdFromPayload(value: unknown): string {
  if (typeof value !== "object" || value === null || typeof (value as Record<string, unknown>).agentId !== "string") {
    throw new Error("outbox_agent_id_missing");
  }
  return (value as Record<string, string>).agentId!;
}

function contextForOwner(ownerPrincipalId: string, tenant: string): ServerCallContext {
  return new ServerCallContext({
    ...(tenant ? { tenant } : {}),
    user: new RouterUser(ownerPrincipalId, ownerPrincipalId, "agent", []),
    requestedVersion: "1.0",
  });
}

function withoutRouterTaskIdentity(message: Message): Message {
  const copy = structuredClone(message);
  copy.taskId = "";
  copy.contextId = "";
  return copy;
}

function mapRemoteResult(routerTask: Task, result: SendMessageResult): {
  task: Task;
  remoteTaskId?: string;
  remoteContextId?: string;
} {
  if ("messageId" in result) {
    const message = remapMessage(result, routerTask);
    return {
      task: {
        ...routerTask,
        status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message },
        history: mergeHistory(routerTask.history ?? [], [message]),
      },
    };
  }
  const status = structuredClone(result.status);
  if (status?.message) status.message = remapMessage(status.message, routerTask);
  const remoteHistory = (result.history ?? []).map((message) => remapMessage(message, routerTask));
  return {
    task: {
      ...routerTask,
      status,
      artifacts: structuredClone(result.artifacts ?? []),
      history: mergeHistory(routerTask.history ?? [], remoteHistory, status?.message ? [status.message] : []),
      metadata: {
        ...(routerTask.metadata ?? {}),
        remoteTaskId: result.id,
        remoteContextId: result.contextId,
      },
    },
    remoteTaskId: result.id,
    remoteContextId: result.contextId,
  };
}

function mergeHistory(...groups: Message[][]): Message[] {
  const messages = new Map<string, Message>();
  for (const group of groups) {
    for (const message of group) messages.set(message.messageId, structuredClone(message));
  }
  return [...messages.values()];
}

function remapMessage(message: Message, routerTask: Task): Message {
  return {
    ...structuredClone(message),
    taskId: routerTask.id,
    contextId: routerTask.contextId,
  };
}

function statusMessage(task: Task, text: string): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: crypto.randomUUID(),
    taskId: task.id,
    contextId: task.contextId,
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function isTerminal(value: TaskState | undefined): boolean {
  return (
    value === TaskState.TASK_STATE_COMPLETED ||
    value === TaskState.TASK_STATE_FAILED ||
    value === TaskState.TASK_STATE_CANCELED ||
    value === TaskState.TASK_STATE_REJECTED
  );
}

function retryDelayMs(baseMs: number, attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 10);
  return Math.min(baseMs * 2 ** exponent, 60 * 60 * 1000);
}

async function setBindingState(pool: Pool, envelope: DeliveryEnvelope, state: "delivering"): Promise<void> {
  await pool.query(
    `UPDATE task_bindings SET delivery_state = $4, updated_at = now()
      WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
    [envelope.tenant, envelope.ownerPrincipalId, envelope.routerTaskId, state],
  );
}

async function setRemoteBinding(
  pool: Pool,
  envelope: DeliveryEnvelope,
  remoteTaskId: string,
  remoteContextId: string,
): Promise<void> {
  await pool.query(
    `UPDATE task_bindings SET remote_task_id = $4, remote_context_id = $5, updated_at = now()
      WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
    [envelope.tenant, envelope.ownerPrincipalId, envelope.routerTaskId, remoteTaskId, remoteContextId],
  );
}

async function setBindingCanceled(pool: Pool, envelope: DeliveryEnvelope): Promise<void> {
  await pool.query(
    `UPDATE task_bindings SET delivery_state = 'canceled', updated_at = now()
      WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
    [envelope.tenant, envelope.ownerPrincipalId, envelope.routerTaskId],
  );
}

async function recordAttempt(
  pool: Pool,
  envelope: DeliveryEnvelope,
  outcome: "started" | "delivered" | "retrying" | "failed" | "skipped",
  error: string | undefined,
  durationMs: number,
): Promise<void> {
  await withTransaction(pool, (client) => insertAttempt(client, envelope, outcome, error, durationMs));
}

async function insertAttempt(
  client: PoolClient,
  envelope: DeliveryEnvelope,
  outcome: "started" | "delivered" | "retrying" | "failed" | "skipped",
  error: string | undefined,
  durationMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO delivery_attempts(
       tenant, owner_principal_id, router_task_id, agent_id, attempt, outcome, error_code, duration_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      envelope.tenant,
      envelope.ownerPrincipalId,
      envelope.routerTaskId,
      envelope.agentId,
      envelope.attempt,
      outcome,
      error ?? null,
      durationMs,
    ],
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
