import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { MatrixError } from "matrix-js-sdk";
import { authClient, authError, discoverHomeserver, passwordLogin, profileClient, registerAccount, saveLogin } from "../matrix/auth.js";
import { A2ABackend } from "../matrix/backend.js";
import { ProfileStore, connectorAddress, publicProfile } from "../matrix/profile.js";

export interface AccountOptions {
  profile?: string; homeserver?: string; "password-stdin"?: boolean; "password-file"?: string;
  "registration-token-file"?: string; "device-name"?: string; "connector-url"?: string;
  "endpoint-token-file"?: string; "allow-local"?: boolean; "allow-http"?: boolean;
}
const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
function secretInput(value: string): string {
  const result = value.replace(/\r?\n$/, "");
  if (!result || result.length > 65_536 || /[\r\n\0]/.test(result)) throw new Error("Provide one nonempty line of secret input.");
  return result;
}
async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error(`${label} requires a terminal; use the corresponding secret file or stdin option.`);
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write(`${label}: `);
  try {
    return secretInput(await new Promise<string>((resolve, reject) => {
      input.once("SIGINT", () => reject(new Error("Cancelled.")));
      input.once("close", () => reject(new Error("Input closed.")));
      void input.question("").then(resolve, reject);
    }));
  } finally { input.close(); process.stderr.write("\n"); }
}
async function password(options: AccountOptions, confirm: boolean): Promise<string> {
  if (options["password-stdin"] && options["password-file"]) throw new Error("Choose password stdin or password file.");
  if (options["password-stdin"]) return secretInput(readFileSync(0, "utf8"));
  if (options["password-file"]) return secretInput(readFileSync(options["password-file"], "utf8"));
  const value = await hiddenPrompt("Password");
  if (confirm && value !== await hiddenPrompt("Confirm password")) throw new Error("Passwords do not match.");
  return value;
}

export async function accountCommand(command: string, args: string[], options: AccountOptions): Promise<boolean> {
  if (!["register", "login", "logout", "whoami", "bind", "configure", "discover"].includes(command)) return false;
  const store = new ProfileStore(options.profile);
  if (command === "discover") {
    if (!args[0]) throw new Error("Usage: matrix discover SERVER_OR_MATRIX_ID");
    const homeserver = await discoverHomeserver(args[0], options["allow-http"]);
    const client = authClient(homeserver);
    try { output({ homeserver, loginFlows: (await client.loginFlows()).flows.map((f) => f.type) }); }
    finally { client.http.abort(); }
    return true;
  }
  if (command === "whoami") {
    const profile = store.require();
    const client = authClient(profile.homeserver, { accessToken: profile.accessToken! });
    try {
      const identity = await client.whoami();
      if (identity.user_id !== profile.userId) throw new Error("Saved Matrix identity does not match the server.");
      output(publicProfile(profile, store));
    } catch (error) { throw authError(error); } finally { client.http.abort(); }
    return true;
  }
  const release = store.lock();
  try {
    if (command === "logout") {
      const profile = store.require(); const client = profileClient(profile, store);
      try { await client.logout(); }
      catch (error) { if (!(error instanceof MatrixError) || error.errcode !== "M_UNKNOWN_TOKEN") throw authError(error); }
      finally { client.http.abort(); }
      delete profile.accessToken; delete profile.refreshToken; store.save(profile);
      output({ loggedOut: profile.userId, profile: store.name, historyRetained: true }); return true;
    }
    if (command === "configure") {
      const profile = store.require();
      if (!options["connector-url"]) throw new Error("Usage: matrix configure --connector-url http://127.0.0.1:8787");
      profile.connectorUrl = connectorAddress(options["connector-url"]).origin; store.save(profile);
      output(publicProfile(profile, store)); return true;
    }
    if (command === "bind") {
      if (!args[0]) throw new Error("Usage: matrix bind A2A_AGENT_CARD_URL [--endpoint-token-file PATH] [--allow-local]");
      const profile = store.require(); const url = new URL(args[0]);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error("Provide an HTTP(S) Agent Card URL without credentials, query or fragment.");
      if (profile.backend && profile.backend.cardUrl !== url.toString()) throw new Error("This profile already has a backend. Changing it requires explicit context migration.");
      const allowLocal = Boolean(options["allow-local"]) || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      const token = options["endpoint-token-file"] ? secretInput(readFileSync(options["endpoint-token-file"], "utf8")) : "";
      const backend = new A2ABackend(url.toString(), token, allowLocal);
      try { await backend.verify(); } finally { await backend.close(); }
      profile.backend = { cardUrl: url.toString(), token, allowLocal }; store.save(profile);
      output(publicProfile(profile, store)); return true;
    }
    const previous = store.load();
    if (command === "register" && previous) throw new Error("This profile already has an identity. Select a new --profile NAME to register another account.");
    const fullId = args[0]?.startsWith("@");
    const user = fullId ? args[0]! : args[1] ?? (command === "login" && !args.length ? previous?.userId : undefined);
    const server = options.homeserver ?? (fullId ? args[0] : args[0] ?? previous?.homeserver);
    if (!user || !server) throw new Error("Usage: matrix register SERVER USERNAME | matrix login @name:server | matrix login SERVER USERNAME");
    if (command === "register" && fullId) throw new Error("Register with a server and local username: matrix register SERVER USERNAME");
    if (previous && (fullId ? previous.userId !== user : !previous.userId.startsWith(`@${user}:`))) {
      throw new Error("This profile belongs to another identity. Select a new --profile NAME.");
    }
    const homeserver = await discoverHomeserver(server, options["allow-http"]);
    if (previous && previous.homeserver !== homeserver) throw new Error("This profile belongs to a different homeserver. Select a new --profile NAME.");
    if (previous?.accessToken) {
      const client = profileClient(previous, store);
      try {
        const identity = await client.whoami();
        if (identity.user_id !== previous.userId) throw new Error("Saved Matrix identity verification failed.");
        output({ ...publicProfile(previous, store), message: "Already logged in. Run connect to start this agent's connector." }); return true;
      } catch (error) { if (!(error instanceof MatrixError) || error.errcode !== "M_UNKNOWN_TOKEN") throw authError(error); }
      finally { client.http.abort(); }
    }
    const value = await password(options, command === "register");
    const deviceName = options["device-name"] ?? `Agent Router (${hostname()})`;
    const credentials = command === "register"
      ? await registerAccount(homeserver, user, value, deviceName, () => options["registration-token-file"]
        ? Promise.resolve(secretInput(readFileSync(options["registration-token-file"], "utf8"))) : hiddenPrompt("Registration invitation code"))
      : await passwordLogin(homeserver, user, value, deviceName);
    const profile = await saveLogin(store, homeserver, credentials);
    output({ ...publicProfile(profile, store), message: "Credentials saved. Run connect, or bind an A2A Agent Card before connecting." });
    return true;
  } finally { release(); }
}
