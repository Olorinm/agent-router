import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { UnauthenticatedUser, type User } from "@a2a-js/sdk/server";
import type { UserBuilder } from "@a2a-js/sdk/server/express";
import { hashCredential } from "./crypto.js";
import { oneOrUndefined } from "./db.js";
import {
  FederationAuthError,
  federationPrincipalId,
  parseFederationPrincipalId,
  type FederationIdentity,
  type FederationService,
} from "./federation.js";
import { upsertPrincipal } from "./registry.js";
import type { RouterConfig } from "./config.js";

export class RouterUser implements User {
  readonly isAuthenticated = true;

  constructor(
    readonly userName: string,
    readonly displayName: string,
    readonly kind: "human" | "agent" | "federation",
    readonly roles: readonly string[],
    readonly email?: string,
    readonly address?: string,
    readonly federationIdentity?: FederationIdentity,
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
  agent_address: string | null;
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
    private readonly adminAuth: RouterConfig["adminAuth"],
    private readonly cacheTtlMs: number,
    private readonly federation: FederationService,
  ) {}

  async authenticate(request: Request): Promise<RouterUser | undefined> {
    const token = bearerToken(request);
    if (!token) return undefined;
    const cacheKey = createHash("sha256").update(token).digest("base64url");
    if (token.startsWith("ar_")) {
      // Machine credentials are checked on every request so revocation and
      // expiration take effect immediately rather than after the auth cache TTL.
      return this.authenticateMachineCredential(token);
    }

    // Federation JWTs are deliberately never cached: every use must claim a
    // fresh jti so replay protection remains effective.
    const federated = await this.authenticateFederationToken(token);
    if (federated) return federated;
    const cached = this.cached(cacheKey);
    if (cached) return cached;
    const user = await this.authenticateAdminToken(token);
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
    } catch (error) {
      respondAuthenticationError(response, error);
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
    } catch (error) {
      respondAuthenticationError(response, error);
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
              , a.address AS agent_address
         FROM credentials c
         JOIN principals p ON p.id = c.principal_id
         LEFT JOIN agents a ON c.principal_id = 'agent:' || a.id::text
        WHERE c.token_hash = $1
          AND c.status = 'active'
          AND (c.expires_at IS NULL OR c.expires_at > now())`,
      [hashCredential(token)],
    );
    if (!row || row.kind !== "agent" || row.agent_status !== "active") return undefined;
    await this.pool.query("UPDATE credentials SET last_used_at = now() WHERE token_hash = $1", [hashCredential(token)]);
    return new RouterUser(row.principal_id, row.display_name, "agent", [], undefined, row.agent_address ?? undefined);
  }

  private async authenticateFederationToken(token: string): Promise<RouterUser | undefined> {
    const identity = await this.federation.tryAuthenticate(token);
    if (!identity) return undefined;
    const principalId = federationPrincipalId(identity);
    await upsertPrincipal(this.pool, {
      id: principalId,
      kind: "federation",
      displayName: identity.subject,
    });
    return new RouterUser(principalId, identity.subject, "federation", [], undefined, identity.subject, identity);
  }

  private async authenticateAdminToken(token: string): Promise<RouterUser | undefined> {
    if (this.adminAuth.mode === "static") {
      if (!equalSecret(token, this.adminAuth.token)) return undefined;
      const principalId = `human:static:${this.adminAuth.subject}`;
      await upsertPrincipal(this.pool, {
        id: principalId,
        kind: "human",
        displayName: this.adminAuth.displayName,
      });
      return new RouterUser(principalId, this.adminAuth.displayName, "human", ["admin"]);
    }

    const response = await fetch(this.adminAuth.userInfoUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return undefined;
    if (!response.ok) throw new Error(`identity_userinfo_http_${response.status}`);
    const body = await response.json();
    const object = asRecord(asRecord(body).data ?? body);
    const subject = stringValue(object.sub);
    const email = stringValue(object.email);
    const displayName = stringValue(object.name) || stringValue(object.preferred_username) || email || subject;
    const role = stringValue(object.role);
    const roles = [
      ...new Set([
        ...(role ? [role] : []),
        ...(Array.isArray(object.roles) ? object.roles.map(stringValue).filter(Boolean) : []),
      ]),
    ].sort();
    if (!subject) throw new Error("identity_userinfo_response_invalid");
    const issuerScope = createHash("sha256").update(this.adminAuth.userInfoUrl).digest("base64url").slice(0, 16);
    const principalId = `human:${issuerScope}:${Buffer.from(subject).toString("base64url")}`;
    await upsertPrincipal(this.pool, {
      id: principalId,
      kind: "human",
      displayName,
      ...(email ? { email } : {}),
    });
    const authorizedRoles = roles.includes(this.adminAuth.requiredRole) ? roles : [];
    return new RouterUser(principalId, displayName, "human", authorizedRoles, email || undefined);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= now) this.cache.delete(key);
    }
  }

  private cached(key: string): RouterUser | undefined {
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return cached.user;
  }
}

export function authenticatedUser(request: Request): RouterUser | undefined {
  return usersByRequest.get(request);
}

export function routerUserForPrincipalId(principalId: string): RouterUser {
  const federation = parseFederationPrincipalId(principalId);
  if (federation) {
    const identity: FederationIdentity = {
      ...federation,
      expiresAt: Number.MAX_SAFE_INTEGER,
      jti: "stored-task-context",
    };
    return new RouterUser(principalId, federation.subject, "federation", [], undefined, federation.subject, identity);
  }
  return new RouterUser(principalId, principalId, "agent", []);
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

function equalSecret(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function respondAuthenticationError(response: Response, error: unknown): void {
  if (error instanceof FederationAuthError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  response.status(503).json({ error: "authentication_unavailable" });
}
