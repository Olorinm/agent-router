import express from "express";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
  type Task,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from "@a2a-js/sdk/server/express";

const port = Number(process.env.PORT ?? "8080");
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8081").replace(/\/+$/, "");

const card: AgentCard = {
  name: "Echo Agent",
  description: "A deterministic A2A agent for the local Agent Router demo.",
  supportedInterfaces: [
    {
      url: `${publicBaseUrl}/a2a/rest`,
      protocolBinding: "HTTP+JSON",
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
    {
      url: `${publicBaseUrl}/a2a/jsonrpc`,
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  provider: { organization: "Agent Router contributors", url: publicBaseUrl },
  version: "1.0.0",
  documentationUrl: "",
  capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "echo",
      name: "Echo",
      description: "Returns the supplied text with an Echo prefix.",
      tags: ["demo", "echo"],
      examples: ["hello"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      securityRequirements: [],
    },
  ],
  signatures: [],
  iconUrl: "",
};

class EchoExecutor implements AgentExecutor {
  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    const text = userMessage.parts
      .filter((part) => part.content?.$case === "text")
      .map((part) => part.content?.$case === "text" ? part.content.value : "")
      .join("\n")
      .trim();
    const output = `Echo: ${text}`;
    const task: Task = context.task ?? {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
      artifacts: [],
      history: [userMessage],
      metadata: {},
    };
    const artifact: Artifact = {
      artifactId: crypto.randomUUID(),
      name: "Echo result",
      description: "Deterministic demo output.",
      parts: [textPart(output)],
      metadata: {},
      extensions: [],
    };
    eventBus.publish(AgentEvent.task(task));
    eventBus.publish(AgentEvent.artifactUpdate({
      taskId,
      contextId,
      artifact,
      append: false,
      lastChunk: true,
      metadata: {},
    }));
    eventBus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        timestamp: new Date().toISOString(),
        message: agentMessage(taskId, contextId, output),
      },
      metadata: {},
    }));
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId: "",
      status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined },
      metadata: {},
    }));
  }
}

const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new EchoExecutor());
const app = express();
app.disable("x-powered-by");
app.get("/health/live", (_request, response) => response.json({ status: "ok" }));
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler, cache: { maxAge: 0 } }));
app.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
app.use((_request, response) => response.status(404).json({ error: "not_found" }));
app.listen(port, "0.0.0.0", () => process.stdout.write(`${JSON.stringify({ event: "echo.listening", port })}\n`));

function textPart(text: string) {
  return { content: { $case: "text" as const, value: text }, mediaType: "text/plain", filename: "", metadata: {} };
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
