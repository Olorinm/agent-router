import {
  A2A_PROTOCOL_VERSION,
  Role,
  TaskState,
  type AgentCard,
  type Task,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type PushNotificationSender,
  type PushNotificationStore,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  type UserBuilder,
} from "@a2a-js/sdk/server/express";
import type { RequestHandler } from "express";
import type { AgentRegistry, RegisteredAgent } from "./registry.js";
import { ROUTER_METADATA_KEY, type DeliveryEnvelope } from "./router-metadata.js";
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
    private readonly registry: AgentRegistry,
    private readonly taskStore: PostgresTaskStore,
    private readonly taskEvents: TaskEventHub,
    private readonly pushNotificationStore: PushNotificationStore,
    private readonly userBuilder: UserBuilder,
    private readonly publicBaseUrl: string,
  ) {}

  async get(address: string): Promise<ProxyHandlerSuite | undefined> {
    const agent = await this.registry.getByAddress(address);
    if (!agent || agent.status !== "active") return undefined;
    const cached = this.suites.get(agent.address);
    if (cached?.updatedAt === agent.updatedAt) return cached;
    const card = buildProxyAgentCard(agent, this.publicBaseUrl);
    const executor = new QueuedProxyExecutor(agent, this.taskEvents);
    const handler = new DefaultRequestHandler(
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
    const suite: ProxyHandlerSuite = {
      card: agentCardHandler({ agentCardProvider: handler, cache: { maxAge: 60 } }),
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
      message,
      attempt: 0,
    };
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
      metadata: { [ROUTER_METADATA_KEY]: envelope },
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

export function buildProxyAgentCard(agent: RegisteredAgent, publicBaseUrl: string): AgentCard {
  const encodedAddress = encodeURIComponent(agent.address);
  const base = `${publicBaseUrl}/agents/${encodedAddress}/a2a`;
  return {
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
    provider: agent.sourceAgentCard.provider ?? { organization: "OpenGrove", url: publicBaseUrl },
    version: agent.sourceAgentCard.version || "1.0.0",
    documentationUrl: agent.sourceAgentCard.documentationUrl,
    capabilities: {
      streaming: true,
      pushNotifications: true,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {
      Bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            description: "WW admin access token or an OpenGrove Agent Router machine credential.",
            scheme: "bearer",
            bearerFormat: "opaque",
          },
        },
      },
    },
    securityRequirements: [{ schemes: { Bearer: { list: [] } } }],
    defaultInputModes: agent.sourceAgentCard.defaultInputModes.length
      ? agent.sourceAgentCard.defaultInputModes
      : ["text/plain"],
    defaultOutputModes: agent.sourceAgentCard.defaultOutputModes.length
      ? agent.sourceAgentCard.defaultOutputModes
      : ["text/plain", "task-status"],
    skills: agent.sourceAgentCard.skills.map((skill) => ({
      ...skill,
      securityRequirements: [{ schemes: { Bearer: { list: [] } } }],
    })),
    signatures: [],
    iconUrl: agent.sourceAgentCard.iconUrl,
  };
}

export function textPart(text: string) {
  return {
    content: { $case: "text" as const, value: text },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}
