import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Task,
} from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import { describe, expect, it } from "vitest";
import { RouterUser } from "../src/auth.js";
import { buildProxyAgentCard, QueuedProxyExecutor, textPart } from "../src/proxy-agent.js";
import type { RegisteredAgent } from "../src/registry.js";
import { TaskEventHub } from "../src/task-events.js";

describe("queued proxy streaming", () => {
  it("keeps the official stream open through queued, working, artifact, and completed events", async () => {
    const agent = testAgent();
    const events = new TaskEventHub();
    const store = new InMemoryTaskStore();
    const handler = new DefaultRequestHandler(
      buildProxyAgentCard(agent, "https://router.example"),
      store,
      new QueuedProxyExecutor(agent, events),
      events.manager,
      undefined,
      undefined,
      undefined,
      undefined,
      { keepBusAliveStates: [TaskState.TASK_STATE_SUBMITTED] },
    );
    const context = new ServerCallContext({
      user: new RouterUser("ww:test", "Test Admin", "human", ["admin"], "admin@example.com"),
      requestedVersion: "1.0",
    });
    const message: Message = {
      role: Role.ROLE_USER,
      messageId: crypto.randomUUID(),
      taskId: "",
      contextId: "",
      parts: [textPart("stream this")],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    };
    const stream = handler.sendMessageStream(
      {
        message,
        configuration: {
          acceptedOutputModes: ["text/plain"],
          returnImmediately: false,
          historyLength: 20,
          taskPushNotificationConfig: undefined,
        },
        metadata: {},
        tenant: "",
      },
      context,
    );

    const submitted = await stream.next();
    expect(submitted.value?.payload?.$case).toBe("task");
    if (submitted.value?.payload?.$case !== "task") throw new Error("submitted_task_missing");
    const taskId = submitted.value.payload.value.id;
    const task = await store.load(taskId, context);
    if (!task) throw new Error("stored_task_missing");
    task.status = {
      state: TaskState.TASK_STATE_WORKING,
      timestamp: new Date().toISOString(),
      message: agentMessage(task, "working"),
    };
    await store.save(task, context);
    events.publishStatus(task);
    const working = await stream.next();
    expect(working.value?.payload?.$case).toBe("statusUpdate");

    const artifact: Artifact = {
      artifactId: crypto.randomUUID(),
      name: "result",
      description: "test result",
      parts: [textPart("STREAM_OK")],
      metadata: {},
      extensions: [],
    };
    task.artifacts = [artifact];
    task.status = {
      state: TaskState.TASK_STATE_COMPLETED,
      timestamp: new Date().toISOString(),
      message: agentMessage(task, "done"),
    };
    await store.save(task, context);
    events.publishFinal(task);
    expect((await stream.next()).value?.payload?.$case).toBe("artifactUpdate");
    expect((await stream.next()).value?.payload?.$case).toBe("statusUpdate");
    expect((await stream.next()).done).toBe(true);
  });

  it("uses the official cancellation lifecycle for a queued task", async () => {
    const agent = testAgent();
    const events = new TaskEventHub();
    const store = new InMemoryTaskStore();
    const handler = new DefaultRequestHandler(
      buildProxyAgentCard(agent, "https://router.example"),
      store,
      new QueuedProxyExecutor(agent, events),
      events.manager,
      undefined,
      undefined,
      undefined,
      undefined,
      { keepBusAliveStates: [TaskState.TASK_STATE_SUBMITTED] },
    );
    const context = new ServerCallContext({
      user: new RouterUser("ww:test", "Test Admin", "human", ["admin"], "admin@example.com"),
      requestedVersion: "1.0",
    });
    const result = await handler.sendMessage(
      {
        message: userMessage("cancel this"),
        configuration: {
          acceptedOutputModes: ["text/plain"],
          returnImmediately: true,
          historyLength: 20,
          taskPushNotificationConfig: undefined,
        },
        metadata: {},
        tenant: "",
      },
      context,
    );
    if (!("id" in result)) throw new Error("submitted_task_missing");
    const canceled = await handler.cancelTask({ id: result.id, tenant: "", metadata: {} }, context);
    expect(canceled.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect((await store.load(result.id, context))?.status.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
});

function testAgent(): RegisteredAgent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    address: "worker@agents.welltop.cn",
    displayName: "Worker",
    description: "Streaming test worker",
    sourceAgentCard: AgentCard.fromJSON({
      name: "Worker",
      description: "Streaming test worker",
      supportedInterfaces: [
        {
          url: "https://worker.example/a2a/rest",
          protocolBinding: "HTTP+JSON",
          tenant: "",
          protocolVersion: A2A_PROTOCOL_VERSION,
        },
      ],
      provider: { organization: "Test", url: "https://example.com" },
      version: "1.0.0",
      capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      documentationUrl: "",
      signatures: [],
      iconUrl: "",
    }),
    status: "active",
    ownerPrincipalId: "ww:test",
    updatedAt: new Date(0).toISOString(),
  };
}

function userMessage(text: string): Message {
  return {
    role: Role.ROLE_USER,
    messageId: crypto.randomUUID(),
    taskId: "",
    contextId: "",
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function agentMessage(task: Task, text: string): Message {
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
