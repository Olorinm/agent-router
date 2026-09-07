import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { A2A_PROTOCOL_VERSION, AgentCard, Message, Task, TaskState, TaskArtifactUpdateEvent, TaskStatusUpdateEvent,
  type CancelTaskRequest, type GetTaskRequest, type ListTasksRequest, type ListTasksResponse,
  type SendMessageRequest, type StreamResponse, type SubscribeToTaskRequest } from "@a2a-js/sdk";
import { type A2ARequestHandler, type ServerCallContext } from "@a2a-js/sdk/server";
import { PushNotificationNotSupportedError, RequestMalformedError, TaskNotCancelableError,
  TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { MatrixConnector, delay, type Conversation, type Outgoing } from "./connector.js";
import { digest, key, newTask, terminal } from "./protocol.js";

export const requestSignal = new AsyncLocalStorage<AbortSignal>();

/** The official SDK provides REST, JSON-RPC, wire objects, and errors. This adapter owns task routing. */
export class MatrixA2AHandler implements A2ARequestHandler {
  private sends = new Map<string, Promise<Task>>();
  constructor(readonly connector: MatrixConnector, readonly target: string, readonly baseUrl: string) {}
  async getAgentCard(): Promise<AgentCard> {
    const base = `${this.baseUrl}/agents/${encodeURIComponent(this.target)}`;
    return AgentCard.fromJSON({ name: this.target, description: "A2A task gateway through Matrix; execution is subject to recipient permission.",
      version: "0.6.0", supportedInterfaces: [
        { url: `${base}/a2a/rest`, protocolBinding: "HTTP+JSON", protocolVersion: A2A_PROTOCOL_VERSION },
        { url: `${base}/a2a/jsonrpc`, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION },
      ], capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ["text/plain", "application/json"], defaultOutputModes: ["text/plain", "application/json"],
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      skills: [{ id: "matrix-routed-task", name: "Routed task", description: "Deliver work to this Matrix agent.", tags: ["a2a", "matrix"] }],
    });
  }
  async getAuthenticatedExtendedAgentCard(): Promise<AgentCard> { throw new UnsupportedOperationError("Extended cards are not supported"); }
  async sendMessage(request: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    if (context.tenant || request.tenant) throw new RequestMalformedError("Tenants are not supported by this single-identity connector");
    if (!request.message?.messageId || !request.message.parts.length) throw new RequestMalformedError("A nonempty Message is required");
    if (request.configuration?.taskPushNotificationConfig) throw new PushNotificationNotSupportedError();
    const requestKey = key(this.target, request.message.messageId);
    const pending = this.sends.get(requestKey);
    if (pending) { await pending; return this.sendResult(await this.createSend(request, requestKey), request); }
    const promise = this.createSend(request, requestKey);
    this.sends.set(requestKey, promise);
    let task: Task;
    try { task = await promise; } finally { this.sends.delete(requestKey); }
    return this.sendResult(task, request);
  }
  private async sendResult(task: Task, request: SendMessageRequest): Promise<Task> {
    const signal = requestSignal.getStore();
    while (request.configuration?.returnImmediately !== true && !terminal(task) &&
      ![TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state ?? 0)) {
      signal?.throwIfAborted(); await delay(100); task = this.ownedTask(task.id);
    }
    return withHistory(task, request.configuration?.historyLength);
  }
  private async createSend(original: SendMessageRequest, requestKey: string): Promise<Task> {
    const request = structuredClone(original);
    const message = request.message!;
    const hash = digest(request);
    const previous = this.connector.store.get<{ hash: string; taskId: string }>("message_ids", requestKey);
    if (previous) {
      if (previous.hash !== hash) throw new RequestMalformedError("messageId was reused with different content");
      return this.ownedTask(previous.taskId);
    }
    let task: Task;
    let conversation: Conversation;
    if (message.taskId) {
      task = this.ownedTask(message.taskId);
      if (terminal(task)) throw new UnsupportedOperationError("A terminal task cannot accept further messages");
      if (message.contextId && message.contextId !== task.contextId) throw new RequestMalformedError("Task and context do not match");
      conversation = await this.connector.conversation(this.target, task.contextId);
      task.history.push(message);
      task.status = { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined };
    } else {
      try { conversation = await this.connector.conversation(this.target, message.contextId || undefined); }
      catch { throw new RequestMalformedError("Conversation does not exist for this destination"); }
      task = newTask(randomUUID(), conversation.id, message);
    }
    message.contextId = conversation.id;
    this.connector.store.transaction(() => {
      this.connector.enqueue(this.target, conversation, task, request, "send");
      this.connector.store.set("message_ids", requestKey, { hash, taskId: task.id });
      this.connector.store.set("message_origins", digest(key(conversation.room, this.connector.userId, message.messageId)), message.messageId);
    });
    return task;
  }
  private ownedTask(id: string): Task {
    const task = this.connector.task(id);
    if (!task || this.connector.taskTarget(id) !== this.target) throw new TaskNotFoundError("Task not found");
    return task;
  }
  async getTask(request: GetTaskRequest): Promise<Task> {
    return withHistory(this.ownedTask(request.id), request.historyLength);
  }
  async listTasks(request: ListTasksRequest): Promise<ListTasksResponse> {
    const pageSize = request.pageSize || 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RequestMalformedError("Invalid page size");
    let offset = 0;
    if (request.pageToken) {
      const decoded = Buffer.from(request.pageToken, "base64url").toString();
      if (!/^\d+$/.test(decoded)) throw new RequestMalformedError("Invalid page token");
      offset = Number(decoded);
    }
    const tasks = this.connector.tasks().filter((t) => this.connector.taskTarget(t.id) === this.target &&
      (!request.contextId || t.contextId === request.contextId) && (!request.status || t.status?.state === request.status) &&
      (!request.statusTimestampAfter || (t.status?.timestamp ?? "") > request.statusTimestampAfter));
    return { tasks: tasks.slice(offset, offset + pageSize).map((task) => {
      const copy = withHistory(task, request.historyLength);
      if (!request.includeArtifacts) copy.artifacts = [];
      return copy;
    }), nextPageToken: offset + pageSize < tasks.length ? Buffer.from(String(offset + pageSize)).toString("base64url") : "",
    pageSize, totalSize: tasks.length };
  }
  async cancelTask(request: CancelTaskRequest): Promise<Task> {
    const task = this.ownedTask(request.id);
    if (task.status?.state === 5) return task;
    if (terminal(task)) throw new TaskNotCancelableError("Task is already terminal");
    const conversation = await this.connector.conversation(this.target, task.contextId);
    let outgoing!: Outgoing;
    this.connector.store.transaction(() => { outgoing = this.connector.enqueue(this.target, conversation, task,
      { message: undefined, configuration: undefined, metadata: {}, tenant: "" }, "cancel"); });
    const until = Date.now() + 25_000;
    while (Date.now() < until) {
      requestSignal.getStore()?.throwIfAborted();
      const result = this.connector.task(task.id)!;
      const operation = this.connector.store.get<Outgoing>("outgoing", outgoing.id)!;
      if (result.status?.state === 5) return result;
      if (terminal(result) || operation.error) throw new TaskNotCancelableError("Destination did not cancel this task");
      await delay(100);
    }
    throw new TaskNotCancelableError("Cancellation remains queued; query the task for its eventual state");
  }
  async *sendMessageStream(request: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    const task = await this.sendMessage({ ...request, configuration: { acceptedOutputModes: [], historyLength: 20,
      taskPushNotificationConfig: undefined, ...request.configuration, returnImmediately: true } }, context);
    yield* this.stream(task.id);
  }
  async *resubscribe(request: SubscribeToTaskRequest): AsyncGenerator<StreamResponse> {
    if (terminal(this.ownedTask(request.id))) throw new UnsupportedOperationError("Cannot subscribe to a terminal task");
    yield* this.stream(request.id);
  }
  private async *stream(id: string): AsyncGenerator<StreamResponse> {
    let task = this.ownedTask(id);
    yield { payload: { $case: "task", value: task } };
    while (!terminal(task)) {
      requestSignal.getStore()?.throwIfAborted();
      await delay(200);
      const next = this.ownedTask(id);
      if (digest(next) === digest(task)) continue;
      for (const artifact of next.artifacts) {
        if (digest(artifact) === digest(task.artifacts.find((a) => a.artifactId === artifact.artifactId))) continue;
        const event = TaskArtifactUpdateEvent.fromJSON({ taskId: id, contextId: next.contextId,
          artifact: (await import("@a2a-js/sdk")).Artifact.toJSON(artifact), append: false, lastChunk: true });
        yield { payload: { $case: "artifactUpdate", value: event } };
      }
      if (next.status) {
        const event = TaskStatusUpdateEvent.fromJSON({ taskId: id, contextId: next.contextId,
          status: (await import("@a2a-js/sdk")).TaskStatus.toJSON(next.status) });
        yield { payload: { $case: "statusUpdate", value: event } };
      }
      task = next;
    }
  }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
}
function withHistory(task: Task, length: number | undefined): Task {
  if (length !== undefined && (length < 0 || !Number.isInteger(length))) throw new RequestMalformedError("Invalid history length");
  if (length === 0) task.history = [];
  else if (length !== undefined) task.history = task.history.slice(-length);
  return task;
}
