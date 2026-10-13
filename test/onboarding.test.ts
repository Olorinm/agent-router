import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ManagedService,
  createManagedApp,
  type ManagedAgent,
} from "../src/matrix/managed.js";
import type { ApplicationInbox } from "../src/matrix/application-service.js";
import type { MatrixTransport } from "../src/matrix/transport.js";
import type { RoomEvent } from "../src/matrix/protocol.js";
import { WorkError } from "../src/matrix/cli-work.js";
import { OnboardingConfiguration } from "../src/onboarding/configuration.js";
import { createOnboarding } from "../src/onboarding/routes.js";
import { privateFile } from "../src/services/feishu/cli.js";
import { AgentRouterClient } from "../packages/sdk/src/index.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const alice = "@alice:example.test",
  bob = "@bob:example.test",
  root = "/_agent-router/v1";
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "router-onboarding-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const config = {
    serverName: "example.test",
    homeserver: "https://matrix.fixture",
    publicUrl: "http://127.0.0.1/_agent-router/v1",
    stateDir: directory,
    asToken: "a".repeat(48),
    hsToken: "h".repeat(48),
  };
  const tokens = new Map<string, string>([["fixture-alice", alice], ["fixture-bob", bob]]),
    requests: Array<{ url: string; body: any }> = [],
    hostRuns = new Map<string, any>(),
    actualFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (new URL(url).origin === "https://host.fixture") {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fixture-host-token",
        );
        requests.push({ url, body });
        if (url.endsWith("/health"))
          return Response.json({ protocolVersion: 1 });
        if (url.endsWith("/runtimes/inspect"))
          return Response.json({ id: body.runtimeId, available: true });
        if (url.endsWith("/runtimes"))
          return Response.json({
            runtimes: [{ id: "personal" }, { id: "other" }],
          });
        if (url.endsWith("/runs") && init?.method === "POST") {
          const run = {
            ...body,
            id: randomUUID(),
            status: "completed",
            answer: "Fixture reply: " + body.input,
          };
          hostRuns.set(run.id, run);
          return Response.json(run, { status: 202 });
        }
        if (url.includes("/events?"))
          return Response.json({
            events: [],
            cursor: 0,
            hasMore: false,
            historyTruncated: false,
          });
        if (url.includes("/runs/"))
          return Response.json(hostRuns.get(url.split("/").at(-1)!));
        throw new Error("unexpected_host_fixture_request");
      }
      if (new URL(url).hostname !== "127.0.0.1")
        throw new Error("unexpected_external_request");
      return actualFetch(input, init);
    },
  );
  const history = new Map<string, RoomEvent[]>();
  let inbox: ApplicationInbox;
  const deliver = (room: string, event: RoomEvent) => {
    const events = history.get(room) ?? [];
    events.push(event);
    history.set(room, events);
    inbox.receive(randomUUID(), { events: [{ ...event, room_id: room }] });
  };
  function transport(
    agent: ManagedAgent,
    box: ApplicationInbox,
  ): MatrixTransport {
    inbox = box;
    return {
      identity: async () => agent.matrixId,
      sync: async (since) => {
        await new Promise((r) => setTimeout(r, 10));
        return box.next(agent.id, since) ?? { next_batch: since ?? "0" };
      },
      state: async (room) => history.get(room) ?? [],
      history: async () => ({ events: [] }),
      createRoom: async (target) => {
        const room = "!" + randomUUID() + ":example.test";
        for (const user of [agent.matrixId, target])
          deliver(room, {
            event_id: "$" + randomUUID(),
            type: "m.room.member",
            sender: user,
            state_key: user,
            content: { membership: "join" },
          });
        return room;
      },
      join: async () => {},
      send: async (room, type, content) => {
        const id = "$" + randomUUID();
        deliver(room, { event_id: id, type, sender: agent.matrixId, content });
        return id;
      },
      stop: () => {},
    };
  }
  const optionsFile = join(directory, "options.json");
  privateFile(join(directory, "host-token"), "fixture-host-token");
  privateFile(optionsFile, {});
  const settings = new OnboardingConfiguration(directory, optionsFile);
  const service = new ManagedService(config, {
    transport,
    provision: async () => {},
    authenticate: async (token) => {
      const owner = tokens.get(token);
      if (!owner) throw new WorkError("account_session_invalid", 401);
      return owner;
    },
    configure: settings.factory,
  });
  settings.attach(service);
  cleanup.push(() => service.close());
  const app = express(),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  config.publicUrl = base + "/_agent-router/v1";
  const setup = createOnboarding(service, settings);
  app.get("/_matrix/client/v3/account/whoami", (req, res) => {
    const owner = tokens.get(req.get("authorization")?.slice(7) ?? "");
    if (!owner) {res.status(401).json({errcode: "M_UNKNOWN_TOKEN"}); return;}
    res.json({user_id: owner});
  });
  app.use(createManagedApp(service, setup.router));
  cleanup.push(() => setup.close());
  function client(name: string) {
    return {
      async api(path: string, body?: unknown, token = "fixture-" + name) {
        const response = await fetch(base + root + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {Authorization: "Bearer " + token, "Content-Type": "application/json"},
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
        return {status: response.status, data: response.status === 204 ? null : await response.json() as any};
      },
    };
  }
  return {
    directory,
    config,
    base,
    service,
    settings,
    requests,
    hostRuns,
    tokens,
    client,
    host: (agent: ManagedAgent, runtimeId = "personal") => settings.edit(agent.owner, agent.id, config => {
      config.host = { url: "https://host.fixture", tokenFile: join(directory, "host-token"), runtimeId, instanceName: "channel-host", instructions: "" };
    }),
  };
}

describe("managed CLI setup", () => {
  it("requires the existing owner account, limits assigned services and does not serve a UI", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    expect((await fetch(f.base + "/_agent-router/setup")).status).toBe(404);
    expect((await fetch(f.base + root + "/setup")).status).toBe(401);
    const options = (await a.api("/setup")).data;
    expect(options.environments).toEqual([]);
    expect(options).not.toHaveProperty("hosts");
    expect(JSON.stringify(options)).not.toContain("fixture-host-token");
    expect(JSON.stringify(options)).not.toContain(f.directory);
    expect(f.service.agents()).toHaveLength(0);
    const agent = (await a.api("/agents", {name: "helper"})).data;
    expect((await a.api("/agents", {name: "helper"})).data.id).toBe(agent.id);
    const path = "/agents/" + agent.id + "/setup";
    expect((await b.api(path)).status).toBe(404);
    const instance = f.service.issue(agent.id, "worker");
    expect((await a.api(path, undefined, instance.token)).status).toBe(401);
    f.tokens.delete("fixture-alice");
    expect((await a.api(path)).status).toBe(401);
  });
  it("configures an optional Host and Matrix channel, persists private files and protects active work", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    const agent = (await a.api("/agents", {name: "helper"})).data;
    const path = "/agents/" + agent.id + "/setup";
    expect((await a.api(path)).data.connections).toEqual([]);
    const other = (await b.api("/agents", {name: "helper"})).data;
    expect((await a.api(path + "/host", {hostId: "personal"})).status).toBe(404);
    await f.host(agent);
    expect(f.settings.configuration(agent)?.connections).toEqual([]);
    expect((await a.api(path + "/connections", {kind: "matrix"})).status).toBe(200);
    expect((await a.api(path + "/connections", {kind: "matrix"})).status).toBe(409);
    const file = join(f.settings.agentDirectory(agent.id), "channels.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restored = new OnboardingConfiguration(f.directory, join(f.directory, "options.json"));
    expect(restored.configuration(agent)?.host?.runtimeId).toBe("personal");
    expect(restored.configuration(agent)?.connections[0]?.kind).toBe("matrix");
    expect((await a.api(path)).data.communication.connections[0].started).toBe(true);
    const checks = (await a.api(path + "/check", {})).data.checks;
    expect(checks.find((c: any) => c.kind === "matrix").detail).toContain("real message");
    expect(f.hostRuns.size).toBe(0);
    const runtime = await f.service.runtime(agent.id), before = readFileSync(file, "utf8");
    runtime.connector.store.set("communication_runs", "uncertain", {phase: "unknown"});
    await expect(f.host(agent, "other")).rejects.toThrow("agent_has_active_or_unknown_run");
    expect(readFileSync(file, "utf8")).toBe(before);
    runtime.connector.store.delete("communication_runs", "uncertain");
    const original = f.settings.factory;
    await expect(f.service.configureRuntime(agent.id, async () => ({
      start: async () => {throw new Error("fixture_start_failure");}, stop: async () => {},
      status: () => ({}), resolve: async () => {}, reconcile: async () => {}, closeUnknown: async () => {},
    }), original)).rejects.toThrow("fixture_start_failure");
    expect((await a.api(path)).data.communication.connections[0].started).toBe(true);
  });
  it("executes an authorized friend's existing A2A conversation on the selected Host without personal tools", async () => {
    const f = await fixture(), a = f.client("alice"), b = f.client("bob");
    const agent = (await a.api("/agents", {name: "helper"})).data;
    const caller = (await b.api("/agents", {name: "client"})).data;
    await f.host(agent);
    const gateway = "/agents/" + agent.id + "/gateway";
    expect((await b.api(gateway + "/api/contacts", {address: caller.matrixId, receive: "allow", execution: "allow"})).status).toBe(404);
    expect((await a.api(gateway + "/api/contacts", {address: caller.matrixId, note: "Friend", tags: [], receive: "allow", execution: "allow"})).status).toBe(201);
    const sdk = new AgentRouterClient({baseUrl: f.config.publicUrl, accessToken: "fixture-bob", allowLocalHTTP: true});
    const input = {agentId: caller.id, address: agent.address, resolvedTarget: agent, text: "remember 42", messageId: randomUUID()};
    const task = await sdk.send(input);
    expect((await sdk.send(input)).id).toBe(task.id);
    let result: any;
    await vi.waitFor(async () => {
      result = await sdk.get({agentId: caller.id, address: agent.address, resolvedTarget: agent, taskId: task.id});
      expect(result.status.state).toBe("TASK_STATE_COMPLETED");
    }, {timeout: 7000});
    expect(result.artifacts.flatMap((a: any) => a.parts).map((p: any) => p.text).join("")).toBe("Fixture reply: remember 42");
    expect([...f.hostRuns.values()][0].tools).toBeUndefined();
    const second = await sdk.send({...input, text: "continue", contextId: task.contextId, messageId: randomUUID()});
    await vi.waitFor(async () => expect((await sdk.get({agentId: caller.id, address: agent.address, resolvedTarget: agent, taskId: second.id})).status.state).toBe("TASK_STATE_COMPLETED"), {timeout: 7000});
    expect([...f.hostRuns.values()][1].sessionId).toBe([...f.hostRuns.values()][0].sessionId);
    await expect(f.host(agent, "other")).rejects.toThrow("host_binding_configuration_changed");
    expect(f.hostRuns.size).toBe(2);
  }, 20000);
});

const cliBinary = fileURLToPath(new URL("../bin/agent-router", import.meta.url));
it.skipIf(!existsSync(cliBinary))("runs the standalone Go CLI against Router setup, contacts and the A2A Host reply path", async () => {
  const f = await fixture(), configDir = join(f.directory, "cli-profiles");
  for (const name of ["alice", "bob"]) {
    const directory = join(configDir, name);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    privateFile(join(directory, "session.json"), {version: 1, homeserver: f.base,
      userId: "@" + name + ":example.test", deviceId: "fixture-device", accessToken: "fixture-" + name,
      gatewayToken: "g".repeat(64), connectorUrl: "http://127.0.0.1:8787"});
  }
  const cli = async (name: string, ...args: string[]) => {
    const result = await promisify(execFile)(cliBinary, ["--profile", name, "--allow-http", ...args],
      {env: {...process.env, MATRIX_CONFIG_DIR: configDir}, timeout: 15_000});
    expect(result.stdout + result.stderr).not.toContain("fixture-host-token");
    expect(result.stdout + result.stderr).not.toContain("fixture-alice");
    expect(result.stdout + result.stderr).not.toContain("fixture-bob");
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const options = await cli("alice", "setup-options");
  expect(options.environments).toEqual([]);
  const created = await cli("alice", "agent-create", "helper");
  await f.host(f.service.agent(created.id));
  const setup = await cli("alice", "setup", "helper");
  expect(setup.configuration.connections).toEqual([]);
  expect(setup.checks[0].status).toBe("verified");
  const target = setup.configuration.agent;
  const caller = await cli("bob", "agent-create", "client");
  await cli("alice", "contact-add", caller.matrixId, "--allow-receive", "--allow-execution");
  const task = await cli("bob", "send", target.matrixId, "Hello from the Go CLI", "--wait", "10");
  expect(String(task.status.state).toLowerCase()).toContain("completed");
  expect(task.artifacts.flatMap((a: any) => a.parts).map((p: any) => p.text).join("")).toBe("Fixture reply: Hello from the Go CLI");
  const next = await cli("bob", "send", target.matrixId, "continue", "--context-id", task.contextId, "--wait", "10");
  expect(next.contextId).toBe(task.contextId);
  expect([...f.hostRuns.values()][1].sessionId).toBe([...f.hostRuns.values()][0].sessionId);
}, 25000);
