import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@larksuiteoapi/node-sdk";
import { ServiceHttp } from "../src/channels/http.js";
import { checkChannels } from "../src/service/check.js";
import { channelConfigSchema } from "../src/service/channels.js";
import { FeishuAccount } from "../src/services/feishu/cli.js";

const cleanup: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "router-channel-check-")); cleanup.push(directory);
  writeFileSync(join(directory, "token"), "private-fixture-token");
  writeFileSync(join(directory, "weixin.json"), JSON.stringify({ accountId: "bot", userId: "owner", token: "private-weixin-token", baseUrl: "https://ilinkai.weixin.qq.com" }));
  const configuration = { ...channelConfigSchema.parse({ agents: [{ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    host: { url: "https://host.example.test", tokenFile: "token", runtimeId: "personal" }, connections: [
      { id: "matrix", kind: "matrix" }, { id: "weixin", kind: "weixin", credentialsFile: "weixin.json" },
      { id: "mail", kind: "grove-mail", url: "https://mail.example.test", inboxId: "agent@example.test", apiKeyFile: "token", ownerAddresses: ["owner@example.test"] },
    ] }] }), directory };
  const urls: string[] = []; let runtime = "personal", inbox = "agent@example.test";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url); return new Response(JSON.stringify(url.endsWith("/v1/health") ? { protocolVersion: 1 } :
      url.endsWith("/v1/runtimes") ? { runtimes: [{ id: runtime }] } : { inbox_id: inbox }));
  }));
  return { directory, configuration, urls, wrongRuntime: () => { runtime = "other"; }, wrongInbox: () => { inbox = "other@example.test"; } };
}
it("checks credentials without consuming messages, sending replies or claiming live Weixin/Matrix verification", async () => {
  const f = fixture(), checks = await checkChannels(f.configuration);
  expect(checks.find((c) => c.kind === "host")!.status).toBe("verified");
  expect(checks.find((c) => c.kind === "grove-mail")!.status).toBe("verified");
  expect(checks.filter((c) => ["matrix", "weixin"].includes(c.kind)).every((c) => c.status === "not_verified")).toBe(true);
  expect(f.urls).toHaveLength(3); expect(f.urls.every((url) => !/events|getUpdates|runs|reply/.test(url))).toBe(true);
  expect(JSON.stringify(checks)).not.toContain("private-");
});
it("uses Router status to verify startup while preserving the need for a real message", async () => {
  const f = fixture(), node = new ServiceHttp("https://router.example.test", "private-owner-token", async () => new Response(JSON.stringify({ connections: [
    { id: "matrix", started: true, error: null }, { id: "weixin", started: true, error: null }, { id: "mail", started: true, error: "mail_cursor_expired" },
  ] })));
  const checks = await checkChannels(f.configuration, node);
  expect(checks.find((c) => c.kind === "matrix")).toMatchObject({ status: "verified", detail: expect.stringContaining("real message") });
  expect(checks.find((c) => c.kind === "weixin")!.status).toBe("verified");
  expect(checks.find((c) => c.kind === "grove-mail")!.status).toBe("needs_action");
});
it("rejects a valid Host service whose configured runtime does not exist", async () => {
  const f = fixture(); f.wrongRuntime();
  expect((await checkChannels(f.configuration)).find((c) => c.kind === "host")!.status).toBe("needs_action");
});
it("rejects malformed Weixin credentials using the same rules as service startup", async () => {
  const f = fixture(); writeFileSync(join(f.directory, "weixin.json"), JSON.stringify({ accountId: "bot", userId: "owner", token: "private-weixin-token", baseUrl: "https://secret:password@ilinkai.weixin.qq.com" }));
  const checked = (await checkChannels(f.configuration)).find((c) => c.kind === "weixin")!;
  expect(checked.status).toBe("needs_action"); expect(JSON.stringify(checked)).not.toContain("password");
});
it("does not accept access to a different mailbox as proof of the configured inbox", async () => {
  const f = fixture(); f.wrongInbox();
  expect((await checkChannels(f.configuration)).find((c) => c.kind === "grove-mail")!.status).toBe("needs_action");
});
it("requires personal authorization separately from a valid Feishu bot", async () => {
  const f = fixture();
  writeFileSync(join(f.directory, "credentials.json"), JSON.stringify({ version: 1, appId: "app", appSecretFile: "token", domain: "feishu", ownerOpenId: "ou_owner" }));
  f.configuration.agents[0]!.connections = channelConfigSchema.parse({ agents: [{ ...f.configuration.agents[0], connections: [
    { id: "feishu", kind: "feishu", credentialsFile: "credentials.json", personalTools: true },
  ] }] }).agents[0]!.connections;
  vi.spyOn(Client.prototype, "request").mockResolvedValue({ code: 0, bot: { open_id: "bot" } });
  vi.spyOn(FeishuAccount.prototype, "status").mockResolvedValue({ appId: "app", ownerOpenId: "ou_owner", authorized: false, verified: false, status: "missing", scope: [], userName: "" });
  const checks = await checkChannels(f.configuration);
  expect(checks.find((c) => c.kind === "feishu")!.status).toBe("verified");
  expect(checks.find((c) => c.kind === "feishu_personal")!.status).toBe("needs_action");
  vi.mocked(FeishuAccount.prototype.status).mockRejectedValueOnce(new Error("CLI unavailable"));
  expect((await checkChannels(f.configuration)).find((c) => c.kind === "feishu")!.status).toBe("verified");
});

it("reports missing messaging connections even when the Host passes", async () => {
  const f = fixture(); f.configuration.agents[0]!.connections = [];
  const checks = await checkChannels(f.configuration);
  expect(checks.find(c => c.kind === "host")!.status).toBe("verified");
  expect(checks.find(c => c.kind === "connections")!.status).toBe("not_verified");
});
