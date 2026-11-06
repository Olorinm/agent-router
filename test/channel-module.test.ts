import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunicationCore } from "../src/communication/core.js";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import { HostWorker } from "../src/execution/host-worker.js";
import type { HostPort, HostRun } from "../src/execution/host.js";
import { channelFiles } from "../src/service/channels.js";
import { EchoChannel, echoChannel } from "./fixtures/echo-channel/index.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

class Host implements HostPort {
  identity = "fixture-host";
  runs = new Map<string, HostRun>();
  async connect() {}
  async start(input: Parameters<HostPort["start"]>[0]): Promise<HostRun> {
    const run: HostRun = { id: `run-${this.runs.size + 1}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "completed", answer: "echo: hello" };
    this.runs.set(run.id, run); return run;
  }
  async get(id: string) { return this.runs.get(id)!; }
  async cancel() {}
  async calls() { return []; }
  async resolve() {}
}

it("a channel written only against the public API runs through the core: config, factory, receipt, turn, reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-channel-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "token"), "secret-token\n");
  const files = channelFiles(directory);

  // The module's schema carries the common connection fields; its own validation reports issue codes.
  const config = echoChannel.schema.parse({ id: "echo", kind: "echo", tokenFile: "token", ownerAddresses: ["owner"] });
  expect(echoChannel.validate?.({ ...config, groupIds: ["g"] }, { host: false })).toEqual(["echo_supports_direct_chats_only"]);
  expect(echoChannel.account(config, { agentId: "agent", files })).toBe("secret-token");
  expect(await echoChannel.check?.(config, files)).toMatchObject({ status: "verified" });

  const store = new DurableStore(":memory:", "agent"); cleanup.push(() => store.close());
  const work = new CliWork(store, () => "allow"), core = new CommunicationCore("agent", store, work);
  const channel = await echoChannel.create(config, { agentId: "agent", owner: "@owner:example.test", files, services: {} });
  const adapter = channel.adapter as EchoChannel;
  core.register({ id: config.id, ownerAddresses: channel.ownerAddresses ?? config.ownerAddresses, peerAddresses: config.peerAddresses,
    groupIds: config.groupIds }, adapter, channel.reload);
  await core.start();

  adapter.deliver({ id: "m1", from: "owner", chat: "dm-1", text: "hello" });
  adapter.deliver({ id: "m2", from: "stranger", chat: "dm-2", text: "let me in" });
  const worker = new HostWorker("agent", "instance", store, work, new Host(), "fixture", "", () => {}, (id, text) => core.saveResult(id, text));
  await core.dispatch(); await worker.tick(); await core.dispatch(); await core.flush();

  expect(adapter.provider.outbound).toEqual([{ chat: "dm-1", text: "echo: hello" }]);
  expect(core.status().connections).toEqual([expect.objectContaining({ id: "echo", kind: "echo", started: true })]);
  await core.stop();
});
