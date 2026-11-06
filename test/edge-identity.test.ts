import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { CloudflareAccessAuthenticator, edgeIdentityConfigSchema, loadEdgeIdentityConfig, type EdgeIdentityConfig } from "../src/auth/edge-identity.js";
import { ManagedService, createManagedApp, type ManagedAgent, type ServiceConfig } from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import { personId } from "../src/ledger/registry.js";

const team = "https://example-team.cloudflareaccess.com", aud = "a".repeat(64), root = "/_agent-router/v1";
const owner = "@owner:example.test", second = "@second:example.test", sub = "6f1c2d3e-0000-4000-8000-000000000000";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Key = { kid: string; privateKey: CryptoKey; jwk: JWK };
async function key(kid: string): Promise<Key> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  return { kid, privateKey, jwk: { ...await exportJWK(publicKey), kid, alg: "RS256", use: "sig" } };
}
/** A local stand-in for `/cdn-cgi/access/certs`; `keys` and `down` can change between requests. */
async function jwksServer(keys: Key[]) {
  const state = { keys, down: false, fetches: 0 };
  const server: Server = createServer((_req, res) => {
    state.fetches++;
    if (state.down) { res.writeHead(503).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: state.keys.map((item) => item.jwk) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return Object.assign(state, { url: new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/cdn-cgi/access/certs`) });
}
const now = () => Math.floor(Date.now() / 1000);
function sign(signer: Key, claims: Record<string, unknown> = {}, options: { iss?: string; aud?: string; exp?: number; iat?: number; nbf?: number } = {}) {
  const jwt = new SignJWT({ email: "owner@example.test", sub, type: "app", ...claims }).setProtectedHeader({ alg: "RS256", kid: signer.kid })
    .setIssuer(options.iss ?? team).setAudience(options.aud ?? aud).setIssuedAt(options.iat ?? now()).setExpirationTime(options.exp ?? now() + 3600)
    .setJti(crypto.randomUUID());
  if (options.nbf !== undefined) jwt.setNotBefore(options.nbf);
  return jwt.sign(signer.privateKey);
}
const config = (overrides: Partial<EdgeIdentityConfig> = {}): EdgeIdentityConfig => ({ provider: "cloudflare-access", teamDomain: team, audiences: [aud],
  owners: { "owner@example.test": owner, "ünïcode@example.test": owner, "second@example.test": { owner: second, sub } },
  serviceTokens: { "1a2b3c4d5e6f.access": owner }, ...overrides });
const headers = (token: string) => ({ headers: { "cf-access-jwt-assertion": token } });
async function rejected(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (failure: unknown) => failure as { message: string; status: number; details?: unknown });
  if (!error) throw new Error("expected_rejection");
  return { error: error.message, status: error.status, details: error.details };
}

describe("CloudflareAccessAuthenticator", () => {
  it("accepts a valid application JWT and rejects wrong audience, issuer, times, algorithms and signatures", async () => {
    const signer = await key("k1"), forger = await key("k1"), jwks = await jwksServer([signer]);
    const auth = new CloudflareAccessAuthenticator(config(), { certsUrl: jwks.url });
    const principal = await auth.authenticate(headers(await sign(signer)));
    expect(principal).toMatchObject({ ownerId: owner, personId: personId(owner), via: "edge", email: "owner@example.test" });
    expect(principal.expiresAt).toBeGreaterThan(Date.now());
    // Within the 60 s skew.
    await expect(auth.verify(await sign(signer, {}, { exp: now() - 30, iat: now() - 100 }))).resolves.toMatchObject({ ownerId: owner });
    const invalid = { error: "edge_identity_invalid", status: 401 };
    for (const token of [
      await sign(signer, {}, { aud: "b".repeat(64) }),
      await sign(signer, {}, { iss: "https://other-team.cloudflareaccess.com" }),
      await sign(signer, {}, { exp: now() - 61, iat: now() - 100 }),
      await sign(signer, {}, { nbf: now() + 61 }),
      await sign(signer, { type: "org" }),
      await sign(forger),
      await new SignJWT({ email: "owner@example.test" }).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer(team).setAudience(aud)
        .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("s".repeat(32))),
      `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${Buffer.from(JSON.stringify({ email: "owner@example.test",
        iss: team, aud, iat: now(), exp: now() + 60 })).toString("base64url")}.`,
      await new SignJWT({ email: "owner@example.test" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(team).setAudience(aud)
        .setExpirationTime("1h").sign(signer.privateKey), // no iat
      "x".repeat(9000),
    ]) expect(await rejected(auth.verify(token))).toMatchObject(invalid);
    expect(await rejected(auth.authenticate({ headers: { "cf-access-jwt-assertion": ["a", "b"] as unknown as string } }))).toMatchObject(invalid);
  });

  it("refetches the key set once for an unknown kid, follows rotation and survives an outage with cached keys", async () => {
    const first = await key("k1"), second = await key("k2"), third = await key("k3"), jwks = await jwksServer([first]);
    const auth = new CloudflareAccessAuthenticator(config(), { certsUrl: jwks.url });
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanup.push(() => { vi.useRealTimers(); });
    await auth.verify(await sign(first));
    expect(jwks.fetches).toBe(1);
    vi.advanceTimersByTime(31_000);
    jwks.keys = [first, second];
    await expect(auth.verify(await sign(second))).resolves.toMatchObject({ ownerId: owner });
    expect(jwks.fetches).toBe(2);
    // A further unknown kid inside the 30 s cooldown does not refetch; after it, rotation is picked up.
    jwks.keys = [first, second, third];
    expect(await rejected(auth.verify(await sign(third)))).toMatchObject({ error: "edge_identity_invalid", status: 401 });
    expect(jwks.fetches).toBe(2);
    vi.advanceTimersByTime(31_000);
    jwks.keys = [second, third];
    await expect(auth.verify(await sign(third))).resolves.toMatchObject({ ownerId: owner });
    expect(jwks.fetches).toBe(3);
    expect(await rejected(auth.verify(await sign(first)))).toMatchObject({ error: "edge_identity_invalid", status: 401 });
    jwks.down = true;
    await expect(auth.verify(await sign(second))).resolves.toMatchObject({ ownerId: owner });
    const cold = new CloudflareAccessAuthenticator(config(), { certsUrl: jwks.url });
    expect(await rejected(cold.verify(await sign(first)))).toMatchObject({ error: "identity_provider_unavailable", status: 503 });
    const unreachable = new CloudflareAccessAuthenticator(config(), { certsUrl: new URL("http://127.0.0.1:9/cdn-cgi/access/certs") });
    expect(await rejected(unreachable.verify(await sign(first)))).toMatchObject({ error: "identity_provider_unavailable", status: 503 });
  });

  it("maps emails (case and NFC), pinned subjects and service tokens", async () => {
    const signer = await key("k1"), jwks = await jwksServer([signer]);
    const auth = new CloudflareAccessAuthenticator(config(), { certsUrl: jwks.url });
    await expect(auth.verify(await sign(signer, { email: "Owner@Example.TEST" }))).resolves.toMatchObject({ ownerId: owner, email: "owner@example.test" });
    await expect(auth.verify(await sign(signer, { email: "U\u0308nI\u0308code@Example.test" }))).resolves.toMatchObject({ ownerId: owner });
    expect(await rejected(auth.verify(await sign(signer, { email: "stranger@example.test" }))))
      .toEqual({ error: "owner_not_configured", status: 403, details: { email: "stranger@example.test" } });
    await expect(auth.verify(await sign(signer, { email: "second@example.test" }))).resolves.toMatchObject({ ownerId: second });
    expect(await rejected(auth.verify(await sign(signer, { email: "second@example.test", sub: "other" }))))
      .toMatchObject({ error: "owner_subject_mismatch", status: 403 });
    await expect(auth.verify(await sign(signer, { email: undefined, sub: "", common_name: "1a2b3c4d5e6f.access" })))
      .resolves.toMatchObject({ ownerId: owner, via: "edge-service" });
    expect(await rejected(auth.verify(await sign(signer, { email: undefined, common_name: "unknown.access" }))))
      .toMatchObject({ error: "service_token_not_configured", status: 403 });
    expect(await rejected(auth.verify(await sign(signer, { email: undefined })))).toMatchObject({ error: "edge_identity_invalid", status: 401 });
  });

  it("validates the operator config", () => {
    const dir = mkdtempSync(join(tmpdir(), "edge-config-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "edge.json"), JSON.stringify({ edgeIdentity: config() }));
    expect(loadEdgeIdentityConfig(join(dir, "edge.json"))).toMatchObject({ clockSkewSeconds: 60, bearer: "allow" });
    for (const bad of [{ teamDomain: "http://example-team.cloudflareaccess.com" }, { teamDomain: `${team}/path` }, { teamDomain: `${team}/` },
      { audiences: [] }, { owners: { "Owner@example.test": owner } }, { owners: { "owner@example.test": "@_ar_agent:example.test" } },
      { clockSkewSeconds: 301 }]) expect(() => edgeIdentityConfigSchema.parse(config(bad as Partial<EdgeIdentityConfig>))).toThrow();
  });
});

function transport(agent: ManagedAgent, inbox: ApplicationInbox): MatrixTransport {
  return { identity: async () => agent.matrixId,
    sync: async (since) => { await new Promise((r) => setTimeout(r, 20)); return inbox.next(agent.id, since) ?? { next_batch: since ?? "0" }; },
    state: async () => [], history: async () => ({ events: [] }), createRoom: async () => "!room:example.test",
    join: async () => {}, send: async () => "$sent", stop: () => {} };
}
async function service(edge: Partial<EdgeIdentityConfig> | undefined, overrides: Partial<ServiceConfig> = {}) {
  const signer = await key("k1"), jwks = await jwksServer([signer]);
  const stateDir = mkdtempSync(join(tmpdir(), "edge-service-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const managed = new ManagedService({ serverName: "example.test", homeserver: "https://example.test", publicUrl: "https://example.test/_agent-router/v1",
    stateDir, asToken: "a".repeat(48), hsToken: "h".repeat(48), ledgerRead: true, ...(edge ? { edgeIdentity: config(edge) } : {}), ...overrides }, {
    authenticate: async (token) => { if (token === "owner") return owner; if (token === "second") return second; throw new Error("bad_credentials"); },
    provision: async () => {}, transport, edgeIdentityCerts: jwks.url });
  cleanup.push(() => managed.close());
  const server = createManagedApp(managed).listen(0, "127.0.0.1");
  server.on("upgrade", (req, socket, head) => { if (!managed.web?.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port;
  const api = async (path: string, headers: Record<string, string>, method = "GET", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  };
  return { managed, api, signer, port, sign: (claims: Record<string, unknown> = {}, options = {}) => sign(signer, claims, options) };
}

describe("owner API with edge identity", () => {
  it("authenticates owner and web routes with the Access JWT and links the login identity", async () => {
    const t = await service({});
    await t.managed.create(owner, "helper");
    const jwt = { "cf-access-jwt-assertion": await t.sign() };
    expect((await t.api(`${root}/agents`, jwt)).data.data.map((agent: ManagedAgent) => agent.name)).toEqual(["helper"]);
    const me = await t.api(`${root}/web/me`, jwt);
    expect(me.data).toMatchObject({ ownerId: owner, person: { id: personId(owner), name: "owner" }, auth: { via: "edge", email: "owner@example.test" } });
    expect(me.data.identities.map((item: any) => [item.provider, item.namespace, item.subject, item.verifiedBy]))
      .toContainEqual(["cloudflare-access", "example-team.cloudflareaccess.com", "owner@example.test", "login"]);
    expect(await t.api(`${root}/web/me`, { "cf-access-jwt-assertion": await t.sign({ email: "stranger@example.test" }) }))
      .toEqual({ status: 403, data: { error: "owner_not_configured", email: "stranger@example.test" } });
    // Bearer callers keep working when no assertion is present.
    expect((await t.api(`${root}/agents`, { Authorization: "Bearer owner" })).status).toBe(200);
    expect(await t.api(`${root}/agents`, { Authorization: "Bearer owner", ...jwt })).toMatchObject({ status: 200 });
  });

  it("never falls back to the bearer, never trusts the plain email header and detects conflicts", async () => {
    const t = await service({});
    const bad = { "cf-access-jwt-assertion": await t.sign({}, { aud: "b".repeat(64) }) };
    expect(await t.api(`${root}/agents`, { ...bad, Authorization: "Bearer owner" })).toEqual({ status: 401, data: { error: "edge_identity_invalid" } });
    expect(await t.api(`${root}/web/me`, { ...bad, Authorization: "Bearer owner" })).toEqual({ status: 401, data: { error: "edge_identity_invalid" } });
    const forged = { "cf-access-authenticated-user-email": "owner@example.test", Cookie: "CF_Authorization=forged" };
    expect(await t.api(`${root}/agents`, forged)).toEqual({ status: 401, data: { error: "account_login_required" } });
    expect(await t.api(`${root}/web/me`, forged)).toEqual({ status: 401, data: { error: "account_login_required" } });
    expect(await t.api(`${root}/agents`, { "cf-access-jwt-assertion": await t.sign(), Authorization: "Bearer second" }))
      .toEqual({ status: 401, data: { error: "principal_conflict" } });
    const deny = await service({ bearer: "deny" });
    expect(await deny.api(`${root}/agents`, { Authorization: "Bearer owner" })).toEqual({ status: 401, data: { error: "edge_identity_required" } });
    expect((await deny.api(`${root}/agents`, { "cf-access-jwt-assertion": await deny.sign(), Authorization: "Bearer second" })).status).toBe(200);
  });

  it("ignores the assertion header when edge identity is not configured", async () => {
    const t = await service(undefined);
    expect((await t.api(`${root}/agents`, { Authorization: "Bearer owner" })).status).toBe(200);
    expect(await t.api(`${root}/agents`, { "cf-access-jwt-assertion": await t.sign() })).toEqual({ status: 401, data: { error: "account_login_required" } });
  });

  it("rejects owner ids from another server at start", async () => {
    await expect(service({ owners: { "owner@example.test": "@owner:elsewhere.test" } })).rejects.toThrow("edge_identity_owner_not_local");
  });

  it("issues socket tickets to edge principals and closes the socket with 4401 at exp", async () => {
    const t = await service({});
    const jwt = { "cf-access-jwt-assertion": await t.sign({}, { exp: now() + 2 }) };
    const { ticket } = (await t.api(`${root}/web/socket-tickets`, jwt, "POST", {})).data;
    const socket = new WebSocket(`ws://127.0.0.1:${t.port}${root}/web/socket?ticket=${ticket}`);
    cleanup.push(() => socket.close());
    const hello = new Promise((resolve) => socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)))));
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    expect(await hello).toMatchObject({ event: "hello" });
    expect(await closed).toBe(4401);
  });
});
