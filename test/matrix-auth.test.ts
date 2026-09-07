import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { authClient, discoverHomeserver, passwordLogin, profileClient, registerAccount, saveLogin } from "../src/matrix/auth.js";
import { connectorAddress, ProfileStore, publicProfile, type MatrixProfile } from "../src/matrix/profile.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function store() { const path = mkdtempSync(join(tmpdir(), "matrix-auth-")); directories.push(path); return new ProfileStore("agent", path); }
const base = "https://hs.example";
const user = "@agent:identity.example";
const credentials = { user_id: user, device_id: "DEVICE", access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" };
const profile = (): MatrixProfile => ({ version: 1, homeserver: base, userId: user, deviceId: "DEVICE", accessToken: credentials.access_token,
  refreshToken: credentials.refresh_token, gatewayToken: "synthetic-gateway-token", connectorUrl: "http://127.0.0.1:8787" });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
type Request = { url: URL; body: any; init: RequestInit | undefined };
function network(handle: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = { url: new URL(input.toString()), body: init?.body ? JSON.parse(init.body as string) : undefined, init };
    calls.push(request); return handle(request);
  };
  return { calls, fetchImpl };
}

describe("Matrix native account onboarding", () => {
  it("discovers the account domain, performs SDK password login and verifies the issued identity before saving", async () => {
    const disk = store();
    const net = network(({ url, body }) => {
      if (url.pathname === "/.well-known/matrix/client") return json({ "m.homeserver": { base_url: base } });
      if (url.pathname.endsWith("/versions")) return json({ versions: ["v1.11"] });
      if (url.pathname.endsWith("/login") && !body) return json({ flows: [{ type: "m.login.password" }] });
      if (url.pathname.endsWith("/login")) { expect(body.identifier).toEqual({ type: "m.id.user", user }); return json(credentials); }
      if (url.pathname.endsWith("/account/whoami")) return json({ user_id: user, device_id: "DEVICE" });
      throw new Error("unexpected request");
    });
    expect(await discoverHomeserver(user, false, net.fetchImpl)).toBe(base);
    const login = await passwordLogin(base, user, "a password with spaces", "Agent laptop", net.fetchImpl);
    await saveLogin(disk, base, login, net.fetchImpl);
    expect(disk.require().userId).toBe(user);
    expect(readFileSync(disk.path, "utf8")).not.toContain("a password with spaces");
    expect(statSync(disk.path).mode & 0o777).toBe(0o600);
    expect(statSync(disk.directory).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(publicProfile(disk.require(), disk))).not.toContain("token");
    expect(net.calls.every((c) => c.init?.redirect === "error")).toBe(true);
  });
  it("follows Synapse's registration-token and dummy UIA stages in one session", async () => {
    let prompts = 0;
    const net = network(({ body }) => {
      const flows = [{ stages: ["m.login.registration_token", "m.login.dummy"] }];
      if (!body.auth) return json({ flows, session: "uia-session" }, 401);
      expect(body.auth.session).toBe("uia-session");
      expect(body.username).toBe("agent"); expect(body.password).toBe("password");
      if (body.auth.type === "m.login.registration_token") {
        expect(body.auth.token).toBe("invitation");
        return json({ flows, session: "uia-session", completed: ["m.login.registration_token"] }, 401);
      }
      expect(body.auth).toEqual({ session: "uia-session", type: "m.login.dummy" }); return json(credentials);
    });
    expect(await registerAccount(base, "agent", "password", "Laptop", async () => { prompts++; return "invitation"; }, net.fetchImpl)).toEqual(credentials);
    expect(prompts).toBe(1); expect(net.calls).toHaveLength(3);
  });
  it("stops rejected invitations without retrying credentials indefinitely", async () => {
    const net = network(() => json({ flows: [{ stages: ["m.login.registration_token"] }], session: "s" }, 401));
    await expect(registerAccount(base, "agent", "password", "Laptop", async () => "bad", net.fetchImpl)).rejects.toThrow("verification was rejected");
    expect(net.calls).toHaveLength(2);
  });
  it("does not bypass unsupported registration verification or password-disabled login", async () => {
    const net = network(() => json({ flows: [{ stages: ["m.login.email.identity"] }], session: "s" }, 401));
    await expect(registerAccount(base, "agent", "password", "Laptop", async () => { throw new Error("must not ask"); }, net.fetchImpl)).rejects.toThrow("additional verification");
    expect(net.calls).toHaveLength(1);
    const sso = network(() => json({ flows: [{ type: "m.login.sso" }] }));
    await expect(passwordLogin(base, user, "password", "Laptop", sso.fetchImpl)).rejects.toThrow("does not offer password login");
    expect(sso.calls).toHaveLength(1);
  });
  it("rejects insecure discovery and does not treat an invalid discovery response as permission to send credentials elsewhere", async () => {
    const insecure = network(() => json({ "m.homeserver": { base_url: "http://other.example" } }));
    await expect(discoverHomeserver(user, false, insecure.fetchImpl)).rejects.toThrow("HTTPS");
    expect(insecure.calls).toHaveLength(1);
    const unavailable = network(() => json({}, 503));
    await expect(discoverHomeserver(user, false, unavailable.fetchImpl)).rejects.toThrow("503");
    expect(unavailable.calls).toHaveLength(1);
  });
  it("binds authentication to the chosen origin and blocks HTTP redirects", async () => {
    const net = network(() => new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/collect" } }));
    const client = authClient(base, { accessToken: credentials.access_token }, net.fetchImpl);
    await expect(client.whoami()).rejects.toThrow();
    expect(net.calls).toHaveLength(1); expect(net.calls[0]?.init?.redirect).toBe("error");
    await expect(client.http.requestOtherUrl("GET" as any, "https://elsewhere.example/collect")).rejects.toThrow("origin mismatch");
    expect(net.calls).toHaveLength(1);
  });
  it("revokes a newly issued token when its identity cannot be saved without replacing another profile", async () => {
    const disk = store(); disk.save(profile());
    const before = readFileSync(disk.path, "utf8");
    const other = { ...credentials, user_id: "@other:identity.example" };
    const net = network(({ url }) => url.pathname.endsWith("/logout") ? json({}) : json({ user_id: other.user_id }));
    await expect(saveLogin(disk, base, other, net.fetchImpl)).rejects.toThrow("another identity");
    expect(net.calls.at(-1)?.url.pathname).toMatch(/logout$/);
    expect(readFileSync(disk.path, "utf8")).toBe(before);
  });
  it("sanitizes server errors instead of echoing reflected passwords", async () => {
    const net = network(({ body }) => body ? json({ errcode: "M_FORBIDDEN", error: "reflected-secret" }, 403) : json({ flows: [{ type: "m.login.password" }] }));
    const error = await passwordLogin(base, user, "reflected-secret", "Laptop", net.fetchImpl).catch((e) => e);
    expect(error.message).toContain("rejected"); expect(error.message).not.toContain("reflected-secret");
    const verify = network(({ url }) => url.pathname.endsWith("/logout") ? json({}) : json({ errcode: "M_UNKNOWN_TOKEN", error: credentials.access_token }, 401));
    const failedSave = await saveLogin(store(), base, credentials, verify.fetchImpl).catch((e) => e);
    expect(failedSave.message).not.toContain(credentials.access_token);
    expect(verify.calls.at(-1)?.url.pathname).toMatch(/logout$/);
  });
  it("persists SDK token rotation without replacing backend, gateway or account identity", async () => {
    const disk = store(); const saved = { ...profile(), backend: { cardUrl: "http://127.0.0.1:8080/card", token: "backend-token", allowLocal: true } };
    disk.save(saved); const release = disk.lock();
    const net = network(({ url, init, body }) => {
      if (url.pathname.endsWith("/refresh")) { expect(body.refresh_token).toBe(credentials.refresh_token); return json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in_ms: 60000 }); }
      if (new Headers(init?.headers).get("Authorization") === "Bearer rotated-access") return json({ user_id: user, device_id: "DEVICE" });
      return json({ errcode: "M_UNKNOWN_TOKEN", soft_logout: true }, 401);
    });
    try {
      expect((await profileClient(saved, disk, net.fetchImpl).whoami()).user_id).toBe(user);
      expect(disk.require()).toMatchObject({ accessToken: "rotated-access", refreshToken: "rotated-refresh", gatewayToken: saved.gatewayToken, backend: saved.backend });
    } finally { release(); }
  });
  it("excludes concurrent profile mutation and safely recovers a dead local owner", () => {
    const disk = store(); disk.save(profile()); const release = disk.lock();
    expect(() => disk.lock()).toThrow("Profile is in use"); expect(disk.require().userId).toBe(user); release();
    const db = new DatabaseSync(join(disk.directory, "profile-lock.sqlite"));
    db.prepare("INSERT INTO owner VALUES(1,?)").run(JSON.stringify({ pid: 2147483647, host: hostname(), nonce: "dead" })); db.close();
    const recovered = disk.lock(); recovered();
  });
  it("rejects exposed credentials, symbolic-link session files and nonlocal gateway bindings", () => {
    const disk = store(); disk.save(profile()); chmodSync(disk.path, 0o644);
    expect(() => disk.load()).toThrow("0600"); chmodSync(disk.path, 0o600);
    unlinkSync(disk.path); symlinkSync("/dev/null", disk.path);
    expect(() => disk.load()).toThrow();
    expect(() => connectorAddress("http://0.0.0.0:8787")).toThrow("loopback");
    expect(() => new ProfileStore("../escape")).toThrow("profile name");
  });
});
