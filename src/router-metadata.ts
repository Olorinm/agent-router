import type { Message } from "@a2a-js/sdk";
import { z } from "zod";

export const ROUTER_METADATA_KEY = "opengroveRouter";

export interface DeliveryEnvelope {
  agentId: string;
  agentAddress: string;
  tenant: string;
  ownerPrincipalId: string;
  routerTaskId: string;
  routerContextId: string;
  messageId: string;
  message: Message;
  attempt: number;
}

const envelopeSchema = z.object({
  agentId: z.string().uuid(),
  agentAddress: z.string().min(3),
  tenant: z.string(),
  ownerPrincipalId: z.string().min(1),
  routerTaskId: z.string().min(1),
  routerContextId: z.string().min(1),
  messageId: z.string().min(1),
  message: z.unknown(),
  attempt: z.number().int().min(0),
});

export function parseDeliveryEnvelope(value: unknown): DeliveryEnvelope {
  const parsed = envelopeSchema.parse(value);
  return { ...parsed, message: parsed.message as Message };
}
