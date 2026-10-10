import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const feishuCredentialsSchema = z.object({ version: z.literal(1), appId: z.string().min(1),
  appSecretFile: z.string().min(1), domain: z.enum(["feishu", "lark"]), ownerOpenId: z.string().min(1) }).strict();
export type FeishuCredentials = z.infer<typeof feishuCredentialsSchema>;
export function privateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.partial`;
  writeFileSync(temporary, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, path); chmodSync(path, 0o600);
}
export function loadFeishuCredentials(path: string) {
  const credentials = feishuCredentialsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const directory = dirname(resolve(path));
  const appSecret = readFileSync(resolve(directory, credentials.appSecretFile), "utf8").trim();
  if (!appSecret) throw new Error("empty_feishu_app_secret");
  return { credentials, directory, appSecret };
}
export interface CliResult { code: number; stdout: string; stderr: string; }
export type CliRunner = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<CliResult>;
export const runOfficialCli: CliRunner = (args, options) => new Promise((resolveResult, reject) => {
  const require = createRequire(import.meta.url);
  const binary = join(dirname(require.resolve("@larksuite/cli/package.json")), "bin", process.platform === "win32" ? "lark-cli.exe" : "lark-cli");
  if (!existsSync(binary)) { reject(new Error("official_lark_cli_not_installed")); return; }
  // Invoke the pinned official binary, never a shell or the user's global CLI configuration.
  execFile(binary, args, { ...options, maxBuffer: 2_000_000, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") { reject(new Error(error.killed ? "lark_cli_execution_interrupted" : "lark_cli_execution_failed")); return; }
    resolveResult({ code: error?.code as number ?? 0, stdout, stderr });
  });
});
function json(output: CliResult): any {
  const text = output.stdout.trim() || output.stderr.trim();
  try { return JSON.parse(text); } catch { throw new Error("invalid_lark_cli_response"); }
}
const scopeSchema = z.array(z.string().regex(/^[a-zA-Z0-9_:.-]{1,128}$/)).max(100);
const pendingSchema = z.object({ deviceCode: z.string().min(1), verificationUrl: z.url(), expiresAt: z.number(), requestedScopes: scopeSchema.default([]) });
export class FeishuAccount {
  readonly workspace: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private authorizationQueue: Promise<unknown> = Promise.resolve();
  constructor(readonly credentials: FeishuCredentials, readonly directory: string, readonly runner: CliRunner = runOfficialCli) {
    this.directory = resolve(directory);
    this.workspace = join(this.directory, "workspace"); this.configDirectory = join(this.directory, "lark-cli");
    this.dataDirectory = join(this.directory, "cli-data");
    mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
    mkdirSync(this.configDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    const configFile = join(this.configDirectory, "config.json");
    if (!existsSync(configFile)) privateFile(configFile, { apps: [{ appId: credentials.appId,
      appSecret: { source: "file", id: resolve(this.directory, credentials.appSecretFile) },
      brand: credentials.domain, defaultAs: "user", users: [] }] });
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    if (config.apps?.length !== 1 || config.apps[0]?.appId !== credentials.appId || config.apps[0]?.brand !== credentials.domain)
      throw new Error("feishu_cli_application_mismatch");
  }
  command(args: string[], timeout = 30_000, cwd = this.workspace): Promise<CliResult> {
    const operation = this.queue.then(() => {
      const env = { ...process.env };
      for (const name of Object.keys(env)) if (/^(OPENCLAW_|HERMES_)/.test(name) || name === "LARK_CHANNEL" ||
        /^LARKSUITE_CLI_(APP_ID|APP_SECRET|BRAND|PROFILE|DEFAULT_AS|USER_ACCESS_TOKEN|TENANT_ACCESS_TOKEN.*|AUTH_PROXY|TOKEN_ONLY__.*)$/.test(name)) delete env[name];
      env.LARKSUITE_CLI_CONFIG_DIR = this.configDirectory;
      env.LARKSUITE_CLI_DATA_DIR = this.dataDirectory;
      env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = "1"; env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = "1";
      return this.runner([...args, "--profile", this.credentials.appId], { cwd, env, timeout });
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async status(verify = false) {
    const output = await this.command(["auth", "status", "--json", ...(verify ? ["--verify"] : [])]);
    const value = json(output), user = value.identities?.user;
    const appMatches = value.appId === this.credentials.appId;
    const ownerMatches = user?.openId === this.credentials.ownerOpenId;
    return { appId: this.credentials.appId, ownerOpenId: this.credentials.ownerOpenId,
      authorized: output.code === 0 && appMatches && ownerMatches && user?.available === true && !["expired", "missing", "invalid", "revoked"].includes(user?.tokenStatus),
      verified: verify && value.verified === true && user?.verified === true && appMatches && ownerMatches,
      userName: ownerMatches ? String(user?.userName ?? "") : "", scope: ownerMatches ? String(user?.scope ?? "").split(/\s+/).filter(Boolean) : [],
      status: !appMatches ? "application_mismatch" : user?.available && !ownerMatches ? "owner_mismatch" : String(user?.status ?? "not_authorized"),
    };
  }
  private authorize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.authorizationQueue.then(operation);
    this.authorizationQueue = result.catch(() => {}); return result;
  }
  begin(domains: string[] = ["all"]) { return this.authorize(() => this.beginAuthorization(domains, [])); }
  private async beginAuthorization(domains: string[], scopes: string[]) {
    const selected = z.array(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)).min(1).max(30).parse(domains);
    const requestedScopes = scopeSchema.parse(scopes);
    const output = await this.command(["auth", "login", "--domain", selected.join(","), ...(requestedScopes.length ? ["--scope", requestedScopes.join(" ")] : []), "--no-wait", "--json"]);
    if (output.code !== 0) throw new Error("feishu_authorization_start_failed");
    const value = json(output);
    const pending = pendingSchema.parse({ deviceCode: value.device_code, verificationUrl: value.verification_url, requestedScopes,
      expiresAt: Date.now() + z.number().int().positive().max(86_400).parse(value.expires_in) * 1000 });
    privateFile(join(this.directory, "authorization.json"), pending);
    return { verificationUrl: pending.verificationUrl, expiresAt: new Date(pending.expiresAt).toISOString() };
  }
  complete() { return this.authorize(() => this.completeAuthorization()); }
  private async completeAuthorization() {
    const current = await this.status(true);
    if (current.authorized && current.verified) { this.clearPending(); return current; }
    const pending = pendingSchema.parse(JSON.parse(readFileSync(join(this.directory, "authorization.json"), "utf8")));
    if (pending.expiresAt <= Date.now()) throw new Error("feishu_authorization_expired");
    const output = await this.command(["auth", "login", "--device-code", pending.deviceCode, "--json"], 30_000);
    if (output.code !== 0) throw new Error("feishu_authorization_not_completed");
    const status = await this.status(true);
    if (!status.authorized || !status.verified) throw new Error(status.status === "owner_mismatch" ? "feishu_authorized_wrong_owner" : "feishu_authorization_verification_failed");
    this.clearPending();
    return status;
  }
  private clearPending() { const path = join(this.directory, "authorization.json"); if (existsSync(path)) unlinkSync(path); }
  async pollAuthorization(): Promise<void> {
    const path = join(this.directory, "authorization.json");
    if (!existsSync(path)) return;
    const pending = pendingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (pending.expiresAt <= Date.now()) return;
    try { await this.complete(); } catch { /* Pending consent is normal. The next bounded poll resumes it. */ }
  }
  authorizationLink(scopes: string[] = []) { return this.authorize(() => this.pendingAuthorizationLink(scopeSchema.parse(scopes))); }
  private async pendingAuthorizationLink(scopes: string[]) {
    const path = join(this.directory, "authorization.json");
    if (existsSync(path)) {
      const pending = pendingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (pending.expiresAt > Date.now() && scopes.every((scope) => pending.requestedScopes.includes(scope))) return pending.verificationUrl;
    }
    return (await this.beginAuthorization(["all"], scopes)).verificationUrl;
  }
  async qr(url: string) {
    const output = await this.command(["auth", "qrcode", url, "--output", "authorization.png"], 10_000, this.directory);
    if (output.code !== 0) throw new Error("feishu_authorization_qr_failed");
    return join(this.directory, "authorization.png");
  }
}
