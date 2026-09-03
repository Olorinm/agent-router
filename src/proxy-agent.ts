import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  Role,
  TaskState,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  type A2ARequestHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type PushNotificationSender,
  type PushNotificationStore,
  type RequestContext,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  type UserBuilder,
} from "@a2a-js/sdk/server/express";
import type { RequestHandler } from "express";
import type { AgentRegistry, RegisteredAgent } from "./registry.js";
import type { AgentTargetResolver } from "./target-resolver.js";
import type { DeliveryEnvelope } from "./router-metadata.js";
import type { PostgresTaskStore } from "./task-store.js";
import type { TaskEventHub } from "./task-events.js";

const taskStorePushSender: PushNotificationSender = { send: async () => undefined };

export interface ProxyHandlerSuite {
  card: RequestHandler;
  rest: RequestHandler;
  jsonRpc: RequestHandler;
  updatedAt: string;
}

export class ProxyHandlerCache {
  private readonly suites = new Map<string, ProxyHandlerSuite>();

  constructor(
    private readonly targets: AgentTargetResolver,
    private readonly taskStore: PostgresTaskStore,
    private readonly taskEvents: TaskEventHub,
    private readonly pushNotificationStore: PushNotificationStore,
    private readonly userBuilder: UserBuilder,
    private readonly publicBaseUrl: string,
    private readonly localDomain: string,
  ) {}

  async get(address: string): Promise<ProxyHandlerSuite | undefined> {
    const agent = await this.targets.resolve(address);
    if (!agent || agent.status !== "active") return undefined;
    const cached = this.suites.get(agent.address);
    if (cached?.updatedAt === agent.updatedAt) return cached;
    const card = buildProxyAgentCard(agent, this.publicBaseUrl);
    const executor = new QueuedProxyExecutor(agent, this.taskEvents, this.localDomain, this.taskStore);
    const baseHandler = new DefaultRequestHandler(
      card,
      this.taskStore,
      executor,
      this.taskEvents.manager,
      this.pushNotificationStore,
      taskStorePushSender,
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
    const handler = withMessageIdempotency(baseHandler, this.taskStore, agent);
    const suite: ProxyHandlerSuite = {
      // Cards are authenticated and subject to domain ACLs. They must be
      // revalidated instead of being reusable from a shared public cache.
      card: agentCardHandler({ agentCardProvider: handler, cache: { maxAge: 0 } }),
      rest: restHandler({ requestHandler: handler, userBuilder: this.userBuilder }),
      jsonRpc: jsonRpcHandler({ requestHandler: handler, userBuilder: this.userBuilder }),
      updatedAt: agent.updatedAt,
    };
    this.suites.set(agent.address, suite);
    return suite;
  }
}

export class QueuedProxyExecutor implements AgentExecutor {
  constructor(
    private readonly agent: RegisteredAgent,
    private readonly taskEvents: TaskEventHub,
    private readonly localDomain: string,
    private readonly deliveryStager?: Pick<PostgresTaskStore, "stageDelivery">,
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const user = requestContext.context.user;
    if (!user?.isAuthenticated || !user.userName) throw new Error("authenticated_caller_required");
    const message = requestContext.userMessage;
    const envelope: DeliveryEnvelope = {
      agentId: this.agent.id,
      agentAddress: this.agent.address,
      tenant: requestContext.context.tenant ?? "",
      ownerPrincipalId: user.userName,
      routerTaskId: requestContext.taskId,
      routerContextId: requestContext.contextId,
      messageId: message.messageId,
      senderAddress: user instanceof Object && "address" in user && typeof user.address === "string"
        ? user.address
        : `router@${this.localDomain}`,
      targetKind: this.agent.targetKind,
      ...(this.agent.originDomain ? { targetDomain: this.agent.originDomain } : {}),
      message,
      attempt: 0,
    };
    this.deliveryStager?.stageDelivery(envelope);
    const task: Task = {
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        timestamp: new Date().toISOString(),
        message: {
          role: Role.ROLE_AGENT,
          messageId: crypto.randomUUID(),
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          parts: [textPart(`Queued for ${this.agent.displayName}.`)],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
      },
      artifacts: [],
      history: [message],
      metadata: {},
    };
    eventBus.publish(AgentEvent.task(task));
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: "",
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          timestamp: new Date().toISOString(),
          message: undefined,
        },
        metadata: {},
      }),
    );
    this.taskEvents.finish(taskId, eventBus);
  }
}

export function withMessageIdempotency(
  handler: A2ARequestHandler,
  taskStore: Pick<PostgresTaskStore, "findByMessage">,
  agent: RegisteredAgent,
): A2ARequestHandler {
  const locks = new Map<string, Promise<void>>();
  return new Proxy(handler, {
    get(target, property) {
      if (property === "sendMessage") {
        return async (params: SendMessageRequest, context: ServerCallContext) => {
          if (params.message?.taskId) return target.sendMessage(params, context);
          const key = messageScopeKey(params, context, agent);
          return runExclusive(locks, key, async () => {
            try {
              const existing = await findExistingTask(params, context, taskStore, agent);
              if (existing) return existing;
              const result = await target.sendMessage(params, context);
              return (await findExistingTask(params, context, taskStore, agent)) ?? result;
            } catch (error) {
              const raced = await findExistingTask(params, context, taskStore, agent);
              if (raced && isUniqueViolation(error)) return raced;
              throw error;
            }
          });
        };
      }
      if (property === "sendMessageStream") {
        return async function* (params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
          if (params.message?.taskId) {
            yield* target.sendMessageStream(params, context);
            return;
          }
          const key = messageScopeKey(params, context, agent);
          const release = await acquire(locks, key);
          try {
            const existing = await findExistingTask(params, context, taskStore, agent);
            if (existing) {
              yield { payload: { $case: "task", value: existing } };
              return;
            }
            let first = true;
            for await (const event of target.sendMessageStream(params, context)) {
              if (first) {
                first = false;
                release();
              }
              yield event;
            }
          } catch (error) {
            const raced = await findExistingTask(params, context, taskStore, agent);
            if (raced && isUniqueViolation(error)) {
              yield { payload: { $case: "task", value: raced } };
              return;
            }
            throw error;
          } finally {
            release();
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

async function findExistingTask(
  params: SendMessageRequest,
  context: ServerCallContext,
  taskStore: Pick<PostgresTaskStore, "findByMessage">,
  agent: RegisteredAgent,
): Promise<Task | undefined> {
  const message = params.message;
  if (!message) throw new Error("message_required");
  return taskStore.findByMessage(agent.id, message.messageId, context);
}

function messageScopeKey(params: SendMessageRequest, context: ServerCallContext, agent: RegisteredAgent): string {
  const owner = context.user?.userName;
  const messageId = params.message?.messageId;
  if (!owner || !messageId) throw new Error("idempotency_scope_missing");
  return JSON.stringify([context.tenant ?? "", owner, agent.id, messageId]);
}

async function runExclusive<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquire(locks, key);
  try {
    return await run();
  } finally {
    release();
  }
}

async function acquire(locks: Map<string, Promise<void>>, key: string): Promise<() => void> {
  const previous = locks.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const current = previous.then(() => gate);
  locks.set(key, current);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (locks.get(key) === current) locks.delete(key);
  };
}

export function buildProxyAgentCard(agent: RegisteredAgent, publicBaseUrl: string): AgentCard {
  const encodedAddress = encodeURIComponent(agent.address);
  const base = `${publicBaseUrl}/agents/${encodedAddress}/a2a`;
  const addressDomain = agent.address.slice(agent.address.lastIndexOf("@") + 1);
  const card: AgentCard = {
    name: agent.displayName,
    description: agent.description,
    supportedInterfaces: [
      {
        url: `${base}/rest`,
        protocolBinding: "HTTP+JSON",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
      {
        url: `${base}/jsonrpc`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: agent.sourceAgentCard.provider ?? { organization: addressDomain, url: publicBaseUrl },
    version: agent.sourceAgentCard.version || "1.0.0",
    documentationUrl: agent.sourceAgentCard.documentationUrl,
    capabilities: {
      streaming: true,
      pushNotifications: true,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {
      RouterCredential: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            description: "An administrator access token accepted by this Router or a Router-issued machine credential.",
            scheme: "bearer",
            bearerFormat: "opaque",
          },
        },
      },
      FederationJwt: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            description: "A short-lived JWT issued by an allowed federated Router and verifiable through its JWKS.",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
    securityRequirements: [
      { schemes: { RouterCredential: { list: [] } } },
      { schemes: { FederationJwt: { list: [] } } },
    ],
    defaultInputModes: agent.sourceAgentCard.defaultInputModes.length
      ? agent.sourceAgentCard.defaultInputModes
      : ["text/plain"],
    defaultOutputModes: agent.sourceAgentCard.defaultOutputModes.length
      ? agent.sourceAgentCard.defaultOutputModes
      : ["text/plain", "task-status"],
    skills: agent.sourceAgentCard.skills.map((skill) => ({
      ...skill,
      securityRequirements: [
        { schemes: { RouterCredential: { list: [] } } },
        { schemes: { FederationJwt: { list: [] } } },
      ],
    })),
    signatures: [],
    iconUrl: agent.sourceAgentCard.iconUrl,
  };
  // The SDK's Express card handler delegates to JSON.stringify. Give the
  // in-memory protobuf-shaped object an explicit standards-shaped serializer
  // so clients from other official SDKs can decode security schemes.
  Object.defineProperty(card, "toJSON", {
    enumerable: false,
    value: () => AgentCard.toJSON(card),
  });
  return card;
}

export function textPart(text: string) {
  return {
    content: { $case: "text" as const, value: text },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}
