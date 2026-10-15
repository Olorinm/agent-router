import { z } from "zod";

const identifiers = z.array(z.string().min(1).max(320)).min(1).max(100);
export const invocationRuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  match: z.object({
    channelKinds: identifiers.optional(), entryIds: identifiers.optional(),
    visitorIds: identifiers.optional(), subjects: identifiers.optional(),
    domains: z.array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)).min(1).max(100).optional(),
    agentIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    operations: z.array(z.literal("invoke")).min(1).optional(),
  }).strict(),
  decision: z.enum(["allow", "ask", "deny"]),
}).strict();
export type InvocationRule = z.infer<typeof invocationRuleSchema>;
export interface InvocationContext {
  channelKind: string; entryId: string; visitorId: string; subject: string;
  domain?: string; agentId: string; operation: "invoke";
}
/** Ordered rules: every selector in a rule must match; absence of a match asks. */
export function evaluateInvocation(rules: InvocationRule[], context: InvocationContext) {
  for (const rule of rules) {
    const m = rule.match;
    if (m.channelKinds && !m.channelKinds.includes(context.channelKind)) continue;
    if (m.entryIds && !m.entryIds.includes(context.entryId)) continue;
    if (m.visitorIds && !m.visitorIds.includes(context.visitorId)) continue;
    if (m.subjects && !m.subjects.includes(context.subject)) continue;
    if (m.domains && (!context.domain || !m.domains.includes(context.domain))) continue;
    if (m.agentIds && !m.agentIds.includes(context.agentId)) continue;
    if (m.operations && !m.operations.includes(context.operation)) continue;
    return { decision: rule.decision, ruleId: rule.id };
  }
  return { decision: "ask" as const, ruleId: "default" };
}
