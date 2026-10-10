import type { SendMessageRequest, SendMessageResult, Task } from "@a2a-js/sdk";

export interface ExecutionSource { sender: string; room: string; approved: boolean; execution?: { accessMode: "read-only" | "workspace-write" }; }
export interface ExecutionBackend {
  send(request: SendMessageRequest, source?: ExecutionSource): Promise<SendMessageResult>;
  get(taskId: string): Promise<Task>;
  cancel(taskId: string): Promise<Task>;
}
