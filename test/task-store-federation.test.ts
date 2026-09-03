import { ServerCallContext } from "@a2a-js/sdk/server";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { RouterUser } from "../src/auth.js";
import { federationPrincipalId, type FederationIdentity } from "../src/federation.js";
import { PostgresTaskStore } from "../src/task-store.js";

describe("federated message idempotency", () => {
  it("scopes a messageId to the issuer domain and destination agent", async () => {
    const parameters: unknown[][] = [];
    const pool = {
      query: async (_text: string, values: unknown[]) => {
        parameters.push(values);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const store = new PostgresTaskStore(pool);

    await store.findByMessage("agent-one", "same-message", federationContext("alice@a.example"));
    await store.findByMessage("agent-one", "same-message", federationContext("bob@a.example"));
    await store.findByMessage("agent-two", "same-message", federationContext("alice@a.example"));
    await store.findByMessage("agent-one", "same-message", federationContext("alice@b.example"));

    expect(parameters[0]?.[0]).toBe(parameters[1]?.[0]);
    expect(parameters[0]?.[0]).not.toBe(parameters[2]?.[0]);
    expect(parameters[0]?.[0]).not.toBe(parameters[3]?.[0]);
    expect(parameters.every((entry) => entry[1] === "same-message")).toBe(true);
  });
});

function federationContext(subject: string): ServerCallContext {
  const domain = subject.slice(subject.lastIndexOf("@") + 1);
  const identity: FederationIdentity = {
    issuer: `https://${domain}`,
    domain,
    subject,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID(),
  };
  return new ServerCallContext({
    user: new RouterUser(
      federationPrincipalId(identity),
      subject,
      "federation",
      [],
      undefined,
      subject,
      identity,
    ),
    requestedVersion: "1.0",
  });
}
