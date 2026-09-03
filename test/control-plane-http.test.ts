import type { AddressInfo } from "node:net";
import type { RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const servers: Array<ReturnType<ReturnType<typeof createApp>["listen"]>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("CLI control-plane HTTP surface", () => {
  it("publishes Router discovery even when federation is disabled", async () => {
    const baseUrl = await listen(appWith());
    const response = await fetch(`${baseUrl}/.well-known/agent-router`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      baseUrl: "https://router.example.com",
      serviceVersion: "1.0",
    });
  });

  it("accepts a one-time enrollment token without treating it as a caller credential", async () => {
    const registerWithEnrollment = vi.fn(async () => ({
      agent: localAgent(),
      machineCredential: "ar_machine_credential",
    }));
    const baseUrl = await listen(appWith({ registry: { registerWithEnrollment } }));
    const response = await fetch(`${baseUrl}/v1/enrollments/register`, {
      method: "POST",
      headers: { Authorization: "Bearer are_one_time", "Content-Type": "application/json" },
      body: JSON.stringify({ address: "echo" }),
    });
    expect(response.status).toBe(201);
    expect(registerWithEnrollment).toHaveBeenCalledWith({ address: "echo" }, "are_one_time");
    await expect(response.json()).resolves.toMatchObject({
      data: { address: "echo@example.com", machineCredential: "ar_machine_credential" },
    });
  });

  it("does not expose the directory listing to federated callers", async () => {
    const baseUrl = await listen(appWith({ federationCaller: true }));
    const response = await fetch(`${baseUrl}/v1/directory`, { headers: { Authorization: "Bearer test" } });
    expect(response.status).toBe(404);
  });
});

function appWith(options: { registry?: Record<string, unknown>; federationCaller?: boolean } = {}) {
  const pass: RequestHandler = (_request, _response, next) => next();
  return createApp({
    pool: { query: async () => ({ rows: [], rowCount: 1 }) },
    registry: {
      list: async () => [],
      getByAddress: async () => undefined,
      ...options.registry,
    },
    auth: {
      requireCaller: pass,
      requireAdmin: pass,
      currentUser: () => ({
        userName: "agent:test",
        displayName: "Test",
        kind: options.federationCaller ? "federation" : "agent",
        roles: [],
        address: "test@example.com",
        federationIdentity: options.federationCaller ? { domain: "remote.example" } : undefined,
        isAdmin: false,
      }),
    },
    proxyHandlers: {},
    dispatcher: { isReady: () => true },
    publicBaseUrl: "https://router.example.com",
    trustProxy: 0,
    federationRequestsPerMinute: 100,
    federation: { enabled: false },
    federationCallbacks: {},
  } as unknown as Parameters<typeof createApp>[0]);
}

function localAgent() {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    address: "echo@example.com",
    displayName: "Echo",
    description: "Echo agent",
    sourceAgentCard: {
      name: "Echo",
      description: "Echo agent",
      supportedInterfaces: [{ url: "https://agent.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      provider: undefined,
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      documentationUrl: "",
      signatures: [],
      iconUrl: "",
    },
    targetKind: "local",
    status: "active",
    ownerPrincipalId: "human:test",
    updatedAt: new Date(0).toISOString(),
  };
}

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
