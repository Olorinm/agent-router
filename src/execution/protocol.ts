import { createHash } from "node:crypto";
import { Message, SendMessageResponse, Task, TaskState, type SendMessageResult } from "@a2a-js/sdk";

export const terminal = (task: Task): boolean => [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].includes(task.status?.state ?? 0);
export const key = (...parts: string[]): string => JSON.stringify(parts);
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
export function sized<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 48_000) throw new Error("matrix_event_too_large_use_file_reference");
  return value;
}
export function encodeResult(result: SendMessageResult): Record<string, unknown> {
  return SendMessageResponse.toJSON({ payload: "messageId" in result
    ? { $case: "message", value: result } : { $case: "task", value: result } }) as Record<string, unknown>;
}
export function textPart(text: string) {
  return { content: { $case: "text" as const, value: text }, mediaType: "text/plain", filename: "", metadata: {} };
}
export function statusMessage(task: Task, text: string): Message {
  return Message.fromJSON({ role: "ROLE_AGENT", messageId: crypto.randomUUID(), taskId: task.id,
    contextId: task.contextId, parts: [{ text, mediaType: "text/plain" }] });
}
export function newTask(taskId: string, contextId: string, message: Message): Task {
  return { id: taskId, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED,
    timestamp: new Date().toISOString(), message: undefined }, history: [message], artifacts: [], metadata: {} };
}
