import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { ConnectionSetup, qrTerminal } from "../src/onboarding/connections.js";
import { FeishuAccount } from "../src/services/feishu/cli.js";
import {
  apiGetFetch,
  apiPostFetch,
} from "../src/channels/weixin/vendor/api.js";
import type { ManagedService } from "../src/matrix/managed.js";
import type { OnboardingConfiguration } from "../src/onboarding/configuration.js";
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
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
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
  const service = {
    owned,
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
    edit: async (owner: string, id: string, update: (value: any) => void) => {
      owned(id, owner);
      const candidate = structuredClone(current);
      update(candidate);
      current = agentChannelConfigSchema.parse(candidate);
    },
  } as unknown as OnboardingConfiguration;
  const setup = new ConnectionSetup(service, config);
  cleanup.push(() => setup.close());
  return {
    setup,
    agent,
    directory,
    checkpoints,
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
it("uses separate official app and personal consent steps and returns only consent URLs", async () => {
  const f = fixture();
  let completeApp!: () => void, completeUser!: () => void;
  const appWait = new Promise<void>((resolve) => {
      completeApp = resolve;
    }),
    userWait = new Promise<void>((resolve) => {
      completeUser = resolve;
    });
  vi.mocked(registerApp).mockImplementation(async (options) => {
    options.onQRCodeReady?.({
      url: "https://accounts.feishu.cn/fixture",
      expireIn: 600,
    });
    await appWait;
    return {
      client_id: "fixture-app",
      client_secret: "fixture-app-secret",
      user_info: { open_id: "ou_fixture_owner", tenant_brand: "feishu" },
    } as any;
  });
  vi.spyOn(FeishuAccount.prototype, "status").mockResolvedValue({
    ...verified,
    authorized: false,
    verified: false,
    status: "missing",
  });
  vi.spyOn(FeishuAccount.prototype, "authorizationLink").mockResolvedValue(
    "https://accounts.feishu.cn/personal-fixture",
  );
  vi.spyOn(FeishuAccount.prototype, "complete").mockImplementation(async () => {
    await userWait;
    return verified;
  });
  const job = f.setup.begin(f.agent.owner, f.agent.id, "feishu", {
    personalTools: true,
  });
  expect(job.state).toBe("application");
  expect(job.qr).toMatch(/^[ █▀▄\n]+$/);
  expect(() => f.setup.status("@bob:example.test", f.agent.id, job.id)).toThrow(
    "agent_not_found",
  );
  expect(JSON.stringify(job)).not.toContain("fixture-app-secret");
  completeApp();
  await vi.waitFor(() =>
    expect(f.setup.status(f.agent.owner, f.agent.id, job.id).state).toBe(
      "authorization",
    ),
  );
  expect(f.setup.status(f.agent.owner, f.agent.id, job.id).url).toContain(
    "personal-fixture",
  );
  expect(f.current.connections).toHaveLength(0);
  completeUser();
  await vi.waitFor(() =>
    expect(f.setup.status(f.agent.owner, f.agent.id, job.id).state).toBe(
      "ready",
    ),
  );
  expect(f.current.connections[0]).toMatchObject({
    kind: "feishu",
    personalTools: true,
  });
  expect(
    JSON.parse(
      readFileSync(join(f.directory, "feishu", "credentials.json"), "utf8"),
    ).ownerOpenId,
  ).toBe("ou_fixture_owner");
  expect(statSync(join(f.directory, "feishu", "app-secret")).mode & 0o777).toBe(
    0o600,
  );
  expect(registerApp).toHaveBeenCalledWith(
    expect.objectContaining({
      createOnly: true,
      source: "agent-router",
      addons: expect.any(Object),
    }),
  );
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
