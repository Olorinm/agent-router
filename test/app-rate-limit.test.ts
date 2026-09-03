import type { AddressInfo } from "node:net";
import type { RequestHandler } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const servers: Array<ReturnType<ReturnType<typeof createApp>["listen"]>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("HTTP rate limiting", () => {
  it("limits authentication attempts before protected A2A handlers", async () => {
    const baseUrl = await listen(testApp(1));

    const first = await fetch(`${baseUrl}/agents/example@example.com/a2a/jsonrpc`, { method: "POST" });
    expect(first.status).toBe(401);
    expect(first.headers.get("ratelimit")).toBeTruthy();

    const second = await fetch(`${baseUrl}/agents/example@example.com/a2a/jsonrpc`, { method: "POST" });
    expect(second.status).toBe(429);
  });

  it("rate limits the readiness check that queries infrastructure", async () => {
    const baseUrl = await listen(testApp(10));

    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    expect(response.headers.get("ratelimit")).toBeTruthy();
  });
});

function testApp(federationRequestsPerMinute: number) {
  const unauthorized: RequestHandler = (_request, response) => {
    response.status(401).json({ error: "unauthorized" });
  };
  return createApp({
    pool: { query: async () => ({ rows: [], rowCount: 1 }) },
    registry: {},
    auth: {
      requireCaller: unauthorized,
      requireAdmin: unauthorized,
      currentUser: () => { throw new Error("authenticated_user_missing"); },
    },
    proxyHandlers: {},
    dispatcher: { isReady: () => true },
    publicBaseUrl: "https://router.example.com",
    trustProxy: 0,
    federationRequestsPerMinute,
    federation: { enabled: false },
    federationCallbacks: {},
  } as unknown as Parameters<typeof createApp>[0]);
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
