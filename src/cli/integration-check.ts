import { once } from "node:events";
import { createServer, type Server } from "node:http";
import amqp from "amqplib";
import express from "express";
import {
  A2A_PROTOCOL_VERSION,
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
  type Task,
  type TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultPushNotificationSender,
  DefaultRequestHandler,
  InMemoryTaskStore,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type PushNotificationSender,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { RouterUser } from "../auth.js";
import { loadConfig } from "../config.js";
import { createPool, migrate } from "../db.js";
import { DeliveryRuntime } from "../delivery.js";
import { FederationService } from "../federation.js";
import { buildProxyAgentCard, QueuedProxyExecutor, textPart } from "../proxy-agent.js";
import { PostgresPushNotificationStore } from "../push-notifications.js";
import { AgentRegistry } from "../registry.js";
import type { DeliveryEnvelope } from "../router-metadata.js";
import { PostgresTaskStore } from "../task-store.js";
import { TaskEventHub } from "../task-events.js";

if (process.env.INTEGRATION_CHECK_CONFIRM !== "disposable-database") {
  throw new Error("integration_check_requires_disposable_database_confirmation");
}
const config = loadConfig();
const databaseName = new URL(config.databaseUrl).pathname.slice(1);
if (!databaseName.endsWith("_integration")) throw new Error("integration_check_database_name_invalid");

const testConfig = {
  ...config,
  allowHttpAgentEndpoints: true,
  allowPrivateAgentEndpoints: true,
  deliveryTimeoutMs: 15_000,
  deliveryMaxAttempts: 2,
  deliveryRetryBaseMs: 100,
};
const pool = createPool(config.databaseUrl);
const callbackRequests: string[] = [];
const callbackServer = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    if (request.headers["x-a2a-notification-token"] === "integration-callback-token") callbackRequests.push(body);
    response.writeHead(204).end();
  });
});
const employeeApp = express();
const employeeServer = createServer(employeeApp);
let employeeExecutor: IntegrationEmployeeExecutor;
let delivery: DeliveryRuntime | undefined;
let integrationAgentId: string | undefined;
let federation: FederationService | undefined;

class IntegrationEmployeeExecutor implements AgentExecutor {
  private readonly held = new Map<string, () => void>();
  private readonly canceled = new Set<string>();
  cancelCount = 0;

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const task: Task = {
      id: context.taskId,
      contextId: context.contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
      artifacts: [],
      history: [context.userMessage],
      metadata: {},
    };
    eventBus.publish(AgentEvent.task(task));
    const prompt = messageText(context.userMessage);
    if (prompt === "hold") {
      await new Promise<void>((resolve) => this.held.set(context.taskId, resolve));
      this.held.delete(context.taskId);
      if (this.canceled.delete(context.taskId)) return;
    }
    const artifact: Artifact = {
      artifactId: crypto.randomUUID(),
      name: "integration-result",
      description: "Disposable full-chain result",
      parts: [textPart("INTEGRATION_A2A_OK")],
      metadata: {},
      extensions: [],
    };
    eventBus.publish(
      AgentEvent.artifactUpdate({
        taskId: context.taskId,
        contextId: context.contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: {},
      }),
    );
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: context.taskId,
        contextId: context.contextId,
        status: {
          state: TaskState.TASK_STATE_COMPLETED,
          timestamp: new Date().toISOString(),
          message: agentMessage(context.taskId, context.contextId, "INTEGRATION_A2A_OK"),
        },
        metadata: {},
      }),
    );
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.cancelCount += 1;
    this.canceled.add(taskId);
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: "",
        status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined },
        metadata: {},
      }),
    );
    this.held.get(taskId)?.();
  }
}

try {
  await migrate(pool);
  await listen(callbackServer);
  await listen(employeeServer);
  const callbackPort = serverPort(callbackServer);
  const employeePort = serverPort(employeeServer);
  const sourceCard = integrationAgentCard(employeePort);
  employeeExecutor = new IntegrationEmployeeExecutor();
  const employeeHandler = new DefaultRequestHandler(sourceCard, new InMemoryTaskStore(), employeeExecutor);
  employeeApp.use(
    "/a2a/rest",
    restHandler({ requestHandler: employeeHandler, userBuilder: UserBuilder.noAuthentication }),
  );

  const registry = new AgentRegistry(pool, testConfig);
  const registration = await registry.register(
    {
      address: "integration-worker",
      displayName: "Integration Worker",
      description: "Disposable integration worker",
      agentCard: sourceCard,
    },
    { id: "operator:integration", displayName: "Integration operator" },
  );
  integrationAgentId = registration.agent.id;
  const skillMatches = await registry.list("rare-skill-tag");
  if (skillMatches.length !== 1 || skillMatches[0]?.id !== registration.agent.id) {
    throw new Error("registry_skill_search_failed");
  }
  const updated = await registry.update(
    registration.agent.address,
    { displayName: "Integration Worker Updated" },
    "operator:integration",
  );
  if (!updated || updated.status !== "active" || updated.displayName !== "Integration Worker Updated") {
    throw new Error("registry_update_failed");
  }

  const pushStore = new PostgresPushNotificationStore(pool, testConfig);
  const pushSender = new DefaultPushNotificationSender(pushStore);
  const taskStore = new PostgresTaskStore(pool, pushSender);
  const taskEvents = new TaskEventHub();
  const context = integrationContext();
  const pushTaskId = crypto.randomUUID();
  const pushContextId = crypto.randomUUID();
  const pushMessage = userMessage("integration", pushTaskId, pushContextId);
  const notificationConfig: TaskPushNotificationConfig = {
    tenant: "",
    id: "",
    taskId: pushTaskId,
    url: `http://127.0.0.1:${callbackPort}/callback`,
    token: "integration-callback-token",
    authentication: undefined,
  };
  await pushStore.save(pushTaskId, context, notificationConfig);
  const envelope: DeliveryEnvelope = {
    agentId: registration.agent.id,
    agentAddress: registration.agent.address,
    tenant: "",
    ownerPrincipalId: "operator:integration",
    routerTaskId: pushTaskId,
    routerContextId: pushContextId,
    messageId: pushMessage.messageId,
    senderAddress: `router@${testConfig.agentAddressDomain}`,
    targetKind: "local",
    message: pushMessage,
    attempt: 0,
  };
  taskStore.stageDelivery(envelope);
  await taskStore.save(
    {
      id: pushTaskId,
      contextId: pushContextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
      artifacts: [],
      history: [pushMessage],
      metadata: {},
    },
    context,
  );
  await waitUntil(() => callbackRequests.length === 1, "official_push_dispatch_failed");
  const encrypted = await pool.query<{ config_ciphertext: string }>(
    "SELECT config_ciphertext FROM task_push_notification_configs WHERE task_id = $1",
    [pushTaskId],
  );
  if (!encrypted.rows[0] || encrypted.rows[0].config_ciphertext.includes("integration-callback-token")) {
    throw new Error("push_config_encryption_failed");
  }

  federation = await FederationService.create(pool, testConfig);
  delivery = new DeliveryRuntime(pool, registry, taskStore, taskEvents, testConfig, federation);
  await delivery.start();
  const noOpPushSender: PushNotificationSender = { send: async () => undefined };
  const routerHandler = new DefaultRequestHandler(
    buildProxyAgentCard(updated, "https://router.integration.invalid"),
    taskStore,
    new QueuedProxyExecutor(updated, taskEvents, testConfig.agentAddressDomain, taskStore),
    taskEvents.manager,
    pushStore,
    noOpPushSender,
    undefined,
    undefined,
    {
      keepBusAliveStates: [
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_INPUT_REQUIRED,
        TaskState.TASK_STATE_AUTH_REQUIRED,
      ],
    },
  );

  const streamEvents: string[] = [];
  let streamedTaskId = "";
  for await (const response of routerHandler.sendMessageStream(sendRequest("complete"), context)) {
    const eventCase = response.payload?.$case;
    if (eventCase) streamEvents.push(eventCase);
    if (response.payload?.$case === "task") streamedTaskId = response.payload.value.id;
  }
  if (!streamedTaskId) throw new Error("streamed_task_id_missing");
  const deliveredTask = await taskStore.load(streamedTaskId, context);
  const artifactText = deliveredTask?.artifacts
    .flatMap((artifact) => artifact.parts)
    .filter((part) => part.content?.$case === "text")
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("\n");
  if (
    deliveredTask?.status?.state !== TaskState.TASK_STATE_COMPLETED ||
    artifactText !== "INTEGRATION_A2A_OK" ||
    !streamEvents.includes("task") ||
    !streamEvents.includes("statusUpdate") ||
    !streamEvents.includes("artifactUpdate")
  ) {
    throw new Error("durable_streaming_delivery_failed");
  }
  const deliveredBinding = await bindingFor(pool, streamedTaskId);
  if (deliveredBinding?.delivery_state !== "delivered" || !deliveredBinding.remote_task_id) {
    throw new Error("router_remote_task_mapping_failed");
  }
  const persistedTask = await pool.query<{ task: Task }>(
    "SELECT task FROM tasks WHERE task_id = $1",
    [streamedTaskId],
  );
  if (
    persistedTask.rows[0]?.task.metadata?.agentRouter ||
    persistedTask.rows[0]?.task.metadata?.remoteTaskId ||
    persistedTask.rows[0]?.task.metadata?.remoteContextId
  ) {
    throw new Error("router_private_metadata_leaked");
  }

  const held = await routerHandler.sendMessage(sendRequest("hold"), context);
  if (!("id" in held)) throw new Error("held_task_missing");
  await waitUntil(async () => Boolean((await bindingFor(pool, held.id))?.remote_task_id), "remote_task_binding_timeout");
  const canceled = await routerHandler.cancelTask({ id: held.id, tenant: "", metadata: {} }, context);
  if (canceled.status?.state !== TaskState.TASK_STATE_CANCELED) throw new Error("router_cancel_failed");
  await waitUntil(
    async () => (await bindingFor(pool, held.id))?.delivery_state === "canceled",
    "remote_cancel_delivery_timeout",
  );
  if (employeeExecutor.cancelCount !== 1) throw new Error("remote_cancel_not_received");

  const disabled = await registry.update(
    registration.agent.address,
    { status: "disabled" },
    "operator:integration",
  );
  if (disabled?.status !== "disabled") throw new Error("registry_disable_failed");

  process.stdout.write(
    `${JSON.stringify({
      registrySkillSearch: "ok",
      registryUpdateAndDisable: "ok",
      postgresTaskStore: "ok",
      officialPush: "ok",
      rabbitOutboxDelivery: "ok",
      officialClientFactory: "ok",
      officialSseLifecycle: "ok",
      routerRemoteTaskMapping: "ok",
      privateRoutingMetadata: "ok",
      remoteCancellation: "ok",
    })}\n`,
  );
} finally {
  await delivery?.stop().catch(() => undefined);
  await federation?.close().catch(() => undefined);
  employeeServer.closeAllConnections();
  callbackServer.closeAllConnections();
  await Promise.all([closeServer(employeeServer), closeServer(callbackServer)]);
  await pool.end();
  if (integrationAgentId) await deleteIntegrationQueues(config.rabbitmqUrl, integrationAgentId).catch(() => undefined);
}

function integrationAgentCard(port: number): AgentCard {
  return {
    name: "Integration Worker",
    description: "Disposable integration worker",
    supportedInterfaces: [
      {
        url: `http://127.0.0.1:${port}/a2a/rest`,
        protocolBinding: "HTTP+JSON",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: "Example", url: "https://example.com" },
    version: "1.0.0",
    documentationUrl: "",
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "integration-skill",
        name: "Integration skill",
        description: "Used for registry search validation",
        tags: ["rare-skill-tag"],
        examples: [],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        securityRequirements: [],
      },
    ],
    signatures: [],
    iconUrl: "",
  };
}

function integrationContext(): ServerCallContext {
  return new ServerCallContext({
    user: new RouterUser("operator:integration", "Integration operator", "human", ["admin"]),
    requestedVersion: "1.0",
  });
}

function sendRequest(prompt: string) {
  return {
    message: userMessage(prompt),
    configuration: {
      acceptedOutputModes: ["text/plain"],
      returnImmediately: true,
      historyLength: 20,
      taskPushNotificationConfig: undefined,
    },
    metadata: {},
    tenant: "",
  };
}

function userMessage(text: string, taskId = "", contextId = ""): Message {
  return {
    role: Role.ROLE_USER,
    messageId: crypto.randomUUID(),
    taskId,
    contextId,
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: crypto.randomUUID(),
    taskId,
    contextId,
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function messageText(message: Message): string {
  return message.parts
    .filter((part) => part.content?.$case === "text")
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("\n")
    .trim();
}

async function bindingFor(
  database: typeof pool,
  taskId: string,
): Promise<{ delivery_state: string; remote_task_id: string | null } | undefined> {
  const result = await database.query<{ delivery_state: string; remote_task_id: string | null }>(
    "SELECT delivery_state, remote_task_id FROM task_bindings WHERE router_task_id = $1",
    [taskId],
  );
  return result.rows[0];
}

async function waitUntil(check: () => boolean | Promise<boolean>, errorCode: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(errorCode);
}

async function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("integration_server_address_missing");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function deleteIntegrationQueues(rabbitmqUrl: string, agentId: string): Promise<void> {
  const connection = await amqp.connect(rabbitmqUrl);
  try {
    const channel = await connection.createChannel();
    try {
      await channel.deleteQueue(`agent.${agentId}`);
      await channel.deleteQueue(`agent.${agentId}.dead`);
    } finally {
      await channel.close();
    }
  } finally {
    await connection.close();
  }
}
