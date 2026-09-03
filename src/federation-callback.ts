import { isDeepStrictEqual } from "node:util";
import { timingSafeEqual } from "node:crypto";
import {
  StreamResponse,
  TaskState,
  type Artifact,
  type Message,
  type Task,
  type TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import type { Pool } from "pg";
import { routerUserForPrincipalId } from "./auth.js";
import { hashCredential } from "./crypto.js";
import type { FederationIdentity } from "./federation.js";
import type { PostgresTaskStore } from "./task-store.js";
import type { TaskEventHub } from "./task-events.js";

interface BindingRow {
  tenant: string;
  owner_principal_id: string;
  remote_task_id: string | null;
  delivery_state: string;
  callback_token_hash: string | null;
}

export class FederationCallbackError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 409,
  ) {
    super(message);
  }
}

export class FederationCallbackReceiver {
  constructor(
    private readonly pool: Pool,
    private readonly taskStore: PostgresTaskStore,
    private readonly taskEvents: TaskEventHub,
  ) {}

  async receive(routerTaskId: string, identity: FederationIdentity, raw: unknown): Promise<void> {
    const response = StreamResponse.fromJSON(raw);
    const remoteTaskId = taskIdFromResponse(response);
    if (!remoteTaskId) throw new FederationCallbackError("federation_push_task_id_missing", 400);
    const result = await this.pool.query<BindingRow>(
      `SELECT tenant, owner_principal_id, remote_task_id, delivery_state, callback_token_hash
         FROM task_bindings
        WHERE router_task_id = $1 AND remote_domain = $2
        LIMIT 2`,
      [routerTaskId, identity.domain],
    );
    if (result.rowCount !== 1) throw new FederationCallbackError("federation_push_binding_not_found", 404);
    const binding = result.rows[0]!;
    if (binding.remote_task_id && binding.remote_task_id !== remoteTaskId) {
      throw new FederationCallbackError("federation_push_remote_task_mismatch", 409);
    }
    await this.apply(routerTaskId, response, binding);
  }

  async receiveLocal(routerTaskId: string, token: string, raw: unknown): Promise<void> {
    if (!token) throw new FederationCallbackError("push_token_invalid", 401);
    const response = StreamResponse.fromJSON(raw);
    const remoteTaskId = taskIdFromResponse(response);
    if (!remoteTaskId) throw new FederationCallbackError("push_task_id_missing", 400);
    const result = await this.pool.query<BindingRow>(
      `SELECT tenant, owner_principal_id, remote_task_id, delivery_state, callback_token_hash
         FROM task_bindings
        WHERE router_task_id = $1 AND remote_domain IS NULL
        LIMIT 2`,
      [routerTaskId],
    );
    if (result.rowCount !== 1) throw new FederationCallbackError("push_binding_not_found", 404);
    const binding = result.rows[0]!;
    if (!binding.callback_token_hash || !equalHash(binding.callback_token_hash, hashCredential(token))) {
      throw new FederationCallbackError("push_token_invalid", 401);
    }
    if (binding.remote_task_id && binding.remote_task_id !== remoteTaskId) {
      throw new FederationCallbackError("push_remote_task_mismatch", 409);
    }
    await this.apply(routerTaskId, response, binding);
  }

  private async apply(
    routerTaskId: string,
    response: ReturnType<typeof StreamResponse.fromJSON>,
    binding: BindingRow,
  ): Promise<void> {
    const remoteTaskId = taskIdFromResponse(response);
    if (binding.delivery_state === "canceled") return;

    const context = new ServerCallContext({
      ...(binding.tenant ? { tenant: binding.tenant } : {}),
      user: routerUserForPrincipalId(binding.owner_principal_id),
      requestedVersion: "1.0",
    });
    const current = await this.taskStore.load(routerTaskId, context);
    if (!current) throw new FederationCallbackError("federation_push_task_not_found", 404);
    if (isTerminal(current.status?.state)) {
      if (current.status?.state !== TaskState.TASK_STATE_CANCELED) {
        await this.pool.query(
          `UPDATE task_bindings SET delivery_state = 'delivered', next_poll_at = NULL,
             callback_received_at = now(), updated_at = now()
           WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3
             AND delivery_state <> 'canceled'`,
          [binding.tenant, binding.owner_principal_id, routerTaskId],
        );
      }
      return;
    }
    const applied = applyResponse(current, response);

    if (!isDeepStrictEqual(current, applied.task)) await this.taskStore.save(applied.task, context);
    await this.pool.query(
      `UPDATE task_bindings SET
         remote_task_id = COALESCE(remote_task_id, $4),
         remote_context_id = COALESCE(remote_context_id, $5),
         callback_received_at = now(),
         delivery_state = CASE
           WHEN delivery_state IN ('delivered', 'canceled') THEN delivery_state
           WHEN $6 THEN 'delivered'
           ELSE 'awaiting_result'
         END,
         next_poll_at = CASE WHEN $6 OR delivery_state IN ('delivered', 'canceled') THEN NULL ELSE next_poll_at END,
         updated_at = now()
       WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
      [
        binding.tenant,
        binding.owner_principal_id,
        routerTaskId,
        remoteTaskId,
        remoteContextIdFromResponse(response),
        isTerminal(applied.task.status?.state),
      ],
    );
    if (isDeepStrictEqual(current, applied.task)) return;
    if (applied.artifactEvent) this.taskEvents.publishArtifact(applied.artifactEvent);
    if (applied.messageEvent) this.taskEvents.publishMessage(applied.messageEvent);
    if (applied.task.status && isTerminal(applied.task.status.state)) this.taskEvents.publishFinal(applied.task);
    else if (applied.statusChanged) this.taskEvents.publishStatus(applied.task);
  }
}

function equalHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function applyResponse(current: Task, response: ReturnType<typeof StreamResponse.fromJSON>): {
  task: Task;
  artifactEvent?: TaskArtifactUpdateEvent;
  messageEvent?: Message;
  statusChanged: boolean;
} {
  const task = structuredClone(current);
  const payload = response.payload;
  if (!payload) throw new FederationCallbackError("federation_push_payload_missing", 400);
  switch (payload.$case) {
    case "task": {
      const remote = payload.value;
      const status = structuredClone(remote.status);
      if (status?.message) status.message = remapMessage(status.message, current);
      task.status = status;
      task.artifacts = structuredClone(remote.artifacts ?? []);
      task.history = mergeHistory(
        task.history ?? [],
        (remote.history ?? []).map((message) => remapMessage(message, current)),
        status?.message ? [status.message] : [],
      );
      return { task, statusChanged: !isDeepStrictEqual(current.status, task.status) };
    }
    case "statusUpdate": {
      if (!payload.value.status) throw new FederationCallbackError("federation_push_status_missing", 400);
      task.status = structuredClone(payload.value.status);
      if (task.status.message) {
        task.status.message = remapMessage(task.status.message, current);
        task.history = mergeHistory(task.history ?? [], [task.status.message]);
      }
      return { task, statusChanged: !isDeepStrictEqual(current.status, task.status) };
    }
    case "artifactUpdate": {
      const remoteEvent = payload.value;
      if (!remoteEvent.artifact) throw new FederationCallbackError("federation_push_artifact_missing", 400);
      const artifact = mergeArtifact(task.artifacts ?? [], remoteEvent.artifact, remoteEvent.append);
      task.artifacts = artifact.artifacts;
      return {
        task,
        artifactEvent: {
          ...structuredClone(remoteEvent),
          taskId: current.id,
          contextId: current.contextId,
          artifact: artifact.value,
        },
        statusChanged: false,
      };
    }
    case "message": {
      const message = remapMessage(payload.value, current);
      task.history = mergeHistory(task.history ?? [], [message]);
      return { task, messageEvent: message, statusChanged: false };
    }
  }
}

function mergeArtifact(existing: Artifact[], incoming: Artifact, append: boolean): { artifacts: Artifact[]; value: Artifact } {
  const artifacts = structuredClone(existing);
  const index = artifacts.findIndex((artifact) => artifact.artifactId === incoming.artifactId);
  const value = append && index >= 0
    ? { ...structuredClone(incoming), parts: [...artifacts[index]!.parts, ...structuredClone(incoming.parts)] }
    : structuredClone(incoming);
  if (index >= 0) artifacts[index] = value;
  else artifacts.push(value);
  return { artifacts, value };
}

function remapMessage(message: Message, task: Task): Message {
  return { ...structuredClone(message), taskId: task.id, contextId: task.contextId };
}

function mergeHistory(...groups: Message[][]): Message[] {
  const messages = new Map<string, Message>();
  for (const group of groups) for (const message of group) messages.set(message.messageId, structuredClone(message));
  return [...messages.values()];
}

function taskIdFromResponse(response: ReturnType<typeof StreamResponse.fromJSON>): string {
  switch (response.payload?.$case) {
    case "task":
      return response.payload.value.id;
    case "statusUpdate":
    case "artifactUpdate":
    case "message":
      return response.payload.value.taskId;
    default:
      return "";
  }
}

function remoteContextIdFromResponse(response: ReturnType<typeof StreamResponse.fromJSON>): string | null {
  switch (response.payload?.$case) {
    case "task":
      return response.payload.value.contextId || null;
    case "statusUpdate":
    case "artifactUpdate":
    case "message":
      return response.payload.value.contextId || null;
    default:
      return null;
  }
}

function isTerminal(value: TaskState | undefined): boolean {
  return value === TaskState.TASK_STATE_COMPLETED ||
    value === TaskState.TASK_STATE_FAILED ||
    value === TaskState.TASK_STATE_CANCELED ||
    value === TaskState.TASK_STATE_REJECTED;
}
