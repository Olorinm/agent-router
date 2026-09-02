import { TaskState, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultExecutionEventBusManager,
  type ExecutionEventBusManager,
} from "@a2a-js/sdk/server";
import type { Pool } from "pg";

const terminalStates = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export class TaskEventHub {
  readonly manager: ExecutionEventBusManager = new DefaultExecutionEventBusManager();

  async recoverNonTerminal(pool: Pool): Promise<void> {
    const result = await pool.query<{ task_id: string }>(
      `SELECT DISTINCT task_id FROM tasks WHERE state <> ALL($1::integer[])`,
      [[...terminalStates]],
    );
    for (const row of result.rows) this.manager.createOrGetByTaskId(row.task_id);
  }

  publishStatus(task: Task): void {
    const status = task.status;
    if (!status) return;
    const bus = this.manager.createOrGetByTaskId(task.id);
    bus.publish(
      AgentEvent.statusUpdate({
        taskId: task.id,
        contextId: task.contextId,
        status: structuredClone(status),
        metadata: {},
      }),
    );
    if (terminalStates.has(status.state)) this.finish(task.id, bus);
  }

  publishFinal(task: Task): void {
    const bus = this.manager.createOrGetByTaskId(task.id);
    for (const artifact of task.artifacts ?? []) {
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId: task.id,
          contextId: task.contextId,
          artifact: structuredClone(artifact),
          append: false,
          lastChunk: true,
          metadata: {},
        }),
      );
    }
    if (task.status) {
      bus.publish(
        AgentEvent.statusUpdate({
          taskId: task.id,
          contextId: task.contextId,
          status: structuredClone(task.status),
          metadata: {},
        }),
      );
    }
    if (task.status && terminalStates.has(task.status.state)) this.finish(task.id, bus);
  }

  finish(taskId: string, bus = this.manager.getByTaskId(taskId)): void {
    bus?.finished();
    this.manager.cleanupByTaskId(taskId);
  }
}
