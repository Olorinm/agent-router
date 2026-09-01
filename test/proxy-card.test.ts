import { A2A_PROTOCOL_VERSION, AgentCard } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { buildProxyAgentCard } from "../src/proxy-agent.js";
import type { RegisteredAgent } from "../src/registry.js";

describe("proxy agent card", () => {
  it("advertises only router-owned, non-streaming interfaces", () => {
    const sourceAgentCard = AgentCard.fromJSON({
      name: "Worker",
      description: "Test worker",
      supportedInterfaces: [
        { url: "https://worker.example/a2a/rest", protocolBinding: "HTTP+JSON", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION },
      ],
      provider: { organization: "Test", url: "https://example.com" },
      version: "1.0.0",
      capabilities: { streaming: true, pushNotifications: true, extensions: [], extendedAgentCard: false },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      documentationUrl: "",
      signatures: [],
      iconUrl: "",
    });
    const agent: RegisteredAgent = {
      id: "00000000-0000-4000-8000-000000000001",
      address: "worker@agents.welltop.cn",
      displayName: "Worker",
      description: "Test worker",
      sourceAgentCard,
      status: "active",
      ownerPrincipalId: "ww:test",
      updatedAt: new Date(0).toISOString(),
    };
    const card = buildProxyAgentCard(agent, "https://router.example");
    expect(card.supportedInterfaces.map((entry) => entry.url)).toEqual([
      "https://router.example/agents/worker%40agents.welltop.cn/a2a/rest",
      "https://router.example/agents/worker%40agents.welltop.cn/a2a/jsonrpc",
    ]);
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.securityRequirements).toHaveLength(1);
  });
});
