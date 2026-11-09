import { afterEach, describe, expect, it } from "vitest";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BarkChannel, barkChannel } from "../src/channels/bark/index.js";
import { encrypt } from "../src/channels/bark/channel.js";
import { ChannelSendError } from "../src/channels/api.js";
import { channelConfigSchema, channelFiles } from "../src/service/channels.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const route = (purpose: string) => ({ connectionId: "bark", target: "owner", messageId: "", data: { purpose, sessionKey: "c-1" } });
const options = { server: "https://bark.example.test", deviceKey: "device key", title: "Assistant", preview: true, maxLength: 300 };
function recorder(status = 200, body: unknown = { code: 200, message: "success" }) {
  const requests: Array<{ url: string; headers: Headers; fields: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: new Headers(init.headers), fields: Object.fromEntries(new URLSearchParams(String(init.body))) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}
function decrypt(key: string, fields: Record<string, string>) {
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, Buffer.from(key), Buffer.from(fields.iv!));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(fields.ciphertext!, "base64")), decipher.final()]).toString("utf8"));
}

describe("Bark channel", () => {
  it("maps a notification to Bark's push fields: title, cut body, level by purpose and the tap URL", async () => {
    const { requests, fetchImpl } = recorder();
    const channel = new BarkChannel({ ...options, openUrl: "https://console.example.test/chat", maxLength: 20 }, fetchImpl);
    await channel.send(route("reply"), "  " + "答".repeat(40) + "  ");
    await channel.send(route("question"), "要发送这封邮件吗？");
    expect(requests[0]!.url).toBe("https://bark.example.test/device%20key");
    expect(requests[0]!.fields).toEqual({ level: "active", group: "Assistant", title: "Assistant", body: "答".repeat(19) + "…", url: "https://console.example.test/chat" });
    expect(requests[1]!.fields).toMatchObject({ level: "timeSensitive", body: "要发送这封邮件吗？" });
  });

  it("encrypts the content with a fresh IV per push; level and group stay readable for APNs", async () => {
    const { requests, fetchImpl } = recorder(), key = "k".repeat(32);
    const channel = new BarkChannel({ ...options, encryptionKey: key, basicAuth: "bark:secret" }, fetchImpl);
    await channel.send(route("schedule"), "九点开会");
    await channel.send(route("schedule"), "九点开会");
    const [first, second] = requests.map((request) => request.fields);
    expect(Object.keys(first!).sort()).toEqual(["ciphertext", "group", "iv", "level"]);
    expect(first!.iv).toHaveLength(16);
    expect(first!.iv).not.toBe(second!.iv);
    expect(decrypt(key, first!)).toEqual({ title: "Assistant", body: "九点开会" });
    expect(requests[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("bark:secret").toString("base64")}`);
    for (const size of [16, 24]) expect(decrypt("x".repeat(size), encrypt("x".repeat(size), { body: "b" }))).toEqual({ body: "b" });
  });

  it("without preview the body names only the purpose", async () => {
    const { requests, fetchImpl } = recorder();
    await new BarkChannel({ ...options, preview: false }, fetchImpl).send(route("question"), "机票订单号 12345");
    expect(requests[0]!.fields.body).toBe("有问题需要你处理");
  });

  it("classifies failures: rejected is final, overload retries, a lost request is uncertain, an unsent one retries", async () => {
    const failure = async (fetchImpl: typeof fetch) => {
      try { await new BarkChannel(options, fetchImpl).send(route("reply"), "x"); } catch (error) { return error as ChannelSendError; }
      throw new Error("expected a failure");
    };
    expect(await failure(recorder(400, { code: 400, message: "failed to get device token" }).fetchImpl)).toMatchObject({ disposition: "failed", message: "bark_http_400" });
    expect(await failure(recorder(200, { code: 500 }).fetchImpl)).toMatchObject({ disposition: "failed", message: "bark_rejected" });
    expect(await failure(recorder(503).fetchImpl)).toMatchObject({ disposition: "retry", retryAfterMs: 30_000 });
    expect(await failure((async () => { throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }); }) as unknown as typeof fetch))
      .toMatchObject({ disposition: "uncertain" });
    expect(await failure((async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); }) as unknown as typeof fetch))
      .toMatchObject({ disposition: "retry" });
  });

  it("module: send-only config with a default notify policy, file credentials, HTTPS server and a /ping check", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bark-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "device"), "dev-key\n"); writeFileSync(join(directory, "key"), "short\n");
    const files = channelFiles(directory), base = { id: "bark", kind: "bark", deviceKeyFile: "device" };
    const config = barkChannel.schema.parse({ ...base, server: "https://bark.example.test/" });
    expect(config).toMatchObject({ title: "Agent", preview: true, notify: { replies: true, replyAfterSeconds: 30, questions: true, schedules: true } });
    expect(barkChannel.account(config, { agentId: "a", files })).toBe("https://bark.example.test/dev-key");
    expect(barkChannel.validate!({ ...config, ownerAddresses: ["someone"] })).toEqual(["bark_is_send_only"]);
    expect(() => barkChannel.schema.parse({ ...base, server: "http://bark.example.test" })).toThrow();
    expect(() => channelConfigSchema.parse({ agents: [{ agentId: crypto.randomUUID(), connections: [{ ...base, server: "https://b.example.test", groupIds: ["g"] }] }] }))
      .toThrow(/bark_is_send_only/);
    expect(() => barkChannel.create({ ...config, encryptionKeyFile: "key" }, { agentId: "a", owner: "@o:x", files, services: {} })).toThrow("bark_encryption_key_length");
    const created = await barkChannel.create(config, { agentId: "a", owner: "@o:x", files, services: {} });
    expect(created.notify).toEqual(config.notify);

    const seen: IncomingMessage[] = [];
    const server = createServer((req, res) => { seen.push(req); res.end(JSON.stringify(req.url === "/ping" ? { code: 200, message: "pong" } : { code: 404 })); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const local = barkChannel.schema.parse({ ...base, server: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    expect(await barkChannel.check!(local, files)).toMatchObject({ status: "not_verified" });
    expect(seen.map((req) => req.url)).toEqual(["/ping"]);
  });
});
