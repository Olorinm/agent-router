// Local UI fixture: no model, real account, IM provider, or external HTTP call.
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagedService, createManagedApp } from "../dist/matrix/managed.js";
import { WorkError } from "../dist/matrix/cli-work.js";
import { privateFile } from "../dist/services/feishu/cli.js";
import { OnboardingConfiguration } from "../dist/onboarding/configuration.js";
import { ConnectionSetup } from "../dist/onboarding/connections.js";
import { createOnboarding } from "../dist/onboarding/routes.js";
const servers = [];
async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return "http://127.0.0.1:" + server.address().port;
}
const directory = mkdtempSync(join(tmpdir(), "agent-router-preview-")),
  tokens = new Map(),
  runs = new Map();
const matrix = express();
matrix.use(express.json());
matrix.post("/_matrix/client/v3/login", (req, res) => {
  if (req.body.password !== "preview")
    return res.status(403).json({ errcode: "M_FORBIDDEN" });
  const user = req.body.identifier.user;
  if (!/^[a-z][a-z0-9-]*$/.test(user))
    return res.status(400).json({ errcode: "M_INVALID_PARAM" });
  const token = randomUUID();
  tokens.set(token, "@" + user + ":preview.test");
  res.json({ access_token: token });
});
matrix.get("/_matrix/client/v3/account/whoami", (req, res) => {
  const user = tokens.get(req.get("authorization")?.slice(7));
  res
    .status(user ? 200 : 401)
    .json(user ? { user_id: user } : { errcode: "M_UNKNOWN_TOKEN" });
});
matrix.post("/_matrix/client/v3/logout", (req, res) => {
  tokens.delete(req.get("authorization")?.slice(7));
  res.json({});
});
const homeserver = await listen(matrix);
const host = express();
host.use(express.json());
host.get("/v1/health", (_req, res) => res.json({ protocolVersion: 1 }));
host.get("/v1/runtimes", (_req, res) =>
  res.json({ runtimes: [{ id: "fixture" }] }),
);
host.post("/v1/runtimes/inspect", (_req, res) =>
  res.json({ id: "fixture", available: true }),
);
host.post("/v1/runs", (req, res) => {
  const run = {
    id: randomUUID(),
    sessionId: req.body.sessionId,
    runtimeId: req.body.runtimeId,
    status: "completed",
    answer: "Fixture reply: " + req.body.input,
  };
  runs.set(run.id, run);
  res.status(202).json(run);
});
host.get("/v1/runs/:id/events", (_req, res) =>
  res.json({ events: [], cursor: 0, hasMore: false, historyTruncated: false }),
);
host.get("/v1/runs/:id", (req, res) => res.json(runs.get(req.params.id)));
const hostUrl = await listen(host);
privateFile(join(directory, "host-token"), "fixture-token");
privateFile(join(directory, "options.json"), {
  hosts: [
    {
      id: "fixture",
      label: "Local fixture (no model)",
      url: hostUrl,
      tokenFile: "host-token",
      runtimeId: "fixture",
      owners: ["@alice:preview.test"],
    },
  ],
});
const history = new Map();
let inbox;
const deliver = (room, event) => {
  const events = history.get(room) ?? [];
  events.push(event);
  history.set(room, events);
  inbox.receive(randomUUID(), { events: [{ ...event, room_id: room }] });
};
const settings = new OnboardingConfiguration(
  directory,
  join(directory, "options.json"),
);
const config = {
  serverName: "preview.test",
  homeserver,
  publicUrl: "http://127.0.0.1/_agent-router/v1",
  stateDir: directory,
  asToken: "a".repeat(48),
  hsToken: "h".repeat(48),
};
const service = new ManagedService(config, {
  provision: async () => {},
  configure: settings.factory,
  transport: (agent, box) => {
    inbox = box;
    return {
      identity: async () => agent.matrixId,
      sync: async (since) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return box.next(agent.id, since) ?? { next_batch: since ?? "0" };
      },
      state: async (room) => history.get(room) ?? [],
      history: async () => ({ events: [] }),
      createRoom: async (target) => {
        const room = "!" + randomUUID() + ":preview.test";
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
  },
});
settings.attach(service);
ConnectionSetup.prototype.begin = () => {
  throw new WorkError("preview_external_connections_disabled", 403);
};
const app = express(),
  base = await listen(app);
config.publicUrl = base + "/_agent-router/v1";
const browser = createOnboarding(service, settings);
app.use(createManagedApp(service, browser.router));
process.stdout.write(
  JSON.stringify({
    url: base + "/_agent-router/setup",
    account: "alice",
    password: "preview",
    note: "Local fixtures only. Only Matrix connection is enabled.",
  }) + "\n",
);
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await browser.close();
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
