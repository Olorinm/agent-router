import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { ConnectionSetup, qrTerminal } from "../src/connections/connections.js";
import { DurableStore } from "../src/communication/store.js";
import { FeishuAccount, privateFile } from "../src/services/feishu/cli.js";
import {
  apiGetFetch,
  apiPostFetch,
} from "../src/channels/weixin/vendor/api.js";
import type { ManagedService } from "../src/matrix/managed.js";
import type { ConnectionConfiguration } from "../src/connections/configuration.js";
import { agentChannelConfigSchema } from "../src/service/channels.js";
import { key } from "../src/matrix/protocol.js";

vi.mock("@larksuiteoapi/node-sdk", async (original) => ({
  ...(await original<typeof import("@larksuiteoapi/node-sdk")>()),
  registerApp: vi.fn(),
}));
const telegram = vi.hoisted(() => ({ api: {} as any }));
vi.mock("grammy", async (original) => {
  const actual = await original<typeof import("grammy")>();
  return {
    ...actual,
    Bot: class extends actual.Bot {
      constructor(token: string, options?: any) {
        super(token, options);
        Object.defineProperty(this, "api", { value: telegram.api });
      }
    },
  };
});
vi.mock("../src/channels/weixin/vendor/api.js", async (original) => ({
  ...(await original<typeof import("../src/channels/weixin/vendor/api.js")>()),
  apiGetFetch: vi.fn(),
  apiPostFetch: vi.fn(),
}));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "router-connect-cli-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const agent = { id: randomUUID(), owner: "@alice:example.test" },
    checkpoints = new Map<string, unknown>();
  let current: any = {
    agentId: agent.id,
    host: {
      url: "https://host.fixture",
      tokenFile: "unused",
      runtimeId: "personal",
      instanceName: "channel-host",
      instructions: "",
    },
    connections: [],
  };
  const owned = (id: string, owner: string) => {
    if (id !== agent.id || owner !== agent.owner)
      throw new Error("agent_not_found");
    return agent;
  };
  const store = new DurableStore(join(directory, "registry.sqlite"), "fixture");
  cleanup.push(() => store.close());
  const service = {
    store,
    owned,
    agents: () => [agent],
    runtime: async () => ({
      connector: {
        store: {
          set: (_collection: string, id: string, value: unknown) =>
            checkpoints.set(id, value),
        },
      },
    }),
  } as unknown as ManagedService;
  const config = {
    agentDirectory: () => directory,
    configuration: () => current,
    assertTelegramAvailable: vi.fn(),
    assertFeishuAvailable: vi.fn(),
    edit: async (owner: string, id: string, update: (value: any) => void) => {
      owned(id, owner);
      const candidate = structuredClone(current);
      update(candidate);
      current = agentChannelConfigSchema.parse(candidate);
    },
  } as unknown as ConnectionConfiguration;
  const setup = new ConnectionSetup(service, config);
  cleanup.push(() => setup.close());
  return {
    setup,
    agent,
    directory,
    checkpoints,
    service, config, store,
    get current() {
      return current;
    },
  };
}
const verified = {
  appId: "fixture-app",
  ownerOpenId: "ou_fixture_owner",
  authorized: true,
  verified: true,
  status: "authorized",
  scope: [],
  userName: "Fixture",
};
const appResult = (appId = "cli_fixture") => ({ client_id: appId, client_secret: "fixture-app-secret",
  user_info: { open_id: "ou_fixture_owner", tenant_brand: "feishu" } }) as any;
const status = (f: ReturnType<typeof fixture>, id: string) => f.setup.status(f.agent.owner, f.agent.id, id);
it("connects messaging after app consent without waiting for personal consent", async () => {
  const f = fixture();
  let completeApp!: () => void;
  const appWait = new Promise<void>((resolve) => { completeApp = resolve; });
  vi.mocked(registerApp).mockImplementation(async (options) => {
    options.onQRCodeReady?.({ url: "https://accounts.feishu.cn/fixture", expireIn: 1800 });
    await appWait;
    return appResult();
  });
  const personal = vi.spyOn(FeishuAccount.prototype, "authorizationLink");
  const job = f.setup.begin(f.agent.owner, f.agent.id, "feishu", { personalTools: true });
  expect(job.state).toBe("application");
  expect(job.qr).toMatch(/^[ █▀▄\n]+$/);
  expect(Date.parse(job.expiresAt) - Date.now()).toBeGreaterThan(1_799_000);
  expect(() => f.setup.status("@bob:example.test", f.agent.id, job.id)).toThrow("agent_not_found");
  completeApp();
  await vi.waitFor(() => expect(status(f, job.id).state).toBe("ready"));
  expect(personal).not.toHaveBeenCalled();
  expect(f.current.connections[0]).toMatchObject({ kind: "feishu", personalTools: true });
  expect(JSON.parse(readFileSync(join(f.directory, "feishu", "credentials.json"), "utf8")).ownerOpenId).toBe("ou_fixture_owner");
  expect(statSync(join(f.directory, "feishu", "app-secret")).mode & 0o777).toBe(0o600);
  expect(registerApp).toHaveBeenCalledWith(expect.objectContaining({ createOnly: true, source: "agent-router", addons: expect.any(Object) }));
  expect(JSON.stringify(f.setup.list(f.agent.owner, f.agent.id))).not.toContain("fixture-app-secret");
  expect(JSON.stringify(f.store.entries("connection_setup_jobs"))).not.toContain("fixture-app-secret");
});
it("preserves unknown creation outcomes and recovers only the explicitly selected existing app", async () => {
  const f = fixture(), marker = join(f.directory, "feishu", "creation-pending.json");
  privateFile(marker, { startedAt: Date.now() - 900_000 });
  const blocked = f.setup.begin(f.agent.owner, f.agent.id, "feishu", {});
  await vi.waitFor(() => expect(status(f, blocked.id)).toMatchObject({ state: "failed", error: "feishu_creation_outcome_unknown",
    recovery: { action: "authorize_existing_app" } }));
  expect(registerApp).not.toHaveBeenCalled();
  vi.mocked(registerApp).mockResolvedValue(appResult());
  const recovered = f.setup.begin(f.agent.owner, f.agent.id, "feishu", { appId: "cli_fixture" });
  await vi.waitFor(() => expect(status(f, recovered.id).state).toBe("ready"));
  expect(registerApp).toHaveBeenCalledWith(expect.objectContaining({ appId: "cli_fixture" }));
  expect(vi.mocked(registerApp).mock.calls[0]![0]).not.toHaveProperty("createOnly");
  expect(existsSync(marker)).toBe(false);
});
it("does not accept a different app from the official registration response", async () => {
  const f = fixture();
  vi.mocked(registerApp).mockResolvedValue(appResult("cli_other"));
  const job = f.setup.begin(f.agent.owner, f.agent.id, "feishu", { appId: "cli_fixture" });
  await vi.waitFor(() => expect(status(f, job.id).error).toBe("feishu_registered_app_mismatch"));
  expect(existsSync(join(f.directory, "feishu", "credentials.json"))).toBe(false);
  expect(f.current.connections).toHaveLength(0);
});
it("reuses durable credentials after binding fails, without another app consent", async () => {
  const f = fixture(), edit = vi.spyOn(f.config, "edit").mockRejectedValueOnce(new Error("host_busy"));
  vi.mocked(registerApp).mockResolvedValue(appResult());
  const first = f.setup.begin(f.agent.owner, f.agent.id, "feishu", { appId: "cli_fixture" });
  await vi.waitFor(() => expect(status(f, first.id)).toMatchObject({ state: "failed", recovery: { action: "retry_binding", appId: "cli_fixture" } }));
  edit.mockRestore();
  const second = f.setup.begin(f.agent.owner, f.agent.id, "feishu", { appId: "cli_fixture" });
  await vi.waitFor(() => expect(status(f, second.id).state).toBe("ready"));
  expect(registerApp).toHaveBeenCalledTimes(1);
});
it("keeps owner-scoped history after restart and marks lost consent polling interrupted", async () => {
  const f = fixture();
  f.store.set("connection_setup_jobs", "interrupted", { id: "interrupted", agentId: f.agent.id, kind: "feishu",
    state: "application", appId: "cli_fixture", expiresAt: Date.now() + 900_000, url: "https://accounts.feishu.cn/expired" });
  const restarted = new ConnectionSetup(f.service, f.config);
  const job = restarted.status(f.agent.owner, f.agent.id, "interrupted");
  expect(job).toMatchObject({ state: "failed", error: "connection_setup_interrupted", recovery: { action: "authorize_existing_app", appId: "cli_fixture" } });
  expect(job).not.toHaveProperty("url");
  expect(() => restarted.list("@bob:example.test", f.agent.id)).toThrow("agent_not_found");
  expect(() => restarted.pairing(f.agent.owner, f.agent.id, "interrupted", "123")).toThrow("invalid_pairing_code");
  expect(restarted.list(f.agent.owner, f.agent.id)).toHaveLength(1);
});
it("rejects apps assigned elsewhere before invoking registration", async () => {
  const f = fixture();
  vi.mocked(f.config.assertFeishuAvailable).mockImplementation(() => { throw new Error("feishu_app_already_connected"); });
  const job = f.setup.begin(f.agent.owner, f.agent.id, "feishu", { appId: "cli_fixture" });
  await vi.waitFor(() => expect(status(f, job.id).error).toBe("feishu_app_already_connected"));
  expect(registerApp).not.toHaveBeenCalled();
});
it("honors the SDK's longer deadline and rejects late results after shutdown", async () => {
  const f = fixture();
  let complete!: () => void;
  const wait = new Promise<void>(resolve => { complete = resolve; });
  vi.mocked(registerApp).mockImplementation(async options => {
    options.onQRCodeReady?.({ url: "https://accounts.feishu.cn/fixture", expireIn: 1800 });
    await wait;
    return appResult();
  });
  const job = f.setup.begin(f.agent.owner, f.agent.id, "feishu", {});
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(660_000);
  expect(vi.mocked(registerApp).mock.calls[0]![0].signal!.aborted).toBe(false);
  expect(f.setup.begin(f.agent.owner, f.agent.id, "feishu", {}).id).toBe(job.id);
  const closing = f.setup.close();
  complete(); await closing;
  vi.useRealTimers();
  expect(status(f, job.id).state).toBe("failed");
  expect(existsSync(join(f.directory, "feishu", "credentials.json"))).toBe(false);
});
it("binds Telegram only after the one-use private /start proof and checkpoints consumed updates", async () => {
  const f = fixture(),
    token = "123456:" + "T".repeat(30);
  let calls = 0,
    setupId = "";
  telegram.api = {
    getMe: async () => ({ id: 123456, username: "fixture_bot" }),
    getWebhookInfo: async () => ({ url: "" }),
    getUpdates: async () => {
      calls++;
      const link = f.setup.status(f.agent.owner, f.agent.id, setupId).url!,
        nonce = new URL(link).searchParams.get("start");
      if (calls === 1)
        return [
          {
            update_id: 1,
            message: {
              chat: { type: "private" },
              from: { id: 111, is_bot: false },
              text: "/start wrong-proof",
            },
          },
        ];
      return [
        {
          update_id: 2,
          message: {
            chat: { type: "group" },
            from: { id: 222, is_bot: false },
            text: "/start " + nonce,
          },
        },
        {
          update_id: 3,
          message: {
            chat: { type: "private" },
            from: { id: 333, is_bot: false },
            text: "/start " + nonce,
          },
        },
      ];
    },
  };
  const job = f.setup.begin(f.agent.owner, f.agent.id, "telegram", { token });
  setupId = job.id;
  await vi.waitFor(() =>
    expect(f.setup.status(f.agent.owner, f.agent.id, job.id).state).toBe(
      "ready",
    ),
  );
  expect(f.current.connections[0].ownerAddresses).toEqual(["333"]);
  expect(f.checkpoints.get(key("telegram", "update"))).toBe(3);
  expect(readFileSync(join(f.directory, "telegram-token"), "utf8")).toBe(token);
  expect(f.current.connections[0].groupIds).toEqual([]);
  expect(JSON.stringify(f.setup.list(f.agent.owner, f.agent.id))).not.toContain(
    token,
  );
});
it("uses Tencent QR redirects and terminal pairing codes, rejecting unrelated API origins", async () => {
  const f = fixture();
  vi.mocked(apiPostFetch).mockResolvedValue(
    JSON.stringify({
      qrcode: "fixture-code",
      qrcode_img_content: "https://ilinkai.weixin.qq.com/fixture-code",
    }),
  );
  let count = 0;
  vi.mocked(apiGetFetch).mockImplementation(async (params) => {
    count++;
    if (count === 1)
      return JSON.stringify({
        status: "scaned_but_redirect",
        redirect_host: "regional.weixin.qq.com",
      });
    if (count === 2) return JSON.stringify({ status: "need_verifycode" });
    expect(params.baseUrl).toBe("https://regional.weixin.qq.com");
    expect(params.endpoint).toContain("verify_code=456789");
    return JSON.stringify({
      status: "confirmed",
      bot_token: "fixture-weixin-token",
      ilink_bot_id: "fixture-bot",
      ilink_user_id: "fixture-owner",
      baseurl: "https://regional.weixin.qq.com",
    });
  });
  const job = f.setup.begin(f.agent.owner, f.agent.id, "weixin", {});
  await vi.waitFor(
    () =>
      expect(f.setup.status(f.agent.owner, f.agent.id, job.id).state).toBe(
        "pairing",
      ),
    { timeout: 3000 },
  );
  f.setup.pairing(f.agent.owner, f.agent.id, job.id, "456789");
  await vi.waitFor(
    () =>
      expect(f.setup.status(f.agent.owner, f.agent.id, job.id).state).toBe(
        "ready",
      ),
    { timeout: 3000 },
  );
  expect(
    JSON.parse(readFileSync(join(f.directory, "weixin.json"), "utf8")),
  ).toMatchObject({
    userId: "fixture-owner",
    baseUrl: "https://regional.weixin.qq.com",
  });
  expect(JSON.stringify(f.setup.list(f.agent.owner, f.agent.id))).not.toContain(
    "fixture-weixin-token",
  );
  const malicious = fixture();
  vi.mocked(apiGetFetch).mockResolvedValue(
    JSON.stringify({
      status: "scaned_but_redirect",
      redirect_host: "evil.fixture",
    }),
  );
  const bad = malicious.setup.begin(
    malicious.agent.owner,
    malicious.agent.id,
    "weixin",
    {},
  );
  await vi.waitFor(() =>
    expect(
      malicious.setup.status(malicious.agent.owner, malicious.agent.id, bad.id),
    ).toMatchObject({ state: "failed", error: "invalid_weixin_api_origin" }),
  );
  expect(malicious.current.connections).toHaveLength(0);
}, 8000);
it("does not save credentials if a canceled Weixin request returns late", async () => {
  const f = fixture();
  vi.mocked(apiPostFetch).mockResolvedValue(
    JSON.stringify({
      qrcode: "fixture-code",
      qrcode_img_content: "https://ilinkai.weixin.qq.com/fixture-code",
    }),
  );
  let release!: (value: string) => void;
  vi.mocked(apiGetFetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const job = f.setup.begin(f.agent.owner, f.agent.id, "weixin", {});
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.setup.close();
  release(
    JSON.stringify({
      status: "confirmed",
      bot_token: "fixture-token",
      ilink_bot_id: "fixture-bot",
      ilink_user_id: "fixture-owner",
    }),
  );
  await vi.waitFor(() =>
    expect(f.setup.status(f.agent.owner, f.agent.id, job.id).state).toBe(
      "failed",
    ),
  );
  expect(f.current.connections).toHaveLength(0);
});
it("renders only HTTPS authorization QR links and requires Host before personal authorization", () => {
  expect(() => qrTerminal("javascript:alert(1)")).toThrow(
    "invalid_authorization_url",
  );
  const f = fixture();
  delete f.current.host;
  expect(() =>
    f.setup.begin(f.agent.owner, f.agent.id, "feishu", { personalTools: true }),
  ).toThrow("select_host_before_personal_tools");
  expect(registerApp).not.toHaveBeenCalled();
});

it("reuses confirmed Weixin consent after an interrupted configuration without a second QR login", async () => {
  const f = fixture();
  const { privateFile } = await import("../src/services/feishu/cli.js");
  privateFile(join(f.directory, "weixin.json"), {accountId: "fixture-bot", userId: "fixture-owner", token: "fixture-weixin-token", baseUrl: "https://ilinkai.weixin.qq.com"});
  const job = f.setup.begin(f.agent.owner, f.agent.id, "weixin", {});
  await vi.waitFor(() => expect(f.setup.status(f.agent.owner, f.agent.id, job.id).state).toBe("ready"));
  expect(apiPostFetch).not.toHaveBeenCalled();
  expect(apiGetFetch).not.toHaveBeenCalled();
  expect(f.current.connections[0].kind).toBe("weixin");
});

it("rejects a reserved connection ID before creating an app and preserves the existing channel", () => {
  const f = fixture();
  f.current.connections.push({id: "feishu", kind: "matrix", ownerAddresses: [], peerAddresses: [], groupIds: []});
  expect(() => f.setup.begin(f.agent.owner, f.agent.id, "feishu", {})).toThrow("connection_id_already_used");
  expect(registerApp).not.toHaveBeenCalled();
  expect(f.current.connections[0].kind).toBe("matrix");
});

it("reconciles a binding committed immediately before the process was interrupted", async () => {
  const f = fixture();
  f.current.connections.push({ id: "feishu", kind: "feishu" });
  f.store.set("connection_setup_jobs", "committed", { id: "committed", agentId: f.agent.id, kind: "feishu", state: "binding", expiresAt: Date.now() });
  const restarted = new ConnectionSetup(f.service, f.config);
  expect(restarted.status(f.agent.owner, f.agent.id, "committed").state).toBe("ready");
});
it("reports SDK expiry with a recoverable existing-app action and no provider diagnostics", async () => {
  const f = fixture();
  vi.mocked(registerApp).mockRejectedValue({ code: "expired_token", description: "sensitive provider diagnostics" });
  const job = f.setup.begin(f.agent.owner, f.agent.id, "feishu", { appId: "cli_fixture" });
  await vi.waitFor(() => expect(status(f, job.id)).toMatchObject({ error: "feishu_authorization_expired", recovery: { action: "authorize_existing_app" } }));
  expect(JSON.stringify(status(f, job.id))).not.toContain("sensitive");
});

it("reserves an existing app during consent so a second Agent cannot reauthorize it concurrently", async () => {
  const f = fixture(), other = { id: randomUUID(), owner: f.agent.owner };
  vi.spyOn(f.service, "owned").mockImplementation((id, owner) => {
    if (owner !== f.agent.owner) throw new Error("agent_not_found");
    return (id === other.id ? other : f.agent) as any;
  });
  vi.spyOn(f.config, "agentDirectory").mockImplementation(id => id === other.id ? join(f.directory, "other") : f.directory);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(registerApp).mockImplementation(async () => { await pending; return appResult(); });
  const first = f.setup.begin(f.agent.owner, f.agent.id, "feishu", { appId: "cli_fixture" });
  const second = f.setup.begin(other.owner, other.id, "feishu", { appId: "cli_fixture" });
  await vi.waitFor(() => expect(f.setup.status(other.owner, other.id, second.id).error).toBe("feishu_app_setup_in_progress"));
  expect(registerApp).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(status(f, first.id).state).toBe("ready"));
});
it("never overwrites saved credentials for a different requested app", async () => {
  const f = fixture(), directory = join(f.directory, "feishu");
  privateFile(join(directory, "app-secret"), "original-secret");
  privateFile(join(directory, "credentials.json"), { version: 1, appId: "cli_original", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_owner" });
  const job = f.setup.begin(f.agent.owner, f.agent.id, "feishu", { appId: "cli_other" });
  await vi.waitFor(() => expect(status(f, job.id)).toMatchObject({ error: "feishu_saved_app_mismatch", recovery: { appId: "cli_original" } }));
  expect(registerApp).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "app-secret"), "utf8")).toBe("original-secret");
  expect(f.current.connections).toHaveLength(0);
});
