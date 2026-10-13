import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import {
  ManagedService,
  createManagedApp,
} from "@agent-router/server/dist/matrix/managed.js";
import { OnboardingConfiguration } from "@agent-router/server/dist/onboarding/configuration.js";
import { createOnboarding } from "@agent-router/server/dist/onboarding/routes.js";
import { count, close } from "./cloud-driver.mjs";
const root = await mkdtemp(join(tmpdir(), "cloud-bootstrap-"));
const owner = "@alice:example.test";
let service, settings, setup, server;
const allocation = createServer().listen(0, "127.0.0.1");
await new Promise((r) => allocation.once("listening", r));
const port = allocation.address().port;
await new Promise((r) => allocation.close(r));
const directory = join(root, "remote"),
  profile = join(root, "profile.json"),
  provider = join(root, "providers.json"),
  options = join(root, "onboarding.json"),
  logs = join(root, "native-requests.jsonl");
async function save(path, value) {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
async function open() {
  settings = new OnboardingConfiguration(join(root, "router"), options);
  service = new ManagedService(
    {
      serverName: "example.test",
      homeserver: "https://matrix.fixture",
      publicUrl: "https://example.test/_agent-router/v1",
      stateDir: join(root, "router"),
      asToken: "a".repeat(48),
      hsToken: "h".repeat(48),
    },
    {
      authenticate: async (token) => {
        assert.equal(token, "fixture-owner");
        return owner;
      },
      provision: async () => {},
      configure: settings.factory,
      transport: (agent) => ({
        identity: async () => agent.matrixId,
        sync: async (since) => {
          await new Promise((r) => setTimeout(r, 10));
          return { next_batch: since ?? "0" };
        },
        state: async () => [],
        history: async () => ({ events: [] }),
        createRoom: async () => "!fixture:example.test",
        join: async () => {},
        send: async () => "$fixture",
        stop: () => {},
      }),
    },
  );
  settings.attach(service);
  setup = createOnboarding(service, settings);
  const app = express();
  // Existing owner session verification stays in the Matrix authentication boundary.
  app.get("/_matrix/client/v3/account/whoami", (_req, res) =>
    res.json({ user_id: owner }),
  );
  app.use(createManagedApp(service, setup.router));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  await service.start();
  return "http://127.0.0.1:" + server.address().port;
}
async function shutdown() {
  await setup?.close();
  await service?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    server = undefined;
  }
}
try {
  await save(profile, {
    stateDirectory: join(directory, "state"),
    port,
    runtimes: [
      {
        id: "personal",
        kernel: "codex",
        cwd: root,
        command: process.execPath,
        args: [process.argv[3]],
        env: { CODEX_TEST_LOG: logs },
      },
    ],
  });
  await save(provider, { root, directory, port });
  await save(options, {
    environments: {
      configFile: provider,
      modulePath: resolve("cloud-driver.mjs"),
      profiles: [
        {
          id: "cloud",
          label: "Cloud",
          owners: [owner],
          provider: "volc",
          template: "fixture",
          kernel: "codex",
          runtimeId: "personal",
          hostConfigFile: profile,
          directory,
          port,
        },
      ],
    },
  });
  let base = await open();
  const configDir = join(root, "cli");
  async function session() {
    await save(join(configDir, "owner", "session.json"), {
      version: 1,
      homeserver: base,
      userId: owner,
      deviceId: "fixture-device",
      accessToken: "fixture-owner",
      gatewayToken: "g".repeat(64),
      connectorUrl: "http://127.0.0.1:8787",
    });
  }
  await session();
  const cli = async (...args) => {
    const r = await promisify(execFile)(
      process.argv[2],
      [
        "--profile",
        "owner",
        "--allow-http",
        "--service-url",
        base + "/_agent-router/v1",
        ...args,
      ],
      { env: { ...process.env, MATRIX_CONFIG_DIR: configDir }, timeout: 30000 },
    );
    assert.ok(!r.stdout.includes("fixture-private-cloud-key"));
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const result = await cli("setup", "helper", "--environment", "cloud");
  assert.equal(result.configuration.environment.state, "ready");
  assert.equal(result.checks[0].status, "verified");
  assert.equal(count(), 1);
  const agent = result.configuration.agent;
  async function turn(text, contextId) {
    const runtime = await service.runtime(agent.id);
    const request = SendMessageRequest.fromJSON({
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ text }],
        ...(contextId ? { contextId } : {}),
      },
      configuration: { returnImmediately: true },
    });
    const task = await runtime.connector.cli.send(request, {
      sender: owner,
      room: "!fixture:example.test",
      approved: true,
    });
    for (let n = 0; n < 300; n++) {
      const current = await runtime.connector.cli.get(task.id);
      if (current.status.state === TaskState.TASK_STATE_COMPLETED)
        return current;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Host worker did not complete");
  }
  const first = await turn("first cloud turn");
  assert.ok(JSON.stringify(first.artifacts).includes("first cloud turn"));
  assert.equal((await cli("environment-pause")).state, "paused");
  await shutdown();
  base = await open();
  await session();
  // The service origin changed only because this is a loopback fixture restart.
  await cli("agent-use", "helper");
  assert.equal((await cli("environment-status")).state, "paused");
  assert.equal((await cli("environment-resume")).state, "ready");
  const second = await turn("continue cloud turn", first.contextId);
  assert.ok(JSON.stringify(second.artifacts).includes("continue cloud turn"));
  assert.equal(count(), 1);
  const native = (await readFile(logs, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(native.filter((r) => r.method === "thread/start").length, 1);
  assert.ok(native.some((r) => r.method === "thread/resume"));
  assert.equal((await cli("environment-destroy")).state, "deleted");
  console.log(
    "PASS: independent Router/Environment/Host archives, Go CLI setup, verified bootstrap, worker reply, Router + Host restart, same conversation resume, and explicit destruction. Cloud lifecycle and Codex protocol are fixtures; no cloud/model acceptance is implied.",
  );
} finally {
  await shutdown();
  await close();
  await rm(root, { recursive: true, force: true });
}
