import { Message, SendMessageRequest, SendMessageResponse, Task, TaskState, type SendMessageResult } from "@a2a-js/sdk";
import { z } from "zod";

export const REQUEST_EVENT = "io.agentrouter.a2a.request";
export const RESPONSE_EVENT = "io.agentrouter.a2a.response";
export const ROOM_EVENT = "io.agentrouter.conversation";
export const mxid = z.string().max(255).regex(/^@[a-z0-9._=\-/+]+:[a-zA-Z0-9.-]+(?::[0-9]+)?$/);
const id = z.string().min(1).max(255);
export const requestSchema = z.object({
  version: z.literal(1), requestId: id, recipient: mxid,
  taskId: id, contextId: id, operation: z.enum(["send", "cancel"]),
  body: z.record(z.string(), z.unknown()),
}).strict();
export const responseSchema = z.object({
  version: z.literal(1), requestId: id, recipient: mxid, taskId: id,
  sequence: z.number().int().positive(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string().max(100), message: z.string().max(500) }).strict().optional(),
}).strict().refine((v) => Boolean(v.result) !== Boolean(v.error), "exactly one result or error is required");
export type RequestEvent = z.infer<typeof requestSchema>;
export type ResponseEvent = z.infer<typeof responseSchema>;
export interface RoomEvent { event_id: string; sender: string; type: string; content: Record<string, unknown>; state_key?: string; redacts?: string; }
export function decodeResult(raw: Record<string, unknown>): SendMessageResult {
  const value = SendMessageResponse.fromJSON(raw).payload;
  if (!value) throw new Error("invalid_a2a_result");
  if (value.$case === "task" && (!value.value.id || !value.value.status)) throw new Error("invalid_a2a_task");
  if (value.$case === "message" && !value.value.messageId) throw new Error("invalid_a2a_message");
  return value.value;
}
export function decodeRequest(raw: Record<string, unknown>): SendMessageRequest {
  const value = SendMessageRequest.fromJSON(raw);
  if (!value.message?.messageId || !value.message.parts.length) throw new Error("invalid_a2a_message");
  // Push destinations and tenants belong to the gateway boundary, never to a peer's execution host.
  if (value.configuration?.taskPushNotificationConfig) throw new Error("remote_push_config_forbidden");
  if (value.tenant) throw new Error("remote_tenant_forbidden");
  return value;
}

export { terminal, key, digest, sized, encodeResult, textPart, statusMessage, newTask } from "../execution/protocol.js";
