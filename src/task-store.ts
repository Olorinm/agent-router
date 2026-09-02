import { isDeepStrictEqual } from "node:util";
import {
  TaskState,
  type ListTasksRequest,
  type ListTasksResponse,
  type Task,
} from "@a2a-js/sdk";
import type { PushNotificationSender, ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./db.js";
import { parseFederationPrincipalId } from "./federation.js";
import { logError } from "./log.js";
import { parseDeliveryEnvelope, ROUTER_METADATA_KEY, type DeliveryEnvelope } from "./router-metadata.js";

interface TaskRow {
  task: Task;
  state: number;
  created_at: Date;
  updated_at: Date;
}

const terminalStates = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export class PostgresTaskStore implements TaskStore {
  constructor(
    private readonly pool: Pool,
    private readonly pushNotificationSender?: PushNotificationSender,
  ) {}

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const scope = scopeFromContext(context);
    const changed = await withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [scopeLockKey(scope, task.id)]);
      const existing = await loadTaskRow(client, scope, task.id, true);
      const nextState = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
      if (existing && terminalStates.has(existing.state) && existing.state !== nextState) return false;
      if (existing && isDeepStrictEqual(existing.task, task)) return false;

      const envelope = readEnvelope(task);
      if (!existing && !envelope) throw new Error("router_task_metadata_missing");
      const agentId = envelope?.agentId ?? (await currentAgentId(client, scope, task.id));
      const messageId = envelope?.messageId ?? (await currentMessageId(client, scope, task.id));
      if (!agentId || !messageId) throw new Error("router_task_scope_missing");

      await client.query(
        `INSERT INTO tasks(
           tenant, owner_principal_id, task_id, agent_id, message_id, idempotency_scope, state, task
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant, owner_principal_id, task_id) DO UPDATE SET
           state = EXCLUDED.state,
           task = EXCLUDED.task,
           updated_at = now()`,
        [
          scope.tenant,
          scope.ownerPrincipalId,
          task.id,
          agentId,
          messageId,
          messageIdempotencyScope(scope, agentId),
          nextState,
          JSON.stringify(task),
        ],
      );

      if (!existing || existing.state !== nextState) {
        await client.query(
          `INSERT INTO task_events(tenant, owner_principal_id, task_id, state, status)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [scope.tenant, scope.ownerPrincipalId, task.id, nextState, JSON.stringify(task.status ?? {})],
        );
      }

      if (!existing && envelope) await enqueueInitialDelivery(client, envelope);
      if (existing && nextState === TaskState.TASK_STATE_CANCELED && existing.state !== nextState) {
        await enqueueCancellation(client, scope, task.id, agentId);
      }
      return true;
    });
    if (changed && this.pushNotificationSender) {
      void this.pushNotificationSender
        .send({ payload: { $case: "task", value: structuredClone(task) } }, context, structuredClone(task))
        .catch((error) => logError("push_notification.dispatch_failed", error, { taskId: task.id }));
    }
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const row = await loadTaskRow(this.pool, scopeFromContext(context), taskId, false);
    return row ? structuredClone(row.task) : undefined;
  }

  async findByMessage(agentId: string, messageId: string, context: ServerCallContext): Promise<Task | undefined> {
    const scope = scopeFromContext(context);
    const result = await this.pool.query<{ task: Task }>(
      `SELECT task
         FROM tasks
        WHERE idempotency_scope = $1 AND message_id = $2
        LIMIT 1`,
      [messageIdempotencyScope(scope, agentId), messageId],
    );
    return result.rows[0]?.task ? structuredClone(result.rows[0].task) : undefined;
  }

  async acquireMessageLock(agentId: string, messageId: string, context: ServerCallContext): Promise<() => Promise<void>> {
    const scope = scopeFromContext(context);
    const key = JSON.stringify([messageIdempotencyScope(scope, agentId), messageId]);
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    } catch (error) {
      client.release();
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } finally {
        client.release();
      }
    };
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const scope = scopeFromContext(context);
    const pageSize = Math.min(Math.max(params.pageSize || 20, 1), 100);
    const values: unknown[] = [scope.tenant, scope.ownerPrincipalId];
    const where = ["tenant = $1", "owner_principal_id = $2"];
    if (params.contextId) {
      values.push(params.contextId);
      where.push(`task->>'contextId' = $${values.length}`);
    }
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      values.push(params.status);
      where.push(`state = $${values.length}`);
    }
    if (params.statusTimestampAfter) {
      values.push(params.statusTimestampAfter);
      where.push(`updated_at > $${values.length}::timestamptz`);
    }
    const cursor = decodeCursor(params.pageToken);
    if (cursor) {
      values.push(cursor.updatedAt, cursor.taskId);
      where.push(`(updated_at, task_id) < ($${values.length - 1}::timestamptz, $${values.length})`);
    }
    values.push(pageSize + 1);
    const result = await this.pool.query<TaskRow & { task_id: string }>(
      `SELECT task_id, task, state, created_at, updated_at
         FROM tasks
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, task_id DESC
        LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > pageSize;
    const selected = result.rows.slice(0, pageSize);
    const tasks = selected.map((row) => {
      const task = structuredClone(row.task);
      if (!params.includeArtifacts) task.artifacts = [];
      if (params.historyLength !== undefined && task.history) {
        task.history = task.history.slice(-Math.max(0, params.historyLength));
      }
      return task;
    });
    const last = selected.at(-1);
    return {
      tasks,
      nextPageToken: hasMore && last ? encodeCursor(last.updated_at, last.task_id) : "",
      pageSize,
      totalSize: tasks.length,
    };
  }
}

async function loadTaskRow(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  scope: TaskScope,
  taskId: string,
  forUpdate: boolean,
): Promise<TaskRow | undefined> {
  const result = await client.query<TaskRow>(
    `SELECT task, state, created_at, updated_at
       FROM tasks
      WHERE tenant = $1 AND owner_principal_id = $2 AND task_id = $3${forUpdate ? " FOR UPDATE" : ""}`,
    [scope.tenant, scope.ownerPrincipalId, taskId],
  );
  return result.rows[0];
}

async function currentAgentId(client: PoolClient, scope: TaskScope, taskId: string): Promise<string | undefined> {
  const result = await client.query<{ agent_id: string }>(
    "SELECT agent_id FROM tasks WHERE tenant = $1 AND owner_principal_id = $2 AND task_id = $3",
    [scope.tenant, scope.ownerPrincipalId, taskId],
  );
  return result.rows[0]?.agent_id;
}

async function currentMessageId(client: PoolClient, scope: TaskScope, taskId: string): Promise<string | undefined> {
  const result = await client.query<{ message_id: string }>(
    "SELECT message_id FROM tasks WHERE tenant = $1 AND owner_principal_id = $2 AND task_id = $3",
    [scope.tenant, scope.ownerPrincipalId, taskId],
  );
  return result.rows[0]?.message_id;
}

async function enqueueInitialDelivery(client: PoolClient, envelope: DeliveryEnvelope): Promise<void> {
  await client.query(
    `INSERT INTO messages(
       tenant, owner_principal_id, router_task_id, message_id, sender_address, recipient_address, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (tenant, owner_principal_id, recipient_address, message_id) DO NOTHING`,
    [
      envelope.tenant,
      envelope.ownerPrincipalId,
      envelope.routerTaskId,
      envelope.messageId,
      envelope.ownerPrincipalId,
      envelope.agentAddress,
      JSON.stringify(envelope.message),
    ],
  );
  await client.query(
    `INSERT INTO task_bindings(
       tenant, owner_principal_id, router_task_id, agent_id, remote_domain, remote_subject, delivery_state
     ) VALUES ($1, $2, $3, $4, $5, $6, 'queued')
     ON CONFLICT (tenant, owner_principal_id, router_task_id) DO NOTHING`,
    [
      envelope.tenant,
      envelope.ownerPrincipalId,
      envelope.routerTaskId,
      envelope.agentId,
      envelope.targetDomain ?? null,
      envelope.targetKind === "federated" ? envelope.senderAddress : null,
    ],
  );
  await insertOutbox(client, "deliver", envelope, `deliver:${scopeKey(envelope)}:${envelope.attempt}`);
  await client.query(
    `INSERT INTO audit_logs(principal_id, action, target, outcome, facts)
     VALUES ($1, 'task.enqueue', $2, 'success', $3::jsonb)`,
    [envelope.ownerPrincipalId, envelope.agentAddress, JSON.stringify({ taskId: envelope.routerTaskId })],
  );
}

async function enqueueCancellation(
  client: PoolClient,
  scope: TaskScope,
  taskId: string,
  agentId: string,
): Promise<void> {
  const binding = await client.query<{
    remote_task_id: string | null;
    remote_domain: string | null;
    remote_subject: string | null;
  }>(
    `SELECT remote_task_id, remote_domain, remote_subject FROM task_bindings
      WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
    [scope.tenant, scope.ownerPrincipalId, taskId],
  );
  const remoteTaskId = binding.rows[0]?.remote_task_id;
  if (!remoteTaskId) {
    await client.query(
      `UPDATE task_bindings SET delivery_state = 'canceled', updated_at = now()
        WHERE tenant = $1 AND owner_principal_id = $2 AND router_task_id = $3`,
      [scope.tenant, scope.ownerPrincipalId, taskId],
    );
    return;
  }
  const row = binding.rows[0];
  const payload = {
    ...scope,
    routerTaskId: taskId,
    agentId,
    remoteTaskId,
    ...(row?.remote_domain ? { remoteDomain: row.remote_domain } : {}),
    ...(row?.remote_subject ? { remoteSubject: row.remote_subject } : {}),
    attempt: 0,
  };
  await insertOutbox(client, "cancel", payload, `cancel:${scope.tenant}:${scope.ownerPrincipalId}:${taskId}`);
}

export async function insertOutbox(
  client: PoolClient,
  kind: "deliver" | "cancel",
  payload: unknown,
  idempotencyKey: string,
  availableAt?: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox(kind, aggregate_key, idempotency_key, payload, available_at)
     VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, now()))
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [kind, idempotencyKey, idempotencyKey, JSON.stringify(payload), availableAt ?? null],
  );
}

interface TaskScope {
  tenant: string;
  ownerPrincipalId: string;
}

function scopeFromContext(context: ServerCallContext): TaskScope {
  const ownerPrincipalId = context.user?.userName;
  if (!ownerPrincipalId) throw new Error("authenticated_task_owner_required");
  return { tenant: context.tenant ?? "", ownerPrincipalId };
}

function readEnvelope(task: Task): DeliveryEnvelope | undefined {
  const value = task.metadata?.[ROUTER_METADATA_KEY];
  return value ? parseDeliveryEnvelope(value) : undefined;
}

function scopeLockKey(scope: TaskScope, taskId: string): string {
  return JSON.stringify([scope.tenant, scope.ownerPrincipalId, taskId]);
}

function messageIdempotencyScope(scope: TaskScope, agentId: string): string {
  const federation = parseFederationPrincipalId(scope.ownerPrincipalId);
  return federation
    ? JSON.stringify(["federation", federation.issuer])
    : JSON.stringify(["local", scope.tenant, scope.ownerPrincipalId, agentId]);
}

function scopeKey(envelope: DeliveryEnvelope): string {
  return `${envelope.tenant}:${envelope.ownerPrincipalId}:${envelope.routerTaskId}`;
}

function encodeCursor(updatedAt: Date, taskId: string): string {
  return Buffer.from(JSON.stringify([updatedAt.toISOString(), taskId])).toString("base64url");
}

function decodeCursor(value: string | undefined): { updatedAt: string; taskId: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((entry) => typeof entry !== "string")) {
      throw new Error("page_token_invalid");
    }
    return { updatedAt: parsed[0] as string, taskId: parsed[1] as string };
  } catch {
    throw new Error("page_token_invalid");
  }
}
