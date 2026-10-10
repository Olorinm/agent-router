import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FeishuAccount, privateFile, type CliRunner } from "../src/services/feishu/cli.js";
import { FeishuTools } from "../src/services/feishu/tools.js";
import { channelConfigSchema } from "../src/service/channels.js";
const cleanup: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "router-feishu-auth-")); cleanup.push(directory);
  privateFile(join(directory, "app-secret"), "fixture-secret");
  const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  let authorized = false, owner = "ou_owner", verify = true, commandCode = 0;
  let commandError = { type: "confirmation", subtype: "confirmation_required" } as Record<string, unknown>;
  const runner: CliRunner = async (args, options) => {
    calls.push({ args, cwd: options.cwd, env: options.env });
    if (args[0] === "auth" && args[1] === "status") return { code: 0, stderr: "", stdout: JSON.stringify({ appId: "cli_app", verified: verify,
      identities: { user: { available: authorized, verified: verify, status: authorized ? "needs_refresh" : "missing", tokenStatus: authorized ? "needs_refresh" : "missing",
        openId: owner, userName: "Owner", scope: "calendar:calendar:read offline_access" } } }) };
    if (args.includes("--no-wait")) return { code: 0, stderr: "", stdout: JSON.stringify({ device_code: "private-device-code",
      verification_url: "https://accounts.feishu.cn/verify?state=a%2Fb&code=xyz", expires_in: 600 }) };
    if (args.includes("--device-code")) { authorized = true; return { code: 0, stderr: "", stdout: "{}" }; }
    return { code: commandCode, stdout: commandCode ? "" : '{"ok":true,"identity":"user","data":{"items":["meeting"]}}',
      stderr: commandCode ? JSON.stringify({ ok: false, error: commandError }) : "" };
  };
  const account = new FeishuAccount({ version: 1, appId: "cli_app", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_owner" }, directory, runner);
  return { directory, account, calls, authorize: () => { authorized = true; }, wrongOwner: () => { owner = "ou_other"; }, noVerify: () => { verify = false; },
    requireConfirmation: () => { commandCode = 10; }, businessError: (error: Record<string, unknown>) => { commandCode = 3; commandError = error; } };
}
const call = (args: string[]) => ({ id: "call", runId: "run", kind: "tool", name: "feishu_feishu", input: { args }, status: "pending", deadlineAt: "2999-01-01T00:00:00Z" });
describe("official Feishu authorization and tool bridge", () => {
  it("keeps the application secret outside the tool workspace and preserves isolated CLI configuration", async () => {
    const f = fixture(); await f.account.status();
    const config = readFileSync(join(f.account.configDirectory, "config.json"), "utf8");
    expect(config).not.toContain("fixture-secret"); expect(JSON.parse(config).apps[0].appSecret).toEqual({ source: "file", id: join(f.directory, "app-secret") });
    expect(statSync(join(f.account.configDirectory, "config.json")).mode & 0o777).toBe(0o600);
    expect(f.calls[0]!.env.LARKSUITE_CLI_CONFIG_DIR).toBe(f.account.configDirectory);
    expect(f.calls[0]!.env.LARKSUITE_CLI_DATA_DIR).toBe(join(f.directory, "cli-data"));
    expect(f.calls[0]!.args.slice(-2)).toEqual(["--profile", "cli_app"]);
  });
  it("does not inherit another application's credentials or vendor workspace from the service environment", async () => {
    for (const name of ["LARKSUITE_CLI_APP_ID", "LARKSUITE_CLI_USER_ACCESS_TOKEN", "LARKSUITE_CLI_AUTH_PROXY", "OPENCLAW_HOME", "HERMES_HOME", "LARK_CHANNEL"])
      vi.stubEnv(name, "other-fixture-identity");
    const f = fixture(); await f.account.status();
    for (const name of ["LARKSUITE_CLI_APP_ID", "LARKSUITE_CLI_USER_ACCESS_TOKEN", "LARKSUITE_CLI_AUTH_PROXY", "OPENCLAW_HOME", "HERMES_HOME", "LARK_CHANNEL"])
      expect(f.calls[0]!.env[name]).toBeUndefined();
  });
  it("returns an unchanged URL while keeping the device code private, then verifies the linked user", async () => {
    const f = fixture(); const begin = await f.account.begin(["calendar", "docs"]);
    expect(begin.verificationUrl).toBe("https://accounts.feishu.cn/verify?state=a%2Fb&code=xyz");
    expect(JSON.stringify(begin)).not.toContain("private-device-code");
    expect(statSync(join(f.directory, "authorization.json")).mode & 0o777).toBe(0o600);
    expect(f.calls[0]!.args).toContain("calendar,docs");
    expect(await f.account.complete()).toMatchObject({ authorized: true, verified: true });
    expect(existsSync(join(f.directory, "authorization.json"))).toBe(false);
  });
  it("rejects an authorization completed by a different person", async () => {
    const f = fixture(); await f.account.begin(); f.wrongOwner();
    await expect(f.account.complete()).rejects.toThrow("feishu_authorized_wrong_owner");
    expect((await f.account.status()).authorized).toBe(false);
  });
  it("does not accept bot verification as proof of the user's authorization", async () => {
    const f = fixture(); await f.account.begin(); f.noVerify();
    await expect(f.account.complete()).rejects.toThrow("feishu_authorization_verification_failed");
  });
  it("resumes pending consent automatically after an account object is recreated", async () => {
    const f = fixture(); await f.account.begin();
    const resumed = new FeishuAccount(f.account.credentials, f.directory, f.account.runner);
    await resumed.pollAuthorization(); expect((await resumed.status()).authorized).toBe(true);
    expect(existsSync(join(f.directory, "authorization.json"))).toBe(false);
  });
  it("offers a reusable consent URL instead of executing an unauthorized business command", async () => {
    const f = fixture(), tool = new FeishuTools("feishu", f.account);
    const a = await tool.execute(call(["calendar", "+agenda"])), b = await tool.execute(call(["calendar", "+agenda"]));
    expect(a.success).toBe(false); expect(a.contentItems[0]!.text).toContain("authorizationUrl");
    expect(b.contentItems).toEqual(a.contentItems);
    expect(f.calls.filter((item) => item.args.includes("--no-wait"))).toHaveLength(1);
    expect(f.calls.filter((item) => item.args[0] === "calendar")).toHaveLength(0);
  });
  it("runs official business commands as the exact linked user and leaves refresh to the CLI", async () => {
    const f = fixture(); f.authorize(); const tool = new FeishuTools("feishu", f.account);
    expect((await tool.execute(call(["calendar", "+agenda"]))).success).toBe(true);
    const executed = f.calls.at(-1)!;
    expect(executed.args).toEqual(["calendar", "+agenda", "--as", "user", "--profile", "cli_app"]);
    expect(executed.cwd).toBe(join(f.directory, "workspace"));
  });
  it("preserves official confirmation errors without adding --yes automatically", async () => {
    const f = fixture(); f.authorize(); f.requireConfirmation();
    const result = await new FeishuTools("feishu", f.account).execute(call(["drive", "+delete", "--file-token", "file"]));
    expect(result.success).toBe(false); expect(result.contentItems[0]!.text).toContain("confirmation_required");
    expect(f.calls.at(-1)!.args).not.toContain("--yes");
  });
  it("does not allow tools to select another identity, change login, or execute a shell", async () => {
    const f = fixture(); f.authorize(); const tool = new FeishuTools("feishu", f.account);
    for (const args of [["auth", "login"], ["config", "init"], ["calendar", "+agenda", "--as=bot"], ["sh", "-c", "anything"], ["calendar", "+agenda", "--profile", "other"]])
      expect((await tool.execute(call(args))).success).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it("requires both the linked credential bundle and Host when enabling personal tools", () => {
    const base = { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", connections: [{ id: "feishu", kind: "feishu", appId: "app", appSecretFile: "secret", personalTools: true }] };
    expect(channelConfigSchema.safeParse({ agents: [base] }).success).toBe(false);
    expect(channelConfigSchema.safeParse({ agents: [{ ...base, host: { url: "http://host.test", tokenFile: "token", runtimeId: "personal" },
      connections: [{ id: "feishu", kind: "feishu", credentialsFile: "credentials.json", personalTools: true }] }] }).success).toBe(true);
  });
  it("serializes concurrent consent completion and reuses the pending link", async () => {
    const f = fixture();
    const links = await Promise.all([f.account.authorizationLink(), f.account.authorizationLink()]);
    expect(links[0]).toBe(links[1]); expect(f.calls.filter((c) => c.args.includes("--no-wait"))).toHaveLength(1);
    await Promise.all([f.account.complete(), f.account.complete()]);
    expect(f.calls.filter((c) => c.args.includes("--device-code"))).toHaveLength(1);
  });
  it("keeps long connection IDs within the native tool-name limit without collisions", () => {
    const f = fixture(), a = new FeishuTools("a".repeat(64), f.account), b = new FeishuTools("a".repeat(63) + "b", f.account);
    expect(a.definition.name).toHaveLength(64); expect(a.definition.name).not.toBe(b.definition.name);
  });
  it("offers official reauthorization for missing user scopes without replaying the business operation", async () => {
    const f = fixture(); f.authorize(); f.businessError({ type: "authorization", subtype: "missing_scope", missing_scopes: ["calendar:event:create"] });
    const result = await new FeishuTools("feishu", f.account).execute(call(["calendar", "+create"]));
    expect(result.success).toBe(false); expect(result.contentItems[0]!.text).toContain("authorizationUrl");
    expect(f.calls.find((c) => c.args.includes("--no-wait"))!.args).toContain("calendar:event:create");
    expect(f.calls.filter((c) => c.args[0] === "calendar")).toHaveLength(1);
  });
  it("preserves app/admin permission errors instead of creating an ineffective personal consent loop", async () => {
    const f = fixture(); f.authorize(); f.businessError({ type: "authorization", subtype: "app_scope_not_applied", console_url: "https://open.feishu.cn/app/app/auth" });
    const result = await new FeishuTools("feishu", f.account).execute(call(["calendar", "+agenda"]));
    expect(result.contentItems[0]!.text).toContain("app_scope_not_applied"); expect(result.contentItems[0]!.text).not.toContain("authorizationUrl");
    expect(f.calls.some((c) => c.args.includes("--no-wait"))).toBe(false);
  });
});
