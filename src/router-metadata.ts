import type { Message } from "@a2a-js/sdk";
import { z } from "zod";

export const ROUTER_METADATA_KEY = "agentRouter";

export interface DeliveryEnvelope {
  agentId: string;
  agentAddress: string;
  tenant: string;
  ownerPrincipalId: string;
  routerTaskId: string;
  routerContextId: string;
  messageId: string;
  senderAddress: string;
  targetKind: "local" | "federated";
  targetDomain?: string;
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
  senderAddress: z.string().min(3),
  targetKind: z.enum(["local", "federated"]),
  targetDomain: z.string().min(3).optional(),
  message: z.unknown(),
  attempt: z.number().int().min(0),
});

export function parseDeliveryEnvelope(value: unknown): DeliveryEnvelope {
  const parsed = envelopeSchema.parse(value);
  if (parsed.targetKind === "federated" && !parsed.targetDomain) throw new Error("federation_target_domain_missing");
  return {
    agentId: parsed.agentId,
    agentAddress: parsed.agentAddress,
    tenant: parsed.tenant,
    ownerPrincipalId: parsed.ownerPrincipalId,
    routerTaskId: parsed.routerTaskId,
    routerContextId: parsed.routerContextId,
    messageId: parsed.messageId,
    senderAddress: parsed.senderAddress,
    targetKind: parsed.targetKind,
    ...(parsed.targetDomain ? { targetDomain: parsed.targetDomain } : {}),
    message: parsed.message as Message,
    attempt: parsed.attempt,
  };
}
