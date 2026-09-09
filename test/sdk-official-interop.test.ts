import { once } from "node:events";
import express from "express";
import { expect, test, vi } from "vitest";
import { AgentCard, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from "@a2a-js/sdk/server";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { AgentRouterClient, taskText, type Task as RouterTask } from "../packages/sdk/src/index.js";

test("SDK task operations interoperate with the unmodified official A2A server", async () => {
  const contexts = new Map<string, string>();
  const methods: string[] = [];
  const executor: AgentExecutor = {
    async execute(context, bus) {
      expect(context.userMessage.messageId).toBe("original-message");
      expect(context.userMessage.parts[0]?.content).toEqual({ $case: "text", value: "hello" });
      contexts.set(context.taskId, context.contextId);
      bus.publish({ kind: "task", data: Task.fromJSON({ id: context.taskId, contextId: context.contextId, status: { state: "TASK_STATE_WORKING" } }) });
      bus.publish({ kind: "artifactUpdate", data: TaskArtifactUpdateEvent.fromJSON({ taskId: context.taskId, contextId: context.contextId, artifact: { artifactId: "answer", parts: [{ text: "Official server reply" }] } }) });
    },
    async cancelTask(taskId, bus) {
      bus.publish({ kind: "statusUpdate", data: TaskStatusUpdateEvent.fromJSON({ taskId, contextId: contexts.get(taskId), status: { state: "TASK_STATE_CANCELED" } }) });
      bus.finished();
    },
  };
  const handler = new DefaultRequestHandler(AgentCard.fromJSON({ name: "official fixture", supportedInterfaces: [{ url: "https://fixture.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }], capabilities: { streaming: true } }), new InMemoryTaskStore(), executor);
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    expect(request.headers.authorization).toBe("Bearer home-token");
    expect(request.headers["a2a-version"]).toBe("1.0");
    methods.push(request.body.method);
    next();
  });
  app.use("/_agent-router/v1/agents/sender/gateway/agents/:matrixId/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const sdk = new AgentRouterClient({ baseUrl: `http://127.0.0.1:${address.port}/_agent-router/v1`, accessToken: "home-token", allowLocalHTTP: true });
    const target = { agentId: "sender", address: "owner/agent@remote.example", resolvedTarget: { address: "owner/agent@remote.example", matrixId: "@worker:remote.example" } };
    const sent = await sdk.send({ ...target, messageId: "original-message", text: "hello" });
    const task = await sdk.get({ ...target, taskId: sent.id });
    expect(task.contextId).toBe(sent.contextId);
    expect(taskText(task)).toBe("Official server reply");
    const snapshots: RouterTask[] = [];
    const watching = (async () => { for await (const update of sdk.watch({ ...target, taskId: sent.id })) snapshots.push(update); })();
    await vi.waitFor(() => expect(methods).toContain("SubscribeToTask"));
    const canceled = await sdk.cancel({ ...target, taskId: sent.id });
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
    await watching;
    expect(snapshots.at(-1)?.status.state).toBe("TASK_STATE_CANCELED");
    await expect(sdk.get({ ...target, taskId: "missing-task" })).rejects.toMatchObject({ code: "a2a_-32001" });
    expect(methods.filter(method => method === "SendMessage")).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 10000);

test("SDK preserves transport deadlines, strict task validation and no automatic send retries", async () => {
  const target = { agentId: "sender", address: "owner/agent@remote.example", resolvedTarget: { address: "owner/agent@remote.example", matrixId: "@worker:remote.example" } };
  let requests = 0;
  const sdk = new AgentRouterClient({ baseUrl: "https://home.example/_agent-router/v1", accessToken: "token", fetch: async () => { requests++; throw new TypeError("offline"); } });
  await expect(sdk.send({ ...target, messageId: "stable", text: "hello" })).rejects.toMatchObject({ code: "connection_unavailable" });
  expect(requests).toBe(1);
  const malformed = new AgentRouterClient({ baseUrl: sdk.baseUrl, accessToken: "token", fetch: async (_url, init) => Response.json({ jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, result: { id: 42, contextId: "context", status: { state: "TASK_STATE_WORKING" } } }) });
  await expect(malformed.get({ ...target, taskId: "42" })).rejects.toMatchObject({ code: "invalid_response" });
  const stalled = new AgentRouterClient({ baseUrl: sdk.baseUrl, accessToken: "token", timeoutMs: 20, fetch: async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); }) });
  await expect(stalled.get({ ...target, taskId: "task" })).rejects.toMatchObject({ name: "TimeoutError" });
});
