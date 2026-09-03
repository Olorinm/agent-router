import {
  Role,
  StreamResponse,
  TaskState,
  type Message,
  type Task,
} from "@a2a-js/sdk";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { hashCredential } from "../src/crypto.js";
import { FederationCallbackReceiver } from "../src/federation-callback.js";
import type { PostgresTaskStore } from "../src/task-store.js";
import { TaskEventHub } from "../src/task-events.js";

describe("local A2A result callbacks", () => {
  it("requires the stored token and applies the remote terminal Task", async () => {
    const callbackToken = "arcb_test_callback_token";
    let task = localTask();
    let bindingState = "awaiting_result";
    const pool = {
      async query(text: string) {
        if (text.includes("SELECT tenant, owner_principal_id")) {
          return {
            rows: [{
              tenant: "",
              owner_principal_id: "agent:sender",
              remote_task_id: "remote-task",
              delivery_state: bindingState,
              callback_token_hash: hashCredential(callbackToken),
            }],
            rowCount: 1,
          };
        }
        if (text.includes("UPDATE task_bindings SET")) {
          bindingState = "delivered";
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected_query:${text}`);
      },
    } as unknown as Pool;
    const taskStore = {
      load: async () => structuredClone(task),
      save: async (next: Task) => { task = structuredClone(next); },
    } as unknown as PostgresTaskStore;
    const receiver = new FederationCallbackReceiver(pool, taskStore, new TaskEventHub());
    const response = StreamResponse.toJSON({
      payload: { $case: "task", value: remoteTask() },
    });

    await expect(receiver.receiveLocal("router-task", "wrong-token", response)).rejects.toMatchObject({
      message: "push_token_invalid",
      status: 401,
    });
    await receiver.receiveLocal("router-task", callbackToken, response);

    expect(bindingState).toBe("delivered");
    expect(task.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(task.status.message?.taskId).toBe("router-task");
    expect(task.metadata).toEqual({});
  });
});

function localTask(): Task {
  return {
    id: "router-task",
    contextId: "router-context",
    status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined },
    artifacts: [],
    history: [],
    metadata: {},
  };
}

function remoteTask(): Task {
  return {
    id: "remote-task",
    contextId: "remote-context",
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
      timestamp: new Date().toISOString(),
      message: remoteMessage(),
    },
    artifacts: [],
    history: [],
    metadata: { privateRemoteValue: "must-not-be-copied" },
  };
}

function remoteMessage(): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: "remote-message",
    taskId: "remote-task",
    contextId: "remote-context",
    parts: [],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}
