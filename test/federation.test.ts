import {
  AgentCard,
  A2A_PROTOCOL_VERSION,
  Task,
  TaskState,
  type AgentCard as AgentCardType,
} from "@a2a-js/sdk";
import { exportPKCS8, generateKeyPair } from "jose";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { loadConfig, type RouterConfig } from "../src/config.js";
import {
  FEDERATION_JWKS_PATH,
  FEDERATION_WELL_KNOWN_PATH,
  FederationService,
  type FederationHttpClient,
} from "../src/federation.js";

describe("federation trust profile", () => {
  it("discovers domains, authenticates short-lived JWTs, blocks replay, and protects private cards", async () => {
    const poolA = fakeFederationPool(["b.example"]);
    const poolB = fakeFederationPool(["a.example"]);
    let routerA: FederationService;
    let routerB: FederationService;
    const officialClientSubjects: string[] = [];
    const http: FederationHttpClient = {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.href === `https://a.example${FEDERATION_WELL_KNOWN_PATH}`) return json(routerA.discoveryDocument());
        if (url.href === `https://b.example${FEDERATION_WELL_KNOWN_PATH}`) return json(routerB.discoveryDocument());
        if (url.href === `http://127.0.0.1:4101${FEDERATION_JWKS_PATH}`) return json(routerA.jwks());
        if (url.href === `http://127.0.0.1:4102${FEDERATION_JWKS_PATH}`) return json(routerB.jwks());
        if (url.href === "http://127.0.0.1:4101/a2a/agents/worker/card") {
          const authorization = new Headers(init?.headers).get("authorization");
          expect(authorization).toMatch(/^Bearer /);
          const identity = await routerA.tryAuthenticate(authorization!.slice("Bearer ".length));
          expect(identity?.subject).toBe("router@b.example");
          return json(AgentCard.toJSON(remoteCard("http://127.0.0.1:4101")));
        }
        if (url.pathname.endsWith("/a2a/rest/tasks/remote-task")) {
          const authorization = new Headers(init?.headers).get("authorization");
          expect(authorization).toMatch(/^Bearer /);
          const identity = await routerA.tryAuthenticate(authorization!.slice("Bearer ".length));
          officialClientSubjects.push(identity!.subject);
          return json(Task.toJSON({
            id: "remote-task",
            contextId: "remote-context",
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              timestamp: new Date().toISOString(),
              message: undefined,
            },
            artifacts: [],
            history: [],
            metadata: {},
          }));
        }
        return new Response("not found", { status: 404 });
      },
      close: async () => undefined,
    };
    routerA = await FederationService.create(poolA, federationConfig("a.example", "http://127.0.0.1:4101"), {
      http,
      privateKeyPem: await privateKeyPem(),
    });
    routerB = await FederationService.create(poolB, federationConfig("b.example", "http://127.0.0.1:4102"), {
      http,
      privateKeyPem: await privateKeyPem(),
    });

    const token = await routerA.mintToken("alice@a.example", "http://127.0.0.1:4102");
    const identity = await routerB.tryAuthenticate(token);
    expect(identity).toMatchObject({ domain: "a.example", subject: "alice@a.example" });
    await expect(routerB.tryAuthenticate(token)).rejects.toThrow("federation_token_replayed");

    const wrongAudience = await routerA.mintToken("alice@a.example", "http://127.0.0.1:4999");
    await expect(routerB.tryAuthenticate(wrongAudience)).rejects.toThrow("federation_token_invalid");

    const fetched = await routerB.fetchAgentCard("worker@a.example");
    expect(fetched.domain).toBe("a.example");
    expect(fetched.card.name).toBe("Remote Worker");
    const officialClient = await routerB.clientFor(fetched.card, "a.example", "bob@b.example");
    await officialClient.getTask({ id: "remote-task", historyLength: 0, tenant: "" });
    await officialClient.getTask({ id: "remote-task", historyLength: 0, tenant: "" });
    expect(officialClientSubjects).toEqual(["bob@b.example", "bob@b.example"]);

    await expect(
      routerB.assertCallbackUrl(identity!, "http://127.0.0.1:4101/federation/v1/push/router-task"),
    ).resolves.toBeUndefined();
    await expect(
      routerB.assertCallbackUrl(identity!, "http://127.0.0.1:4999/federation/v1/push/router-task"),
    ).rejects.toThrow("federation_callback_origin_mismatch");
    await expect(
      routerB.assertCallbackUrl(identity!, "http://127.0.0.1:4101/federation/v1/push/router-task/extra"),
    ).rejects.toThrow("federation_callback_path_invalid");

    await Promise.all([routerA.close(), routerB.close()]);
  });

  it("denies an unlisted domain before downloading its keys", async () => {
    let fetchCount = 0;
    const service = await FederationService.create(
      fakeFederationPool([]),
      federationConfig("b.example", "http://127.0.0.1:4102"),
      {
        privateKeyPem: await privateKeyPem(),
        http: { fetch: async () => { fetchCount += 1; return new Response(); }, close: async () => undefined },
      },
    );
    const signer = await FederationService.create(
      fakeFederationPool([]),
      federationConfig("a.example", "http://127.0.0.1:4101"),
      { privateKeyPem: await privateKeyPem(), http: { fetch: async () => new Response(), close: async () => undefined } },
    );
    const token = await signer.mintToken("alice@a.example", "http://127.0.0.1:4102");
    await expect(service.tryAuthenticate(token)).rejects.toThrow("federation_domain_denied");
    expect(fetchCount).toBe(0);
  });
});

function federationConfig(domain: string, baseUrl: string): RouterConfig {
  return loadConfig({
    PUBLIC_BASE_URL: baseUrl,
    WW_BASE_URL: "https://ww.example",
    AGENT_ADDRESS_DOMAIN: domain,
    DATABASE_URL: "postgres://unused",
    RABBITMQ_URL: "amqp://unused",
    MASTER_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString("base64"),
    ALLOW_HTTP_AGENT_ENDPOINTS: "true",
    ALLOW_PRIVATE_AGENT_ENDPOINTS: "true",
    FEDERATION_ENABLED: "true",
  });
}

async function privateKeyPem(): Promise<string> {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  return exportPKCS8(privateKey);
}

function fakeFederationPool(allowedDomains: string[]): Pool {
  const allowed = new Set(allowedDomains);
  const seenJti = new Set<string>();
  return {
    async query(text: string, values: unknown[] = []) {
      if (text.includes("SELECT EXISTS") && text.includes("federation_domains")) {
        return { rows: [{ allowed: allowed.has(String(values[0])) }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO federation_jti")) {
        const key = `${values[0]}:${values[1]}`;
        if (seenJti.has(key)) return { rows: [], rowCount: 0 };
        seenJti.add(key);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("DELETE FROM federation_jti")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected_query:${text}`);
    },
  } as unknown as Pool;
}

function remoteCard(baseUrl: string): AgentCardType {
  return AgentCard.fromJSON({
    name: "Remote Worker",
    description: "Federated test worker",
    supportedInterfaces: [
      {
        url: `${baseUrl}/agents/worker%40a.example/a2a/rest`,
        protocolBinding: "HTTP+JSON",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: "a.example", url: baseUrl },
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
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
