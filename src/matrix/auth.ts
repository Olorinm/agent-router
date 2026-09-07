import { randomBytes } from "node:crypto";
import { createClient, MatrixError, type MatrixClient, type ICreateClientOpts, type RegisterRequest } from "matrix-js-sdk";
import type { Logger } from "matrix-js-sdk/lib/logger.js";
import { mxid } from "./protocol.js";
import { ProfileStore, type MatrixProfile } from "./profile.js";

// Auth errors can contain a submitted credential; only our sanitized errors reach the CLI.
const quiet: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return quiet; } };
export function homeserverUrl(value: string, allowHttp = false): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if ((url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("A homeserver must use HTTPS and contain no credentials, query or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}
export function authClient(homeserver: string, options: Omit<ICreateClientOpts, "baseUrl"> = {}, fetchImpl: typeof fetch = fetch): MatrixClient {
  const origin = new URL(homeserver).origin;
  return createClient({ ...options, baseUrl: homeserver, logger: quiet, localTimeoutMs: 15_000,
    fetchFn: (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (new URL(url).origin !== origin) throw new Error("Matrix credential origin mismatch.");
      return fetchImpl(input, { ...init, redirect: "error" });
    } });
}

/** Discovery is unauthenticated. Credentials are only sent to the validated, selected homeserver. */
export async function discoverHomeserver(input: string, allowHttp = false, fetchImpl: typeof fetch = fetch): Promise<string> {
  const domain = input.startsWith("@") ? mxid.parse(input).slice(input.indexOf(":") + 1) : input;
  let base = homeserverUrl(domain, allowHttp);
  if (!domain.includes("://")) {
    const response = await fetchImpl(`${base}/.well-known/matrix/client`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const data = await response.json() as { "m.homeserver"?: { base_url?: string } };
      if (!data["m.homeserver"]?.base_url) throw new Error("Matrix discovery did not return m.homeserver.base_url.");
      base = homeserverUrl(data["m.homeserver"].base_url, allowHttp);
    } else if (response.status !== 404) throw new Error(`Matrix discovery failed (HTTP ${response.status}).`);
  }
  const client = authClient(base, {}, fetchImpl);
  try {
    const versions = await client.getVersions();
    if (!Array.isArray(versions.versions) || !versions.versions.length) throw new Error("The selected server does not advertise Matrix client APIs.");
  } finally { client.http.abort(); }
  return base;
}

export function authError(error: unknown): Error {
  if (error instanceof MatrixError) {
    const messages: Record<string, string> = {
      M_FORBIDDEN: "The server rejected the credentials or this registration is not permitted.",
      M_USER_IN_USE: "That Matrix username is already registered. Use login or choose another name.",
      M_INVALID_USERNAME: "The homeserver rejected that username.",
      M_WEAK_PASSWORD: "The password does not meet the homeserver policy.",
      M_UNKNOWN_TOKEN: "The Matrix session has expired or been revoked. Log in again.",
      M_LIMIT_EXCEEDED: "The homeserver rate limit was reached. Retry later.",
    };
    return new Error(messages[error.errcode ?? ""] ?? `Matrix authentication failed (HTTP ${error.httpStatus ?? "unknown"}).`);
  }
  return error instanceof Error ? error : new Error("Matrix authentication failed.");
}

type Credentials = { user_id: string; device_id?: string; access_token?: string; refresh_token?: string };
export async function saveLogin(store: ProfileStore, homeserver: string, credentials: Credentials, fetchImpl: typeof fetch = fetch): Promise<MatrixProfile> {
  const userId = mxid.parse(credentials.user_id);
  if (!credentials.device_id || !credentials.access_token) throw new Error("The server did not issue a Matrix device and access token.");
  const client = authClient(homeserver, { accessToken: credentials.access_token }, fetchImpl);
  try {
    const identity = await client.whoami();
    if (identity.user_id !== userId || (identity.device_id && identity.device_id !== credentials.device_id)) throw new Error("Matrix login identity verification failed.");
    const previous = store.load();
    if (previous && (previous.userId !== userId || previous.homeserver !== homeserver)) throw new Error("This profile belongs to another identity. Select a new --profile NAME.");
    const profile: MatrixProfile = { version: 1, homeserver, userId, deviceId: credentials.device_id,
      accessToken: credentials.access_token, ...(credentials.refresh_token ? { refreshToken: credentials.refresh_token } : {}),
      gatewayToken: previous?.gatewayToken ?? randomBytes(32).toString("hex"),
      connectorUrl: previous?.connectorUrl ?? "http://127.0.0.1:8787", ...(previous?.backend ? { backend: previous.backend } : {}) };
    store.save(profile); return profile;
  } catch (error) {
    // Do not leave a newly issued device token behind when a local save or identity check fails.
    await client.logout().catch(() => undefined); throw authError(error);
  } finally { client.http.abort(); }
}

export async function passwordLogin(homeserver: string, user: string, password: string, deviceName: string, fetchImpl: typeof fetch = fetch): Promise<Credentials> {
  const client = authClient(homeserver, {}, fetchImpl);
  try {
    if (!(await client.loginFlows()).flows.some((f) => f.type === "m.login.password")) {
      throw new Error("This homeserver does not offer password login. Its SSO/OAuth login is not yet supported by this CLI.");
    }
    return await client.loginRequest({ type: "m.login.password", identifier: { type: "m.id.user", user }, password,
      initial_device_display_name: deviceName, refresh_token: true });
  } catch (error) { throw authError(error); } finally { client.http.abort(); }
}

export async function registerAccount(homeserver: string, username: string, password: string, deviceName: string,
  registrationToken: () => Promise<string>, fetchImpl: typeof fetch = fetch): Promise<Credentials> {
  const client = authClient(homeserver, {}, fetchImpl);
  const request: RegisterRequest = { username, password, initial_device_display_name: deviceName, refresh_token: true };
  let token: string | undefined;
  let lastStage = "";
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      try { return await client.registerRequest(request); }
      catch (error) {
        if (!(error instanceof MatrixError) || error.httpStatus !== 401 || !Array.isArray(error.data.flows) || typeof error.data.session !== "string") throw error;
        const flows = error.data.flows as Array<{ stages: string[] }>;
        const supported = new Set(["m.login.dummy", "m.login.registration_token"]);
        const flow = flows.filter((f) => Array.isArray(f.stages) && f.stages.every((s) => supported.has(s))).sort((a, b) => a.stages.length - b.stages.length)[0];
        if (!flow) throw new Error("Registration requires additional verification. Complete it in a compatible Matrix client, then use login here.");
        const completed = new Set(Array.isArray(error.data.completed) ? error.data.completed : []);
        const stage = flow.stages.find((s) => !completed.has(s));
        if (!stage || stage === lastStage) throw new Error("Registration verification was rejected. Check the invitation code and retry.");
        lastStage = stage;
        if (stage === "m.login.registration_token") token ??= await registrationToken();
        request.auth = { type: stage, session: error.data.session, ...(stage === "m.login.registration_token" ? { token } : {}) };
      }
    }
    throw new Error("Registration did not finish within the supported verification steps.");
  } catch (error) { throw authError(error); } finally { client.http.abort(); }
}

/** The profile lock must be held while this client's refresh callback can update credentials. */
export function profileClient(profile: MatrixProfile, store: ProfileStore, fetchImpl: typeof fetch = fetch): MatrixClient {
  return authClient(profile.homeserver, { accessToken: profile.accessToken!, userId: profile.userId, deviceId: profile.deviceId,
    ...(profile.refreshToken ? { refreshToken: profile.refreshToken, tokenRefreshFunction: async (token: string) => {
      const client = authClient(profile.homeserver, {}, fetchImpl);
      try {
        const result = await client.refreshToken(token);
        profile.accessToken = result.access_token;
        profile.refreshToken = result.refresh_token;
        store.save(profile);
        return { accessToken: result.access_token, refreshToken: result.refresh_token, expiry: new Date(Date.now() + result.expires_in_ms) };
      } finally { client.http.abort(); }
    } } : {}) }, fetchImpl);
}
