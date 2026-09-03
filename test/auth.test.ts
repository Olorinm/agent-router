import type { Request } from "express";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { FederationService } from "../src/federation.js";

describe("administrator authentication", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("supports a provider-neutral static administrator token", async () => {
    const config = testConfig({
      ADMIN_AUTH_MODE: "static",
      STATIC_ADMIN_TOKEN: "static-admin-token-with-at-least-32-bytes",
      STATIC_ADMIN_SUBJECT: "operator-one",
      STATIC_ADMIN_DISPLAY_NAME: "Operator One",
    });
    const auth = new AuthService(fakePool(), config.adminAuth, config.authCacheTtlMs, noFederation());

    await expect(auth.authenticate(requestWithToken("wrong-token"))).resolves.toBeUndefined();
    await expect(auth.authenticate(requestWithToken("static-admin-token-with-at-least-32-bytes"))).resolves.toMatchObject({
      userName: "human:static:operator-one",
      displayName: "Operator One",
      kind: "human",
      isAdmin: true,
    });
  });

  it("accepts a standard UserInfo subject and configured administrator role", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sub: "operator-123",
      name: "Example Operator",
      email: "operator@example.com",
      roles: ["admin"],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const config = testConfig({
      ADMIN_AUTH_MODE: "userinfo",
      IDENTITY_USERINFO_URL: "https://identity.example.com/oauth2/userinfo",
      IDENTITY_ADMIN_ROLE: "admin",
    });
    const auth = new AuthService(fakePool(), config.adminAuth, config.authCacheTtlMs, noFederation());

    const user = await auth.authenticate(requestWithToken("identity-access-token"));
    expect(user).toMatchObject({
      displayName: "Example Operator",
      kind: "human",
      email: "operator@example.com",
      isAdmin: true,
    });
    expect(user?.userName).toMatch(/^human:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://identity.example.com/oauth2/userinfo",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer identity-access-token" }) }),
    );
  });

  it("requires the mode-specific credential source", () => {
    expect(() => testConfig({ ADMIN_AUTH_MODE: "userinfo" })).toThrow();
    expect(() => testConfig({ ADMIN_AUTH_MODE: "static" })).toThrow();
  });

  it("checks machine-credential revocation and expiration on every request", async () => {
    const config = testConfig({
      ADMIN_AUTH_MODE: "static",
      STATIC_ADMIN_TOKEN: "static-admin-token-with-at-least-32-bytes",
    });
    let selects = 0;
    const pool = {
      query: async (text: string) => {
        if (text.includes("FROM credentials")) {
          selects += 1;
          expect(text).toContain("c.expires_at > now()");
          return {
            rows: [{
              principal_id: "agent:1",
              display_name: "Agent",
              kind: "agent",
              agent_status: "active",
              agent_address: "agent@example.com",
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;
    const auth = new AuthService(pool, config.adminAuth, config.authCacheTtlMs, noFederation());
    await auth.authenticate(requestWithToken("ar_machine_token"));
    await auth.authenticate(requestWithToken("ar_machine_token"));
    expect(selects).toBe(2);
  });
});

function testConfig(overrides: Record<string, string>) {
  return loadConfig({
    PUBLIC_BASE_URL: "https://router.example.com",
    AGENT_ADDRESS_DOMAIN: "example.com",
    DATABASE_URL: "postgres://unused",
    RABBITMQ_URL: "amqp://unused",
    MASTER_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString("base64"),
    ...overrides,
  });
}

function fakePool(): Pool {
  return { query: async () => ({ rows: [], rowCount: 1 }) } as unknown as Pool;
}

function noFederation(): FederationService {
  return { tryAuthenticate: async () => undefined } as unknown as FederationService;
}

function requestWithToken(token: string): Request {
  return {
    header: (name: string) => name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined,
  } as unknown as Request;
}
