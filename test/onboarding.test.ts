import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
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
  root = "/_agent-router/setup/api";
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
  const tokens = new Map<string, string>(),
    requests: Array<{ url: string; body: any }> = [],
    hostRuns = new Map<string, any>(),
    actualFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.startsWith(config.homeserver)) {
        requests.push({ url, body });
        if (url.endsWith("/login")) {
          if (body.password !== "fixture-password")
            return Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 });
          const owner = "@" + body.identifier.user + ":example.test",
            token = "matrix-fixture-" + randomUUID();
          tokens.set(token, owner);
          return Response.json({ access_token: token, user_id: owner });
        }
        if (url.endsWith("/register")) {
          if (!body.auth)
            return Response.json(
              {
                session: "registration-session",
                flows: [
                  { stages: ["m.login.registration_token", "m.login.dummy"] },
                ],
              },
              { status: 401 },
            );
          if (body.auth.type === "m.login.registration_token") {
            if (body.auth.token !== "fixture-invite")
              return Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 });
            return Response.json(
              {
                session: "registration-session",
                completed: ["m.login.registration_token"],
                flows: [
                  { stages: ["m.login.registration_token", "m.login.dummy"] },
                ],
              },
              { status: 401 },
            );
          }
          const owner = "@" + body.username + ":example.test",
            token = "matrix-fixture-" + randomUUID();
          tokens.set(token, owner);
          return Response.json({ access_token: token, user_id: owner });
        }
        if (url.endsWith("/logout")) {
          tokens.delete(
            new Headers(init?.headers).get("authorization")!.slice(7),
          );
          return Response.json({});
        }
        throw new Error("unexpected_matrix_fixture_request");
      }
      if (url.startsWith("https://host.fixture")) {
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
  privateFile(optionsFile, {
    registration: true,
    hosts: [
      {
        id: "personal",
        label: "Personal",
        url: "https://host.fixture",
        tokenFile: "host-token",
        runtimeId: "personal",
        owners: [alice],
      },
      {
        id: "other",
        label: "Other",
        url: "https://host.fixture",
        tokenFile: "host-token",
        runtimeId: "other",
        owners: [alice],
      },
    ],
  });
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
  const browser = createOnboarding(service, settings);
  app.use(createManagedApp(service, browser.router));
  cleanup.push(() => browser.close());
  function client() {
    let cookie = "";
    return {
      get cookie() {
        return cookie;
      },
      async api(
        path: string,
        body?: unknown,
        headers: Record<string, string> = {},
      ) {
        const response = await fetch(base + root + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "X-Agent-Router-UI": "1",
            Origin: base,
            Cookie: cookie,
            "Content-Type": "application/json",
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.headers.has("set-cookie"))
          cookie = response.headers.get("set-cookie")!.split(";")[0]!;
        return {
          status: response.status,
          data:
            response.status === 204 ? null : ((await response.json()) as any),
          headers: response.headers,
        };
      },
      async login(username: string) {
        expect(
          (
            await this.api("/auth/login", {
              username,
              password: "fixture-password",
            })
          ).status,
        ).toBe(200);
        return (await this.api("/session")).data;
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
  };
}
describe("browser onboarding", () => {
  it("keeps native interaction answers under the owner and directs secrets to the Host", async () => {
    const f = await fixture(),
      a = f.client(),
      b = f.client();
    await a.login("alice");
    await b.login("bob");
    const agent = (await a.api("/agents", { name: "helper" })).data.agent;
    const calls = [
      {
        id: "approval",
        runId: "fixture",
        kind: "interaction",
        name: "permission",
        status: "pending",
        deadlineAt: "2099-01-01T00:00:00Z",
        input: {
          command: "git status",
          toolUseID: "fixture-tool",
          input: { command: "git status" },
        },
      },
      {
        id: "secret",
        runId: "fixture",
        kind: "interaction",
        name: "vault.password",
        status: "pending",
        deadlineAt: "2099-01-01T00:00:00Z",
        input: {},
      },
    ];
    const resolve = vi.fn();
    await f.service.configureRuntime(agent.id, async () => ({
      start: async () => {},
      stop: async () => {},
      status: () => ({ host: { calls } }),
      resolve,
      reconcile: async () => {},
      closeUnknown: async () => {},
    }));
    expect((await b.api("/agents/" + agent.id + "/interactions")).status).toBe(
      404,
    );
    const view = (await a.api("/agents/" + agent.id + "/interactions")).data
      .data;
    expect(view[0].text).toContain("git status");
    expect(view[1].sensitive).toBe(true);
    expect(
      (
        await a.api("/agents/" + agent.id + "/interactions/approval/answer", {
          choice: 0,
        })
      ).status,
    ).toBe(204);
    expect(resolve).toHaveBeenCalledWith("approval", {
      behavior: "allow",
      updatedInput: { command: "git status" },
      toolUseID: "fixture-tool",
    });
    expect(
      (
        await a.api("/agents/" + agent.id + "/interactions/secret/answer", {
          text: "never-send-a-secret-here",
        })
      ).data.error,
    ).toBe("native_sensitive_input_required");
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("ships a private, accessible bilingual entry point and requires same-origin requests before login", async () => {
    const f = await fixture(),
      page = await fetch(f.base + "/_agent-router/setup");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).toContain('<html lang="en">');
    expect((await fetch(f.base + "/_agent-router/setup/app.js")).status).toBe(
      200,
    );
    const c = f.client();
    expect(
      (
        await c.api(
          "/auth/login",
          { username: "alice", password: "fixture-password" },
          { Origin: "https://evil.fixture" },
        )
      ).status,
    ).toBe(403);
    expect(f.requests).toHaveLength(0);
    expect((await fetch(f.base + root + "/options")).status).toBe(403);
    expect((await c.api("/session")).status).toBe(401);
    expect(
      (await c.api("/auth/login", { username: "alice", password: "wrong" }))
        .status,
    ).toBe(401);
    const login = await c.api("/auth/login", {
      username: "alice",
      password: "fixture-password",
    });
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(login.headers.get("set-cookie")).not.toContain(
      [...f.tokens.keys()][0],
    );
    const session = await c.api("/session");
    expect(session.data.owner).toBe(alice);
    expect(session.data.caller.name).toBe("client");
    expect(JSON.stringify(session.data)).not.toContain("fixture-host-token");
    expect(JSON.stringify(session.data)).not.toContain(f.directory);
    expect((await c.api("/auth/logout", {})).status).toBe(204);
    expect((await c.api("/session")).status).toBe(401);
    expect(f.tokens.size).toBe(0);
  });
  it("reuses registration-token and dummy UIA stages without maintaining a second account system", async () => {
    const f = await fixture(),
      c = f.client();
    expect(
      (
        await c.api("/auth/register", {
          username: "new-user",
          password: "fixture-password",
        })
      ).data.error,
    ).toBe("registration_token_or_external_client_required");
    const registered = await c.api("/auth/register", {
      username: "new-user",
      password: "fixture-password",
      registrationToken: "fixture-invite",
    });
    expect(registered.status).toBe(201);
    expect((await c.api("/session")).data.owner).toBe("@new-user:example.test");
    const requests = f.requests.filter((request) =>
      request.url.endsWith("/register"),
    );
    expect(requests.at(-2)?.body.auth).toEqual({
      type: "m.login.registration_token",
      session: "registration-session",
      token: "fixture-invite",
    });
    expect(requests.at(-1)?.body.auth).toEqual({
      type: "m.login.dummy",
      session: "registration-session",
    });
    expect(f.service.agents()).toHaveLength(1);
  });
  it("applies optional connections and operator-approved Hosts, persists them, and protects account boundaries", async () => {
    const f = await fixture(),
      a = f.client(),
      b = f.client();
    await a.login("alice");
    await b.login("bob");
    const agent = (await a.api("/agents", { name: "helper" })).data.agent;
    expect(f.settings.configuration(agent)).toBeUndefined();
    expect((await b.api("/agents/" + agent.id)).status).toBe(404);
    const bAgent = (await b.api("/agents", { name: "helper" })).data.agent;
    expect(
      (await b.api("/agents/" + bAgent.id + "/host", { hostId: "personal" }))
        .status,
    ).toBe(403);
    expect(
      (
        await a.api("/agents/" + agent.id + "/host", {
          hostId: "personal",
          url: "https://evil.fixture",
        })
      ).status,
    ).toBe(400);
    expect(
      (await a.api("/agents/" + agent.id + "/host", { hostId: "personal" }))
        .status,
    ).toBe(200);
    expect(f.settings.configuration(agent)?.connections).toHaveLength(0);
    expect(
      (await a.api("/agents/" + agent.id + "/connections", { kind: "matrix" }))
        .status,
    ).toBe(200);
    const file = join(f.settings.agentDirectory(agent.id), "channels.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restored = new OnboardingConfiguration(
      f.directory,
      join(f.directory, "options.json"),
    );
    expect(restored.configuration(agent)?.host?.runtimeId).toBe("personal");
    expect(restored.configuration(agent)?.connections[0]?.kind).toBe("matrix");
    const live = (await a.api("/agents/" + agent.id)).data.communication;
    expect(live.connections[0].started).toBe(true);
    const checks = (await a.api("/agents/" + agent.id + "/check", {})).data
      .checks;
    expect(
      checks.find((check: any) => check.kind === "matrix").detail,
    ).toContain("real message");
    expect(f.hostRuns.size).toBe(0);
    const runtime = await f.service.runtime(agent.id),
      before = readFileSync(file, "utf8");
    runtime.connector.store.set("communication_runs", "uncertain", {
      phase: "unknown",
    });
    expect(
      (await a.api("/agents/" + agent.id + "/host", { hostId: "other" })).data
        .error,
    ).toBe("agent_has_active_or_unknown_run");
    expect(readFileSync(file, "utf8")).toBe(before);
    runtime.connector.store.delete("communication_runs", "uncertain");
  });
  it("routes a friend's task through the existing Matrix/Host path and never grants them personal tools or management", async () => {
    const f = await fixture(),
      a = f.client(),
      b = f.client();
    const sa = await a.login("alice"),
      sb = await b.login("bob");
    const agent = (await a.api("/agents", { name: "helper" })).data.agent;
    await a.api("/agents/" + agent.id + "/host", { hostId: "personal" });
    const first = {
      address: agent.address,
      text: "remember 42",
      messageId: randomUUID(),
    };
    const task = (await b.api("/chat/send", first)).data;
    expect((await b.api("/chat/send", first)).data.id).toBe(task.id);
    await vi.waitFor(
      async () =>
        expect(
          (await a.api("/agents/" + agent.id + "/requests")).data.data.length,
        ).toBe(1),
      { timeout: 5000 },
    );
    expect(f.hostRuns.size).toBe(0);
    const incoming = (await a.api("/agents/" + agent.id + "/requests")).data
      .data[0];
    expect(
      (
        await b.api(
          "/agents/" + agent.id + "/requests/" + incoming.id + "/decision",
          { decision: "allow" },
        )
      ).status,
    ).toBe(404);
    await a.api(
      "/agents/" + agent.id + "/requests/" + incoming.id + "/decision",
      { decision: "allow" },
    );
    await vi.waitFor(
      async () =>
        expect(
          (
            await b.api(
              "/chat/tasks/" +
                task.id +
                "?address=" +
                encodeURIComponent(agent.address),
            )
          ).data.status.state,
        ).toBe("TASK_STATE_COMPLETED"),
      { timeout: 7000 },
    );
    const result = (
      await b.api(
        "/chat/tasks/" +
          task.id +
          "?address=" +
          encodeURIComponent(agent.address),
      )
    ).data;
    expect(
      result.artifacts
        .flatMap((artifact: any) => artifact.parts)
        .map((part: any) => part.text)
        .join(""),
    ).toBe("Fixture reply: remember 42");
    expect([...f.hostRuns.values()][0].tools).toBeUndefined();
    await a.api("/agents/" + agent.id + "/access", {
      address: sb.caller.address,
      decision: "allow",
    });
    const second = (
      await b.api("/chat/send", {
        address: agent.address,
        text: "continue",
        contextId: task.contextId,
        messageId: randomUUID(),
      })
    ).data;
    expect(second.contextId).toBe(task.contextId);
    await vi.waitFor(
      async () =>
        expect(
          (
            await b.api(
              "/chat/tasks/" +
                second.id +
                "?address=" +
                encodeURIComponent(agent.address),
            )
          ).data.status.state,
        ).toBe("TASK_STATE_COMPLETED"),
      { timeout: 7000 },
    );
    expect([...f.hostRuns.values()][1].sessionId).toBe(
      [...f.hostRuns.values()][0].sessionId,
    );
    const own = (
      await a.api("/chat/send", {
        address: agent.address,
        text: "owner task",
        messageId: randomUUID(),
      })
    ).data;
    await vi.waitFor(
      async () =>
        expect(
          (
            await a.api(
              "/chat/tasks/" +
                own.id +
                "?address=" +
                encodeURIComponent(agent.address),
            )
          ).data.status.state,
        ).toBe("TASK_STATE_COMPLETED"),
      { timeout: 7000 },
    );
    expect([...f.hostRuns.values()][2].tools[0].name).toBe("channel");
    const runtime = await f.service.runtime(agent.id);
    expect(
      runtime.connector.store.get(
        "communication_owner_callers",
        sb.caller.matrixId,
      ),
    ).toBeUndefined();
    expect(
      runtime.connector.store.get(
        "communication_owner_callers",
        sa.caller.matrixId,
      ),
    ).toBe(true);
    const before = readFileSync(
      join(f.settings.agentDirectory(agent.id), "channels.json"),
      "utf8",
    );
    expect(
      (await a.api("/agents/" + agent.id + "/host", { hostId: "other" })).data
        .error,
    ).toBe("host_binding_configuration_changed");
    expect(
      readFileSync(
        join(f.settings.agentDirectory(agent.id), "channels.json"),
        "utf8",
      ),
    ).toBe(before);
    expect(
      (await a.api("/agents/" + agent.id)).data.communication.host.runtimeId,
    ).toBe("personal");
    expect(f.hostRuns.size).toBe(3);
  }, 25000);
  it("creates one-use browser handoffs through the SDK, keeps credentials out of URLs and rechecks session revocation", async () => {
    const f = await fixture(),
      a = f.client();
    await a.login("alice");
    const token = [...f.tokens.keys()][0]!;
    const sdk = new AgentRouterClient({
      baseUrl: f.config.publicUrl,
      accessToken: token,
      allowLocalHTTP: true,
    });
    const link = await sdk.onboardingLink();
    expect(link.url).not.toContain(token);
    expect(new URL(link.url).search).toBe("");
    const ticket = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
        "ticket",
      ),
      b = f.client();
    expect((await b.api("/auth/redeem", { ticket })).status).toBe(200);
    expect((await b.api("/session")).data.owner).toBe(alice);
    expect((await f.client().api("/auth/redeem", { ticket })).status).toBe(401);
    const expired = await sdk.onboardingLink(),
      original = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => original() + 61_000);
    expect(
      (
        await f.client().api("/auth/redeem", {
          ticket: new URLSearchParams(new URL(expired.url).hash.slice(1)).get(
            "ticket",
          ),
        })
      ).status,
    ).toBe(401);
    vi.restoreAllMocks();
    f.tokens.delete(token);
    expect((await b.api("/session")).status).toBe(401);
    const worker = f.service.issue(
      f.service.agents(alice)[0]!.id,
      "fixture-worker",
    );
    const unauthorized = new AgentRouterClient({
      baseUrl: f.config.publicUrl,
      accessToken: worker.token,
      allowLocalHTTP: true,
    });
    await expect(unauthorized.onboardingLink()).rejects.toMatchObject({
      status: 401,
    });
  });
});
