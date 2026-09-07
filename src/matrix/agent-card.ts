import { AgentCard } from "@a2a-js/sdk";
import type { RequestHandler } from "express";

/** Serialize SDK models as A2A wire JSON, never as JavaScript oneof internals. */
export function agentCardRoute(provider: { getAgentCard(): Promise<AgentCard> }): RequestHandler {
  return async (_req, res) => {
    res.set("Cache-Control", "no-cache").json(AgentCard.toJSON(await provider.getAgentCard()));
  };
}
