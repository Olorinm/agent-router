import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AgentCard,
  type AgentCard as AgentCardType,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
  type ClientConfig,
} from "@a2a-js/sdk/client";
import {
  SignJWT,
  calculateJwkThumbprint,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  exportJWK,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import type { Pool } from "pg";
import { z } from "zod";
import type { RouterConfig } from "./config.js";
import { assertSafeEndpoint } from "./endpoint-policy.js";
import { FederationPolicyStore, normalizeFederationDomain } from "./federation-policy.js";
import { SafeHttpClient } from "./safe-fetch.js";

export const FEDERATION_VERSION = "1.0";
export const FEDERATION_WELL_KNOWN_PATH = "/.well-known/opengrove-router";
export const FEDERATION_JWKS_PATH = "/federation/v1/jwks.json";
export const FEDERATION_PUSH_PATH_PREFIX = "/federation/v1/push/";
export const FEDERATION_JWT_PROFILE_CLAIM = "opengrove_federation_version";

export interface FederationDiscoveryDocument {
  baseUrl: string;
  federationVersion: typeof FEDERATION_VERSION;
  jwksUrl: string;
}

export interface FederationIdentity {
  issuer: string;
  domain: string;
  subject: string;
  expiresAt: number;
  jti: string;
}

export interface FederationHttpClient {
  fetch: typeof fetch;
  close(): Promise<void>;
}

interface CachedDiscovery {
  expiresAt: number;
  value: FederationDiscoveryDocument;
}

type ClientInterceptor = NonNullable<ClientConfig["interceptors"]>[number];

const discoverySchema = z.object({
  baseUrl: z.string().url(),
  federationVersion: z.literal(FEDERATION_VERSION),
  jwksUrl: z.string().url(),
});

const additionalJwksSchema = z.object({
  keys: z.array(z.looseObject({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().min(1),
    kid: z.string().min(8),
    alg: z.literal("EdDSA").optional(),
    use: z.literal("sig").optional(),
  })),
});

export class FederationAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
  }
}

export class FederationService {
  readonly domain: string;
  readonly issuer: string;
  readonly policy: FederationPolicyStore;
  private readonly baseOrigin: string;
  private readonly privateKey: ReturnType<typeof createPrivateKey> | undefined;
  private readonly publicJwk: JWK | undefined;
  private readonly publishedJwks: readonly JWK[];
  private readonly keyId: string | undefined;
  private readonly discoveryCache = new Map<string, CachedDiscovery>();
  private readonly remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  private replayClaimsSinceCleanup = 0;

  private constructor(
    private readonly pool: Pool,
    private readonly config: RouterConfig,
    private readonly http: FederationHttpClient,
    key?: {
      privateKey: ReturnType<typeof createPrivateKey>;
      publicJwk: JWK;
      publishedJwks: readonly JWK[];
      keyId: string;
    },
  ) {
    this.domain = normalizeFederationDomain(config.agentAddressDomain);
    this.issuer = `https://${this.domain}`;
    this.baseOrigin = new URL(config.publicBaseUrl).origin;
    this.policy = new FederationPolicyStore(pool);
    this.privateKey = key?.privateKey;
    this.publicJwk = key?.publicJwk;
    this.publishedJwks = key?.publishedJwks ?? [];
    this.keyId = key?.keyId;
  }

  static async create(
    pool: Pool,
    config: RouterConfig,
    options: { http?: FederationHttpClient; privateKeyPem?: string } = {},
  ): Promise<FederationService> {
    const http = options.http ?? new SafeHttpClient({
      allowHttp: config.allowHttpAgentEndpoints,
      allowPrivate: config.allowPrivateAgentEndpoints,
    });
    if (!config.federationEnabled) return new FederationService(pool, config, http);

    const pem = options.privateKeyPem ?? await readFile(config.federationPrivateKeyFile, "utf8");
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("federation_private_key_must_be_ed25519");
    const publicJwk = await exportJWK(createPublicKey(privateKey));
    const keyId = await calculateJwkThumbprint(publicJwk, "sha256");
    const active = { ...publicJwk, alg: "EdDSA", kid: keyId, use: "sig" };
    const additional = config.federationAdditionalJwksFile
      ? await loadAdditionalJwks(config.federationAdditionalJwksFile)
      : [];
    const publishedJwks = [active, ...additional.filter((entry) => entry.kid !== keyId)];
    return new FederationService(pool, config, http, { privateKey, publicJwk, publishedJwks, keyId });
  }

  get enabled(): boolean {
    return this.config.federationEnabled;
  }

  discoveryDocument(): FederationDiscoveryDocument {
    this.assertEnabled();
    return {
      baseUrl: this.config.publicBaseUrl,
      federationVersion: FEDERATION_VERSION,
      jwksUrl: `${this.config.publicBaseUrl}${FEDERATION_JWKS_PATH}`,
    };
  }

  jwks(): { keys: JWK[] } {
    this.assertEnabled();
    if (!this.publicJwk || !this.keyId) throw new Error("federation_key_unavailable");
    return { keys: this.publishedJwks.map((entry) => ({ ...entry })) };
  }

  async mintToken(subjectValue: string, audienceValue: string): Promise<string> {
    this.assertEnabled();
    if (!this.privateKey || !this.keyId) throw new Error("federation_key_unavailable");
    const subject = normalizeSubject(subjectValue, this.domain);
    const audience = new URL(audienceValue).origin;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ [FEDERATION_JWT_PROFILE_CLAIM]: FEDERATION_VERSION })
      .setProtectedHeader({ alg: "EdDSA", kid: this.keyId, typ: "JWT" })
      .setIssuer(this.issuer)
      .setSubject(subject)
      .setAudience(audience)
      .setIssuedAt(now)
      .setNotBefore(now - this.config.federationClockToleranceSeconds)
      .setExpirationTime(now + this.config.federationTokenTtlSeconds)
      .setJti(crypto.randomUUID())
      .sign(this.privateKey);
  }

  async tryAuthenticate(token: string): Promise<FederationIdentity | undefined> {
    if (!this.enabled || token.split(".").length !== 3) return undefined;
    let unverified: ReturnType<typeof decodeJwt>;
    try {
      unverified = decodeJwt(token);
    } catch {
      return undefined;
    }
    if (unverified[FEDERATION_JWT_PROFILE_CLAIM] !== FEDERATION_VERSION) return undefined;
    if (typeof unverified.iss !== "string" || !unverified.iss.startsWith("https://")) return undefined;
    let domain: string;
    try {
      domain = domainFromIssuer(unverified.iss);
    } catch {
      return undefined;
    }
    if (!await this.policy.isAllowed(domain)) throw new FederationAuthError("federation_domain_denied", 403);

    try {
      const discovery = await this.discover(domain, false);
      let jwks = this.remoteJwks.get(unverified.iss);
      if (!jwks) {
        jwks = createRemoteJWKSet(new URL(discovery.jwksUrl), {
          [customFetch]: this.http.fetch,
          cooldownDuration: 5_000,
          cacheMaxAge: this.config.federationDiscoveryCacheMs,
          timeoutDuration: 10_000,
        });
        this.remoteJwks.set(unverified.iss, jwks);
      }
      const result = await jwtVerify(token, jwks, {
        algorithms: ["EdDSA"],
        issuer: `https://${domain}`,
        audience: this.baseOrigin,
        clockTolerance: this.config.federationClockToleranceSeconds,
        requiredClaims: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
      });
      const subject = normalizeSubject(String(result.payload.sub), domain);
      const jti = String(result.payload.jti);
      const expiresAt = Number(result.payload.exp);
      const issuedAt = Number(result.payload.iat);
      const notBefore = Number(result.payload.nbf);
      const now = Math.floor(Date.now() / 1000);
      const tolerance = this.config.federationClockToleranceSeconds;
      if (
        !Number.isSafeInteger(expiresAt) ||
        !Number.isSafeInteger(issuedAt) ||
        !Number.isSafeInteger(notBefore) ||
        expiresAt - issuedAt > 300 ||
        expiresAt <= issuedAt ||
        issuedAt > now + tolerance ||
        expiresAt > now + 300 + tolerance ||
        issuedAt - notBefore > 60 ||
        jti.length < 8 ||
        jti.length > 200
      ) {
        throw new Error("federation_claims_invalid");
      }
      await this.claimJti(`https://${domain}`, jti, expiresAt);
      return { issuer: `https://${domain}`, domain, subject, expiresAt, jti };
    } catch (error) {
      if (error instanceof FederationAuthError) throw error;
      throw new FederationAuthError("federation_token_invalid");
    }
  }

  async discover(domainValue: string, requireAllowed = true): Promise<FederationDiscoveryDocument> {
    this.assertEnabled();
    const domain = normalizeFederationDomain(domainValue);
    if (domain === this.domain) return this.discoveryDocument();
    if (requireAllowed && !await this.policy.isAllowed(domain)) throw new FederationAuthError("federation_domain_denied", 403);
    const cached = this.discoveryCache.get(domain);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const response = await this.http.fetch(`https://${domain}${FEDERATION_WELL_KNOWN_PATH}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`federation_discovery_http_${response.status}`);
    const parsed = discoverySchema.parse(await response.json());
    const safeBaseUrl = await assertSafeEndpoint(parsed.baseUrl, {
      allowHttp: this.config.allowHttpAgentEndpoints,
      allowPrivate: this.config.allowPrivateAgentEndpoints,
    });
    const baseUrl = normalizeBaseUrl(safeBaseUrl.toString());
    const jwksUrl = (await assertSafeEndpoint(parsed.jwksUrl, {
      allowHttp: this.config.allowHttpAgentEndpoints,
      allowPrivate: this.config.allowPrivateAgentEndpoints,
    })).toString();
    if (new URL(jwksUrl).origin !== new URL(baseUrl).origin) throw new Error("federation_jwks_origin_mismatch");
    const value: FederationDiscoveryDocument = { ...parsed, baseUrl, jwksUrl };
    this.discoveryCache.set(domain, { value, expiresAt: Date.now() + this.config.federationDiscoveryCacheMs });
    return value;
  }

  async fetchAgentCard(addressValue: string): Promise<{ card: AgentCardType; domain: string }> {
    const { localpart, domain } = splitAgentAddress(addressValue);
    if (domain === this.domain) throw new Error("federation_remote_address_required");
    const discovery = await this.discover(domain);
    const authorization = await this.mintToken(`router@${this.domain}`, discovery.baseUrl);
    const resolver = new DefaultAgentCardResolver({
      fetchImpl: async (input, init) => this.http.fetch(input, {
        ...init,
        headers: { ...headersRecord(init?.headers), Authorization: `Bearer ${authorization}` },
      }),
    });
    const card = await resolver.resolve(discovery.baseUrl, `/a2a/agents/${encodeURIComponent(localpart)}/card`);
    for (const entry of card.supportedInterfaces) {
      const endpoint = await assertSafeEndpoint(entry.url, {
        allowHttp: this.config.allowHttpAgentEndpoints,
        allowPrivate: this.config.allowPrivateAgentEndpoints,
      });
      if (endpoint.origin !== new URL(discovery.baseUrl).origin) throw new Error("federation_agent_interface_origin_mismatch");
    }
    return { card: AgentCard.fromJSON(card), domain };
  }

  async clientFor(card: AgentCardType, targetDomain: string, subject: string): Promise<Client> {
    const discovery = await this.discover(targetDomain);
    const interceptor: ClientInterceptor = {
      before: async (args) => {
        const authorization = await this.mintToken(subject, discovery.baseUrl);
        args.options = {
          ...args.options,
          serviceParameters: {
            ...(args.options?.serviceParameters ?? {}),
            Authorization: `Bearer ${authorization}`,
          },
        };
      },
      after: async () => undefined,
    };
    const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new RestTransportFactory({ fetchImpl: this.http.fetch }),
        new JsonRpcTransportFactory({ fetchImpl: this.http.fetch }),
      ],
      clientConfig: { polling: true, interceptors: [interceptor] },
    });
    return new ClientFactory(options).createFromAgentCard(card);
  }

  async clientForLocal(card: AgentCardType): Promise<Client> {
    const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new RestTransportFactory({ fetchImpl: this.http.fetch }),
        new JsonRpcTransportFactory({ fetchImpl: this.http.fetch }),
      ],
      clientConfig: { polling: true },
    });
    return new ClientFactory(options).createFromAgentCard(card);
  }

  async assertCallbackUrl(identity: FederationIdentity, rawUrl: string): Promise<void> {
    const discovery = await this.discover(identity.domain);
    const callback = await assertSafeEndpoint(rawUrl, {
      allowHttp: this.config.allowHttpAgentEndpoints,
      allowPrivate: this.config.allowPrivateAgentEndpoints,
    });
    const base = new URL(discovery.baseUrl);
    if (callback.origin !== base.origin) throw new Error("federation_callback_origin_mismatch");
    const requiredPrefix = `${base.pathname.replace(/\/$/, "")}${FEDERATION_PUSH_PATH_PREFIX}`.replace(/^\/\//, "/");
    const callbackId = callback.pathname.startsWith(requiredPrefix)
      ? callback.pathname.slice(requiredPrefix.length)
      : "";
    if (!callbackId || callbackId.includes("/") || callback.search || callback.hash) {
      throw new Error("federation_callback_path_invalid");
    }
  }

  async request(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    return this.http.fetch(input, init);
  }

  async close(): Promise<void> {
    await this.http.close();
  }

  private async claimJti(issuer: string, jti: string, expiresAt: number): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO federation_jti(issuer, jti, expires_at)
       VALUES ($1, $2, to_timestamp($3))
       ON CONFLICT (issuer, jti) DO NOTHING`,
      [issuer, jti, expiresAt],
    );
    if (result.rowCount !== 1) throw new FederationAuthError("federation_token_replayed");
    this.replayClaimsSinceCleanup += 1;
    if (this.replayClaimsSinceCleanup >= 1000) {
      this.replayClaimsSinceCleanup = 0;
      await this.pool.query("DELETE FROM federation_jti WHERE expires_at < now()");
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error("federation_disabled");
  }
}

export function federationPrincipalId(identity: Pick<FederationIdentity, "issuer" | "subject">): string {
  return `federation:${Buffer.from(identity.issuer).toString("base64url")}:${Buffer.from(identity.subject).toString("base64url")}`;
}

export function parseFederationPrincipalId(value: string): { issuer: string; domain: string; subject: string } | undefined {
  const match = /^federation:([^:]+):([^:]+)$/.exec(value);
  if (!match) return undefined;
  try {
    const issuer = Buffer.from(match[1]!, "base64url").toString("utf8");
    const subject = Buffer.from(match[2]!, "base64url").toString("utf8");
    const domain = domainFromIssuer(issuer);
    return { issuer, domain, subject: normalizeSubject(subject, domain) };
  } catch {
    return undefined;
  }
}

export function splitAgentAddress(value: string): { localpart: string; domain: string; address: string } {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0) throw new Error("agent_address_invalid");
  const localpart = normalized.slice(0, separator);
  const domain = normalizeFederationDomain(normalized.slice(separator + 1));
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(localpart)) throw new Error("agent_address_invalid");
  return { localpart, domain, address: `${localpart}@${domain}` };
}

function domainFromIssuer(value: string): string {
  const issuer = new URL(value);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.port || issuer.pathname !== "/" || issuer.search || issuer.hash) {
    throw new Error("federation_issuer_invalid");
  }
  return normalizeFederationDomain(issuer.hostname);
}

function normalizeSubject(value: string, domain: string): string {
  const parsed = splitAgentAddress(value);
  if (parsed.domain !== domain) throw new Error("federation_subject_domain_mismatch");
  return parsed.address;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("federation_base_url_invalid");
  return value.replace(/\/+$/, "");
}

function headersRecord(value: HeadersInit | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(new Headers(value).entries());
}

async function loadAdditionalJwks(path: string): Promise<JWK[]> {
  const parsed = additionalJwksSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const keys: JWK[] = [];
  const seen = new Set<string>();
  for (const value of parsed.keys) {
    if ("d" in value) throw new Error("federation_additional_jwks_private_key_forbidden");
    const key = value as JWK;
    await importJWK(key, "EdDSA");
    const thumbprint = await calculateJwkThumbprint(key, "sha256");
    if (value.kid !== thumbprint) throw new Error("federation_additional_jwks_kid_invalid");
    if (seen.has(value.kid)) throw new Error("federation_additional_jwks_duplicate_kid");
    seen.add(value.kid);
    keys.push({ ...key, alg: "EdDSA", kid: value.kid, use: "sig" });
  }
  return keys;
}
