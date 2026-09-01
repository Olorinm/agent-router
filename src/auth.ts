import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { UnauthenticatedUser, type User } from "@a2a-js/sdk/server";
import type { UserBuilder } from "@a2a-js/sdk/server/express";
import { hashCredential } from "./crypto.js";
import { oneOrUndefined } from "./db.js";
import { upsertPrincipal } from "./registry.js";

export class RouterUser implements User {
  readonly isAuthenticated = true;

  constructor(
    readonly userName: string,
    readonly displayName: string,
    readonly kind: "human" | "agent",
    readonly roles: readonly string[],
    readonly email?: string,
  ) {}

  get isAdmin(): boolean {
    return this.roles.includes("admin");
  }
}

interface CredentialRow {
  principal_id: string;
  display_name: string;
  kind: "agent";
  agent_status: "active" | "disabled" | null;
}

interface CachedUser {
  expiresAt: number;
  user: RouterUser;
}

const usersByRequest = new WeakMap<Request, RouterUser>();

export class AuthService {
  private readonly cache = new Map<string, CachedUser>();

  constructor(
    private readonly pool: Pool,
    private readonly wwBaseUrl: string,
    private readonly cacheTtlMs: number,
  ) {}

  async authenticate(request: Request): Promise<RouterUser | undefined> {
    const token = bearerToken(request);
    if (!token) return undefined;
    const cacheKey = createHash("sha256").update(token).digest("base64url");
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    const user = token.startsWith("ogr_")
      ? await this.authenticateMachineCredential(token)
      : await this.authenticateWwToken(token);
    if (user) this.cache.set(cacheKey, { user, expiresAt: Date.now() + this.cacheTtlMs });
    if (this.cache.size > 1000) this.evictExpired();
    return user;
  }

  readonly requireCaller: RequestHandler = async (request, response, next) => {
    try {
      const user = await this.authenticate(request);
      if (!user) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      if (user.kind === "human" && !user.isAdmin) {
        response.status(403).json({ error: "admin_required" });
        return;
      }
      usersByRequest.set(request, user);
      next();
    } catch {
      response.status(503).json({ error: "authentication_unavailable" });
    }
  };

  readonly requireAdmin: RequestHandler = async (request, response, next) => {
    try {
      const user = await this.authenticate(request);
      if (!user) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      if (user.kind !== "human" || !user.isAdmin) {
        response.status(403).json({ error: "admin_required" });
        return;
      }
      usersByRequest.set(request, user);
      next();
    } catch {
      response.status(503).json({ error: "authentication_unavailable" });
    }
  };

  readonly userBuilder: UserBuilder = async (request) => usersByRequest.get(request) ?? new UnauthenticatedUser();

  currentUser(request: Request): RouterUser {
    const user = usersByRequest.get(request);
    if (!user) throw new Error("authenticated_user_missing");
    return user;
  }

  private async authenticateMachineCredential(token: string): Promise<RouterUser | undefined> {
    const row = await oneOrUndefined<CredentialRow>(
      this.pool,
      `SELECT c.principal_id, p.display_name, p.kind, a.status AS agent_status
         FROM credentials c
         JOIN principals p ON p.id = c.principal_id
         LEFT JOIN agents a ON c.principal_id = 'agent:' || a.id::text
        WHERE c.token_hash = $1 AND c.status = 'active'`,
      [hashCredential(token)],
    );
    if (!row || row.kind !== "agent" || row.agent_status !== "active") return undefined;
    await this.pool.query("UPDATE credentials SET last_used_at = now() WHERE token_hash = $1", [hashCredential(token)]);
    return new RouterUser(row.principal_id, row.display_name, "agent", []);
  }

  private async authenticateWwToken(token: string): Promise<RouterUser | undefined> {
    const response = await fetch(`${this.wwBaseUrl}/v1/users/me`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return undefined;
    if (!response.ok) throw new Error(`ww_auth_http_${response.status}`);
    const body = await response.json();
    const object = asRecord(asRecord(body).data ?? body);
    const userId = stringValue(object.user_id);
    const email = stringValue(object.email);
    const displayName = stringValue(object.display_name) || email;
    const role = stringValue(object.role) || "user";
    const roles = [
      ...new Set([
        role,
        ...(Array.isArray(object.roles) ? object.roles.map(stringValue).filter(Boolean) : []),
      ]),
    ].sort();
    if (!userId || !email) throw new Error("ww_user_response_invalid");
    const principalId = `ww:${userId}`;
    await upsertPrincipal(this.pool, {
      id: principalId,
      kind: "human",
      displayName,
      email,
    });
    return new RouterUser(principalId, displayName, "human", roles, email);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= now) this.cache.delete(key);
    }
  }
}

export function authenticatedUser(request: Request): RouterUser | undefined {
  return usersByRequest.get(request);
}

function bearerToken(request: Request): string | undefined {
  const value = request.header("authorization");
  if (!value?.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length);
  if (!token || /\s/.test(token)) return undefined;
  return token;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
