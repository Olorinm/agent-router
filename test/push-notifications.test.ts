import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { Role, TaskState, type Task, type TaskPushNotificationConfig } from "@a2a-js/sdk";
import { DefaultPushNotificationSender, ServerCallContext } from "@a2a-js/sdk/server";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { RouterUser } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { PostgresPushNotificationStore } from "../src/push-notifications.js";

describe("push notifications", () => {
  it("encrypts persisted config and dispatches through the official sender", async () => {
    const requests: Array<{ body: string; contentType?: string; token?: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.push({
          body,
          ...(request.headers["content-type"] ? { contentType: request.headers["content-type"] } : {}),
          ...(request.headers["x-a2a-notification-token"]
            ? { token: String(request.headers["x-a2a-notification-token"]) }
            : {}),
        });
        response.writeHead(204).end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("callback_address_missing");

    const rows: Array<{ config_ciphertext: string; wire_version: string; configId: string }> = [];
    const pool = {
      async query(text: string, values: unknown[]) {
        if (text.includes("INSERT INTO task_push_notification_configs")) {
          const configId = String(values[3]);
          const row = { config_ciphertext: String(values[5]), wire_version: String(values[4]), configId };
          const index = rows.findIndex((entry) => entry.configId === configId);
          if (index === -1) rows.push(row);
          else rows[index] = row;
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("SELECT config_ciphertext")) return { rows, rowCount: rows.length };
        if (text.includes("DELETE FROM task_push_notification_configs")) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected_query:${text}`);
      },
    } as unknown as Pool;
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://router.example",
      ADMIN_AUTH_MODE: "static",
      STATIC_ADMIN_TOKEN: "test-static-admin-token-at-least-32-bytes",
      AGENT_ADDRESS_DOMAIN: "agents.example",
      DATABASE_URL: "postgres://unused",
      RABBITMQ_URL: "amqp://unused",
      MASTER_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
      ALLOW_HTTP_AGENT_ENDPOINTS: "true",
      ALLOW_PRIVATE_AGENT_ENDPOINTS: "true",
    });
    const store = new PostgresPushNotificationStore(pool, config);
    const sender = new DefaultPushNotificationSender(store);
    const context = new ServerCallContext({
      user: new RouterUser("human:test", "Test Admin", "human", ["admin"], "admin@example.com"),
      requestedVersion: "1.0",
    });
    const taskId = crypto.randomUUID();
    const notificationConfig: TaskPushNotificationConfig = {
      tenant: "",
      id: "",
      taskId,
      url: `http://127.0.0.1:${address.port}/callback`,
      token: "callback-token",
      authentication: undefined,
    };
    await store.save(taskId, context, notificationConfig);
    expect(notificationConfig.id).not.toBe("");
    expect(rows[0]?.config_ciphertext).not.toContain("callback-token");

    const task: Task = {
      id: taskId,
      contextId: crypto.randomUUID(),
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        timestamp: new Date().toISOString(),
        message: {
          role: Role.ROLE_AGENT,
          messageId: crypto.randomUUID(),
          taskId,
          contextId: "",
          parts: [],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
      },
      artifacts: [],
      history: [],
      metadata: {},
    };
    await sender.send({ payload: { $case: "task", value: task } }, context, task);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.contentType).toBe("application/a2a+json");
    expect(requests[0]?.token).toBe("callback-token");
    expect(requests[0]?.body).toContain(taskId);
    server.close();
    await once(server, "close");
  });
});
