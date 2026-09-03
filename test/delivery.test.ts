import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  Role,
  TaskState,
  type Message,
  type Task,
} from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { hashCredential } from "../src/crypto.js";
import { DeliveryRuntime, parseCancelEnvelope } from "../src/delivery.js";
import type { FederationService } from "../src/federation.js";
import type { RegisteredAgent, AgentRegistry } from "../src/registry.js";
import type { DeliveryEnvelope } from "../src/router-metadata.js";
import type { PostgresTaskStore } from "../src/task-store.js";
import { TaskEventHub } from "../src/task-events.js";

describe("delivery envelopes", () => {
  it("accepts the A2A default empty tenant for cancellation", () => {
    expect(
      parseCancelEnvelope({
        tenant: "",
        ownerPrincipalId: "operator:test",
        routerTaskId: "router-task",
        agentId: "agent-id",
        remoteTaskId: "remote-task",
        attempt: 0,
      }),
    ).toMatchObject({ tenant: "", remoteTaskId: "remote-task" });
  });

  it("still rejects an empty required cancellation identity", () => {
    expect(() =>
      parseCancelEnvelope({
        tenant: "",
        ownerPrincipalId: "operator:test",
        routerTaskId: "",
        agentId: "agent-id",
        remoteTaskId: "remote-task",
      }),
    ).toThrow("cancel_envelope_invalid");
  });
});

describe("reliable delivery", () => {
  it("records remote acceptance without waiting for a long task to finish", async () => {
    const fixture = deliveryFixture();

    await fixture.runtime.deliver(fixture.envelope);

    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    expect(fixture.getTask).not.toHaveBeenCalled();
    expect(fixture.binding.delivery_state).toBe("awaiting_result");
    expect(fixture.binding.remote_task_id).toBe("remote-task");
    expect(fixture.task.status.state).toBe(TaskState.TASK_STATE_WORKING);
  });

  it("acks duplicate broker work without creating a second remote task", async () => {
    const fixture = deliveryFixture();

    await fixture.runtime.deliver(fixture.envelope);
    await fixture.runtime.deliver({ ...fixture.envelope, attempt: 1 });

    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    expect(fixture.binding.delivery_state).toBe("awaiting_result");
  });

  it("resumes an accepted task with getTask and never calls sendMessage again", async () => {
    const fixture = deliveryFixture();
    fixture.binding.delivery_state = "awaiting_result";
    fixture.binding.remote_task_id = "remote-task";
    fixture.task.status.state = TaskState.TASK_STATE_WORKING;
    fixture.getTask.mockResolvedValueOnce(remoteTask(TaskState.TASK_STATE_COMPLETED));

    await fixture.runtime.deliver(fixture.envelope);
    await fixture.runtime.recoverRemoteTask({
      tenant: "",
      owner_principal_id: fixture.envelope.ownerPrincipalId,
      router_task_id: fixture.envelope.routerTaskId,
      agent_id: fixture.agent.id,
      remote_task_id: "remote-task",
      remote_domain: null,
      remote_subject: null,
    });

    expect(fixture.sendMessage).not.toHaveBeenCalled();
    expect(fixture.getTask).toHaveBeenCalledTimes(1);
    expect(fixture.binding.delivery_state).toBe("delivered");
    expect(fixture.task.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("registers an authenticated push callback for a capable local agent", async () => {
    const fixture = deliveryFixture({ pushNotifications: true });

    await fixture.runtime.deliver(fixture.envelope);

    const request = fixture.sendMessage.mock.calls[0]?.[0];
    const push = request?.configuration?.taskPushNotificationConfig;
    expect(push?.url).toBe("https://router.example/callbacks/v1/a2a/router-task");
    expect(push?.token).toMatch(/^arcb_[a-f0-9]{32}$/);
    expect(fixture.binding.callback_token_hash).toBe(hashCredential(push!.token));
  });
});

function deliveryFixture(options: { pushNotifications?: boolean } = {}) {
  const agent = testAgent(options.pushNotifications ?? false);
  const message = userMessage();
  const task: Task = {
    id: "router-task",
    contextId: "router-context",
    status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
    artifacts: [],
    history: [message],
    metadata: {},
  };
  const envelope: DeliveryEnvelope = {
    tenant: "",
    ownerPrincipalId: "agent:sender",
    routerTaskId: task.id,
    routerContextId: task.contextId,
    agentId: agent.id,
    agentAddress: agent.address,
    messageId: message.messageId,
    senderAddress: "sender@agents.example",
    targetKind: "local",
    message,
    attempt: 0,
  };
  const binding: { delivery_state: string; remote_task_id: string | null; callback_token_hash: string | null } = {
    delivery_state: "queued",
    remote_task_id: null,
    callback_token_hash: null,
  };
  const attempts: string[] = [];
  const query = async (text: string, values: unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (text.includes("SELECT remote_task_id, delivery_state")) {
      return { rows: [{ ...binding }], rowCount: 1 };
    }
    if (text.includes("SET delivery_state = 'delivering'")) {
      binding.delivery_state = "delivering";
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SET callback_token_hash = $4")) {
      binding.callback_token_hash = String(values[3]);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("remote_task_id = COALESCE(remote_task_id")) {
      binding.remote_task_id ??= String(values[3]);
      if (binding.delivery_state !== "canceled" && binding.delivery_state !== "delivered") {
        binding.delivery_state = "awaiting_result";
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SET delivery_state = 'awaiting_result'")) {
      binding.delivery_state = "awaiting_result";
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SET delivery_state = 'delivered'")) {
      binding.delivery_state = "delivered";
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO delivery_attempts")) {
      attempts.push(String(values[5]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO audit_logs")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected_query:${text}`);
  };
  const client = { query, release: () => undefined };
  const pool = {
    query,
    connect: async () => client,
  } as unknown as Pool;
  const taskStore = {
    load: async () => structuredClone(task),
    save: async (next: Task) => Object.assign(task, structuredClone(next)),
  } as unknown as PostgresTaskStore;
  const sendMessage = vi.fn(async () => remoteTask(TaskState.TASK_STATE_WORKING));
  const getTask = vi.fn(async () => remoteTask(TaskState.TASK_STATE_WORKING));
  const remoteClient = { sendMessage, getTask } as unknown as Client;
  const federation = {
    domain: "agents.example",
    clientForLocal: async () => remoteClient,
  } as unknown as FederationService;
  const registry = { getById: async () => agent } as unknown as AgentRegistry;
  const config = loadConfig({
    PUBLIC_BASE_URL: "https://router.example",
    ADMIN_AUTH_MODE: "static",
    STATIC_ADMIN_TOKEN: "test-static-admin-token-at-least-32-bytes",
    AGENT_ADDRESS_DOMAIN: "agents.example",
    DATABASE_URL: "postgres://unused",
    RABBITMQ_URL: "amqp://unused",
    MASTER_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString("base64"),
  });
  const runtime = new DeliveryRuntime(pool, registry, taskStore, new TaskEventHub(), config, federation);
  return { runtime, envelope, agent, task, binding, attempts, sendMessage, getTask };
}

function testAgent(pushNotifications: boolean): RegisteredAgent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    address: "worker@agents.example",
    displayName: "Worker",
    description: "Long-running worker",
    sourceAgentCard: AgentCard.fromJSON({
      name: "Worker",
      description: "Long-running worker",
      supportedInterfaces: [{
        url: "https://worker.example/a2a/rest",
        protocolBinding: "HTTP+JSON",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      }],
      provider: { organization: "Test", url: "https://example.com" },
      version: "1.0.0",
      capabilities: { streaming: true, pushNotifications, extensions: [], extendedAgentCard: false },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      documentationUrl: "",
      signatures: [],
      iconUrl: "",
    }),
    targetKind: "local",
    status: "active",
    ownerPrincipalId: "human:test",
    updatedAt: new Date(0).toISOString(),
  };
}

function userMessage(): Message {
  return {
    role: Role.ROLE_USER,
    messageId: "message-one",
    taskId: "",
    contextId: "",
    parts: [],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function remoteTask(state: TaskState): Task {
  return {
    id: "remote-task",
    contextId: "remote-context",
    status: { state, timestamp: new Date().toISOString(), message: undefined },
    artifacts: [],
    history: [],
    metadata: {},
  };
}
