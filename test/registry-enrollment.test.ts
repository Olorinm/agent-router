import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentRegistry } from "../src/registry.js";

describe("one-time agent enrollment", () => {
  it("atomically consumes a scoped token before inserting the agent", async () => {
    let enrollmentStatus = "active";
    let agentInserts = 0;
    const card = sourceCard();
    const client = {
      query: async (text: string) => {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result();
        if (text.includes("FROM enrollment_tokens") && text.includes("FOR UPDATE")) {
          return result([{
            id: "00000000-0000-4000-8000-000000000010",
            token_prefix: "are_example",
            label: "test",
            address: "echo@example.com",
            endpoint_origin: "http://127.0.0.1:9000",
            status: enrollmentStatus,
            created_by_principal_id: "human:test",
            expires_at: new Date(Date.now() + 60_000),
            created_at: new Date(),
            consumed_at: null,
            revoked_at: null,
          }]);
        }
        if (text.includes("UPDATE enrollment_tokens")) {
          enrollmentStatus = "consumed";
          return result([{}]);
        }
        if (text.includes("INSERT INTO agents")) {
          agentInserts += 1;
          return result([{
            id: "00000000-0000-4000-8000-000000000011",
            address: "echo@example.com",
            display_name: "Echo",
            description: "Echo test agent",
            source_agent_card: card,
            endpoint_auth_ciphertext: null,
            target_kind: "local",
            origin_domain: null,
            remote_card_expires_at: null,
            status: "active",
            owner_principal_id: "human:test",
            updated_at: new Date(),
          }]);
        }
        return result([{}]);
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const registry = new AgentRegistry(pool, config());
    const body = {
      address: "echo",
      displayName: "Echo",
      description: "Echo test agent",
      agentCard: card,
    };

    const first = await registry.registerWithEnrollment(body, "are_valid_test_token");
    expect(first.agent.address).toBe("echo@example.com");
    expect(first.machineCredential).toMatch(/^ar_/);
    await expect(registry.registerWithEnrollment(body, "are_valid_test_token")).rejects.toThrow(
      "enrollment_token_invalid",
    );
    expect(agentInserts).toBe(1);
  });
});

function result(rows: unknown[] = []) {
  return { rows, rowCount: rows.length };
}

function config() {
  return loadConfig({
    PUBLIC_BASE_URL: "https://router.example.com",
    ADMIN_AUTH_MODE: "static",
    STATIC_ADMIN_TOKEN: "static-admin-token-with-at-least-32-bytes",
    AGENT_ADDRESS_DOMAIN: "example.com",
    DATABASE_URL: "postgres://unused",
    RABBITMQ_URL: "amqp://unused",
    MASTER_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString("base64"),
    ALLOW_HTTP_AGENT_ENDPOINTS: "true",
    ALLOW_PRIVATE_AGENT_ENDPOINTS: "true",
  });
}

function sourceCard() {
  return {
    name: "Echo",
    description: "Echo test agent",
    supportedInterfaces: [{
      url: "http://127.0.0.1:9000/a2a/jsonrpc",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    }],
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  };
}
