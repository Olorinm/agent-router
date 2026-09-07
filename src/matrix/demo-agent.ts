/** Reproducible A2A conformance fixture. Not a general-purpose production agent. */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import { AgentCard, Artifact, TaskState, type ListTasksRequest, type Task } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, type AgentExecutor, type ExecutionEventBus, type RequestContext,
  type ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, restHandler } from "@a2a-js/sdk/server/express";
import { agentCardRoute } from "./agent-card.js";
import { ConnectorStore } from "./store.js";
import { key, newTask, statusMessage, terminal } from "./protocol.js";
import { delay } from "./connector.js";
import { CodexSessionRuntime } from "./runtime-codex.js";

const port = Number(process.env.PORT ?? "8080");
const base = process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`;
const token = process.env.ENDPOINT_BEARER_TOKEN_FILE ? readFileSync(process.env.ENDPOINT_BEARER_TOKEN_FILE, "utf8").trim() : process.env.ENDPOINT_BEARER_TOKEN;
if (!token || token.length < 16) throw new Error("ENDPOINT_BEARER_TOKEN_required");
const store = new ConnectorStore(process.env.DEMO_STORE_PATH ?? "state/demo.sqlite", "a2a-demo-fixture");
class DurableTasks implements TaskStore {
  async save(task: Task, context: ServerCallContext) { store.set("tasks", key(context.tenant ?? "", context.user?.userName ?? "", task.id), task); }
  async load(id: string, context: ServerCallContext) { return store.get<Task>("tasks", key(context.tenant ?? "", context.user?.userName ?? "", id)); }
  async list(params: ListTasksRequest, context: ServerCallContext) {
    const rows = store.entries<Task>("tasks").filter((r) => r.id === key(context.tenant ?? "", context.user?.userName ?? "", r.value.id))
      .map((r) => r.value).filter((t) => (!params.contextId || t.contextId === params.contextId) && (!params.status || t.status?.state === params.status));
    return { tasks: rows.slice(0, params.pageSize || 50), nextPageToken: "", pageSize: params.pageSize || 50, totalSize: rows.length };
  }
}
// A fixture process restart cannot continue an interrupted tool call. Preserve the record and report failure.
for (const { id, value } of store.entries<Task>("tasks")) {
  if ([TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_SUBMITTED].includes(value.status?.state ?? 0)) {
    value.status = { state: TaskState.TASK_STATE_FAILED, timestamp: new Date().toISOString(), message: statusMessage(value, "fixture_restarted_during_execution") };
    store.set("tasks", id, value);
  }
}
class Executor implements AgentExecutor {
  private cancelled = new Set<string>();
  private contextQueues = new Map<string, Promise<void>>();
  private runtime = process.env.DEMO_RUNTIME === "codex" ? new CodexSessionRuntime(store) : undefined;
  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const task = context.task ?? newTask(context.taskId, context.contextId, context.userMessage);
    if (!task.history.some((m) => m.messageId === context.userMessage.messageId)) task.history.push(context.userMessage);
    task.status = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined };
    bus.publish(AgentEvent.task(task));
    const previous = this.contextQueues.get(context.contextId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.run(context, task, bus));
    this.contextQueues.set(context.contextId, current);
    try { await current; } finally { if (this.contextQueues.get(context.contextId) === current) this.contextQueues.delete(context.contextId); }
  }
  private async run(context: RequestContext, task: Task, bus: ExecutionEventBus): Promise<void> {
    if (this.cancelled.has(task.id)) return;
    const message = context.userMessage;
    store.set("invocations", message.messageId, { taskId: task.id, contextId: task.contextId,
      count: (store.get<{ count: number }>("invocations", message.messageId)?.count ?? 0) + 1 });
    const text = message.parts.filter((p) => p.content?.$case === "text").map((p) => p.content!.value).join("\n");
    let output: string;
    if (this.runtime) output = await this.runtime.run(task.id, task.contextId, text);
    else if (text.startsWith("remember ")) { store.set("memory", task.contextId, text.slice(9)); output = "remembered"; }
    else if (text === "recall") output = store.get<string>("memory", task.contextId) ?? "NO_MEMORY";
    else if (text === "input" && !context.task) {
      bus.publish(AgentEvent.statusUpdate({ taskId: task.id, contextId: task.contextId, metadata: {},
        status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, timestamp: new Date().toISOString(), message: statusMessage(task, "Please provide the missing input.") } }));
      return;
    } else if (text.startsWith("slow ")) {
      const until = Date.now() + Math.min(60_000, Math.max(0, Number(text.slice(5)) || 5_000));
      while (Date.now() < until && !this.cancelled.has(task.id)) await delay(100);
      output = "slow task finished";
    } else output = `echo: ${text}`;
    if (this.cancelled.has(task.id)) return;
    const artifact = Artifact.fromJSON({ artifactId: crypto.randomUUID(), name: "result", parts: [{ text: output }] });
    bus.publish(AgentEvent.artifactUpdate({ taskId: task.id, contextId: task.contextId, artifact, append: false, lastChunk: true, metadata: {} }));
    bus.publish(AgentEvent.statusUpdate({ taskId: task.id, contextId: task.contextId, metadata: {},
      status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: statusMessage(task, output) } }));
  }
  async cancelTask(taskId: string, bus: ExecutionEventBus) {
    this.cancelled.add(taskId); this.runtime?.cancel(taskId);
    bus.publish(AgentEvent.statusUpdate({ taskId, contextId: "", metadata: {},
      status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined } }));
  }
}
const card = AgentCard.fromJSON({ name: process.env.AGENT_NAME ?? "Matrix conformance agent", version: "1.0.0",
  description: "Persistent A2A fixture for Matrix interoperability and runtime-session verification.",
  supportedInterfaces: [{ url: `${base}/a2a/rest`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    { url: `${base}/a2a/jsonrpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  capabilities: { streaming: true }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
  skills: [{ id: "verification", name: "Verification", description: "remember / recall / input / slow / echo", tags: ["test"] }],
});
const handler = new DefaultRequestHandler(card, new DurableTasks(), new Executor());
const app = express(); app.disable("x-powered-by"); app.use(express.json({ limit: "64kb" }));
app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
const expected = createHash("sha256").update(token).digest();
app.use((req, res, next) => {
  const actual = createHash("sha256").update(req.headers.authorization?.replace(/^Bearer /, "") ?? "").digest();
  if (!timingSafeEqual(expected, actual)) { res.status(401).end(); return; } next();
});
app.get("/diagnostics", (_req, res) => res.json({ invocations: store.entries("invocations").map((r) => r.value),
  sessions: store.entries("codex_sessions").map((r) => ({ contextId: r.id, sessionId: r.value })),
  tasks: store.entries<Task>("tasks").map((r) => ({ id: r.value.id, terminal: terminal(r.value) })) }));
const userBuilder = async () => ({ isAuthenticated: true, userName: "connector" });
app.use("/.well-known/agent-card.json", agentCardRoute(handler));
app.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder }));
app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder }));
const server = app.listen(port, process.env.HOST ?? "127.0.0.1", () => process.stdout.write(`A2A fixture listening on ${port}\n`));
process.on("SIGTERM", () => { server.close(() => { store.close(); process.exit(0); }); });
