import type { IncomingHttpHeaders } from "node:http";
import { readFileSync } from "node:fs";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { digest } from "../execution/protocol.js";
import { WorkError } from "../execution/work.js";
import { personId, type PersonRegistry } from "../ledger/registry.js";

/** The authenticated owner of a request (ADR 0005 section 18.2). */
export interface OwnerPrincipal {
  personId: string; ownerId: string;
  via: "edge" | "edge-service" | "bearer";
  email?: string; matrixUserId?: string;
  /** Epoch milliseconds; set for edge principals (the JWT `exp`). */
  expiresAt?: number;
}
export interface OwnerRequest { headers: IncomingHttpHeaders }
export interface OwnerAuthenticator { authenticate(request: OwnerRequest): Promise<OwnerPrincipal> }

/** A WorkError whose extra fields are part of the JSON error body (for example `email`). */
export class IdentityError extends WorkError {
  constructor(message: string, status: number, readonly details: Record<string, unknown> = {}) { super(message, status); }
}

const origin = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !value.endsWith("/");
}, "https_origin_without_path_required");
const email = z.string().min(3).max(320).refine((value) => value.includes("@") && value === value.normalize("NFC").toLowerCase(), "lowercased_email_required");
const ownerId = z.string().max(255).regex(/^@[a-z0-9._=\-/+]+:[a-zA-Z0-9.-]+(?::[0-9]+)?$/).refine((value) => !value.startsWith("@_ar_"), "agent_owner_forbidden");
export const edgeIdentityConfigSchema = z.object({
  provider: z.literal("cloudflare-access"),
  teamDomain: origin,
  audiences: z.array(z.string().min(1).max(256)).min(1).max(10),
  clockSkewSeconds: z.number().int().min(0).max(300).default(60),
  bearer: z.enum(["allow", "deny"]).default("allow"),
  owners: z.record(email, z.union([ownerId, z.object({ owner: ownerId, sub: z.string().min(1).max(256) }).strict()])).default({}),
  serviceTokens: z.record(z.string().min(1).max(256), ownerId).default({}),
}).strict();
export type EdgeIdentityConfig = z.input<typeof edgeIdentityConfigSchema>;
type ParsedConfig = z.output<typeof edgeIdentityConfigSchema>;

/** Reads the operator file (`{ "edgeIdentity": { … } }`). A bad file fails the start. */
export function loadEdgeIdentityConfig(path: string): ParsedConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { edgeIdentity?: unknown };
  return edgeIdentityConfigSchema.parse(raw.edgeIdentity);
}
/** Start-time check that every configured owner id belongs to this server. */
export function assertEdgeOwners(config: EdgeIdentityConfig, serverName: string) {
  const owners = [...Object.values(config.owners ?? {}).map((value) => typeof value === "string" ? value : value.owner), ...Object.values(config.serviceTokens ?? {})];
  for (const owner of owners) if (!owner.endsWith(`:${serverName}`)) throw new Error("edge_identity_owner_not_local");
}

export const EDGE_HEADER = "cf-access-jwt-assertion";
const MAX_ASSERTION = 8 * 1024;
const unavailable = (error: unknown) => !(error instanceof errors.JOSEError) || error instanceof errors.JWKSTimeout ||
  error instanceof errors.JWKSInvalid || error.code === "ERR_JOSE_GENERIC";

/**
 * Verifies the Cloudflare Access application JWT (`Cf-Access-Jwt-Assertion`) and maps it to a configured owner.
 * Only the signed assertion counts: the plain email header and the `CF_Authorization` cookie are never read.
 */
export class CloudflareAccessAuthenticator implements OwnerAuthenticator {
  readonly config: ParsedConfig;
  readonly namespace: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly cache = new Map<string, { principal: OwnerPrincipal; until: number }>();
  constructor(config: EdgeIdentityConfig, private readonly options: { persons?: PersonRegistry; now?: () => number;
    /** Test override for `<teamDomain>/cdn-cgi/access/certs`. */
    certsUrl?: URL } = {}) {
    this.config = edgeIdentityConfigSchema.parse(config);
    this.namespace = new URL(this.config.teamDomain).host;
    this.jwks = createRemoteJWKSet(options.certsUrl ?? new URL("/cdn-cgi/access/certs", this.config.teamDomain),
      { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 3_600_000 });
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  /** The request's assertion, or undefined when there is none. Duplicate or oversized headers are invalid. */
  static assertion(request: OwnerRequest): string | undefined {
    const value = request.headers[EDGE_HEADER];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || value.length > MAX_ASSERTION) throw new WorkError("edge_identity_invalid", 401);
    return value;
  }
  async authenticate(request: OwnerRequest): Promise<OwnerPrincipal> {
    const token = CloudflareAccessAuthenticator.assertion(request);
    if (!token) throw new WorkError("edge_identity_invalid", 401);
    return this.verify(token);
  }
  async verify(token: string): Promise<OwnerPrincipal> {
    const hash = digest(["edge-assertion", token]), now = this.now(), cached = this.cache.get(hash);
    if (cached && cached.until > now) return cached.principal;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, { algorithms: ["RS256"], issuer: this.config.teamDomain, audience: this.config.audiences,
        clockTolerance: this.config.clockSkewSeconds, requiredClaims: ["exp", "iat"], currentDate: new Date(now) }));
    } catch (error) {
      if (unavailable(error)) throw new WorkError("identity_provider_unavailable", 503);
      throw new WorkError("edge_identity_invalid", 401);
    }
    if (payload.type !== undefined && payload.type !== "app") throw new WorkError("edge_identity_invalid", 401);
    const principal = this.map(payload);
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(hash, { principal, until: Math.min(principal.expiresAt!, now + 60_000) });
    this.remember(principal, payload);
    return principal;
  }
  private map(payload: JWTPayload): OwnerPrincipal {
    const expiresAt = payload.exp! * 1000;
    if (typeof payload.email === "string" && payload.email) {
      const address = payload.email.normalize("NFC").toLowerCase();
      const entry = Object.hasOwn(this.config.owners, address) ? this.config.owners[address] : undefined;
      if (!entry) throw new IdentityError("owner_not_configured", 403, { email: address });
      const owner = typeof entry === "string" ? entry : entry.owner;
      if (typeof entry !== "string" && entry.sub !== payload.sub) throw new IdentityError("owner_subject_mismatch", 403, { email: address });
      return { personId: personId(owner), ownerId: owner, via: "edge", email: address, expiresAt };
    }
    if (typeof payload.common_name === "string" && payload.common_name) {
      const id = payload.common_name, owner = Object.hasOwn(this.config.serviceTokens, id) ? this.config.serviceTokens[id] : undefined;
      if (!owner) throw new WorkError("service_token_not_configured", 403);
      return { personId: personId(owner), ownerId: owner, via: "edge-service", expiresAt };
    }
    throw new WorkError("edge_identity_invalid", 401);
  }
  /** First sight per cache entry: the person exists and the login identity is linked (ADR 0005 18.2 step 5). */
  private remember(principal: OwnerPrincipal, payload: JWTPayload) {
    const persons = this.options.persons;
    if (!persons) return;
    if (principal.email) {
      const person = persons.ensurePerson(principal.ownerId, principal.email.split("@")[0]!);
      persons.link(person, "cloudflare-access", this.namespace, principal.email, "login");
    } else {
      const person = persons.ensurePerson(principal.ownerId, principal.ownerId.slice(1).split(":")[0]!);
      persons.link(person, "cloudflare-access", this.namespace, `service:${String(payload.common_name)}`, "config");
    }
  }
}

const bearerOf = (request: OwnerRequest) => {
  const value = request.headers.authorization;
  return (typeof value === "string" ? value.match(/^Bearer ([^\s]+)$/i)?.[1] : undefined) ?? "";
};
/**
 * Order of checks (ADR 0005 18.2): with an edge config and an assertion present, the edge result decides and a bad JWT
 * never falls back to the bearer path. Otherwise the bearer path applies unless `bearer:"deny"`.
 */
export class CompositeAuthenticator implements OwnerAuthenticator {
  constructor(private readonly bearer: (token: string) => Promise<OwnerPrincipal>, private readonly edge?: CloudflareAccessAuthenticator) {}
  async authenticate(request: OwnerRequest): Promise<OwnerPrincipal> {
    const token = bearerOf(request);
    if (this.edge) {
      const assertion = CloudflareAccessAuthenticator.assertion(request);
      const deny = this.edge.config.bearer === "deny";
      if (assertion) {
        const principal = await this.edge.verify(assertion);
        if (token && !deny) {
          const other = await this.bearer(token).catch(() => undefined);
          if (other?.ownerId !== principal.ownerId) throw new WorkError("principal_conflict", 401);
        }
        return principal;
      }
      if (deny) throw new WorkError("edge_identity_required", 401);
    }
    if (!token) throw new WorkError("account_login_required", 401);
    return this.bearer(token);
  }
}
