import express from "express";
import { rateLimit } from "express-rate-limit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ManagedService } from "../matrix/managed.js";
import { WorkError } from "../matrix/cli-work.js";
import { ServiceHttp } from "../channels/http.js";
import { privateFile } from "../services/feishu/cli.js";
import { checkChannels } from "../service/check.js";
import { OnboardingConfiguration } from "./configuration.js";
import { ConnectionSetup } from "./connections.js";

const root = "/_agent-router/v1";
const object = z.object({}).strict();

/** Mounted AFTER the managed service's existing account authentication and Agent ownership checks. */
export function createOnboarding(service: ManagedService, configuration: OnboardingConfiguration) {
  const app = express.Router(), connections = new ConnectionSetup(service, configuration);
  // The outer service limits requests before authentication. Keep the account
  // budget local as well: configuration reads private files and can replace workers.
  app.use(root, rateLimit({windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (_req, res) => String(res.locals.owner), message: {error: "rate_limit_exceeded"}}));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.get(root + "/setup", (_req, res) => {
    res.json({
      hosts: configuration.hosts(res.locals.owner).map(({id, label, runtimeId}) => ({id, label, runtimeId})),
      mailServices: configuration.options.mailServices.map(({id, label}) => ({id, label})),
    });
  });
  app.get(root + "/agents/:agentId/setup", async (req, res) => {
    const agent = service.owned(String(req.params.agentId), res.locals.owner), runtime = await service.runtime(agent.id);
    res.json({...configuration.summary(agent), communication: runtime.extension?.status() ?? null});
  });
  app.post(root + "/agents/:agentId/setup/host", async (req, res) => {
    const { hostId } = z
      .object({ hostId: z.string().min(1).max(48) })
      .strict()
      .parse(req.body);
    const host = configuration
      .hosts(res.locals.owner)
      .find((host) => host.id === hostId);
    if (!host) throw new WorkError("host_not_assigned_to_account", 403);
    const http = new ServiceHttp(
      host.url,
      readFileSync(host.tokenFile, "utf8").trim(),
    );
    try {
      if ((await http.request("/v1/health")).protocolVersion !== 1)
        throw new Error();
      const inspect = await http.request("/v1/runtimes/inspect", {
        body: { runtimeId: host.runtimeId },
      });
      if (!inspect.available) throw new Error();
    } catch {
      throw new WorkError("host_runtime_unavailable", 409);
    }
    res.json(
      await configuration.host(
        res.locals.owner,
        String(req.params.agentId),
        hostId,
      ),
    );
  });
  app.post(root + "/agents/:agentId/setup/connections", async (req, res) => {
    const body = z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("feishu"),
            domain: z.enum(["feishu", "lark"]).default("feishu"),
            personalTools: z.boolean().default(true),
          })
          .strict(),
        z.object({ kind: z.literal("weixin") }).strict(),
        z
          .object({
            kind: z.literal("telegram"),
            token: z.string().min(1).max(1024),
          })
          .strict(),
        z.object({ kind: z.literal("matrix") }).strict(),
        z
          .object({
            kind: z.literal("grove-mail"),
            serviceId: z.string().min(1).max(48),
            inboxId: z.email(),
            apiKey: z.string().min(1).max(4096),
            ownerEmail: z.email(),
          })
          .strict(),
      ])
      .parse(req.body);
    const agent = service.owned(String(req.params.agentId), res.locals.owner);
    if (
      configuration
        .configuration(agent)
        ?.connections.some((connection) => connection.kind === body.kind)
    )
      throw new WorkError("platform_already_connected", 409);
    const connectionId = body.kind === "grove-mail" ? "mail" : body.kind;
    if (configuration.configuration(agent)?.connections.some(connection => connection.id === connectionId))
      throw new WorkError("connection_id_already_used", 409);
    if (
      body.kind === "feishu" ||
      body.kind === "weixin" ||
      body.kind === "telegram"
    ) {
      res
        .status(202)
        .json(
          connections.begin(
            res.locals.owner,
            agent.id,
            body.kind as "feishu" | "weixin" | "telegram",
            body.kind === "weixin" ? {} : body,
          ),
        );
      return;
    }
    if (body.kind === "matrix") {
      res.json(
        await configuration.edit(res.locals.owner, agent.id, (config) => {
          config.connections.push({
            id: "matrix",
            kind: "matrix",
            ownerAddresses: [agent.owner],
            peerAddresses: [],
            groupIds: [],
          });
        }),
      );
      return;
    }
    if (body.kind !== "grove-mail") throw new WorkError("invalid_request", 400);
    const mail = configuration.options.mailServices.find(
      (mail) => mail.id === body.serviceId,
    );
    if (!mail) throw new WorkError("mail_service_not_configured", 403);
    try {
      const inbox = await new ServiceHttp(mail.url, body.apiKey).request(
        "/v0/inboxes/" + encodeURIComponent(body.inboxId),
      );
      if (inbox.inbox_id !== body.inboxId) throw new Error();
    } catch {
      throw new WorkError("mail_inbox_access_failed", 400);
    }
    const file = join(configuration.agentDirectory(agent.id), "mail-key");
    privateFile(file, body.apiKey);
    res.json(
      await configuration.edit(res.locals.owner, agent.id, (config) => {
        config.connections.push({
          id: "mail",
          kind: "grove-mail",
          url: mail.url,
          inboxId: body.inboxId,
          apiKeyFile: file,
          ownerAddresses: [body.ownerEmail],
          peerAddresses: [],
          groupIds: [],
          initialCursor: 0,
          attachmentOrigins: mail.attachmentOrigins,
        });
      }),
    );
  });
  app.get(root + "/agents/:agentId/setup/jobs", (req, res) =>
    res.json({
      data: connections.list(res.locals.owner, String(req.params.agentId)),
    }),
  );
  app.get(root + "/agents/:agentId/setup/jobs/:id", (req, res) =>
    res.json(
      connections.status(
        res.locals.owner,
        String(req.params.agentId),
        String(req.params.id),
      ),
    ),
  );
  app.post(root + "/agents/:agentId/setup/jobs/:id/pairing", (req, res) => {
    const { code } = z
      .object({ code: z.string().regex(/^\d{1,12}$/) })
      .strict()
      .parse(req.body);
    connections.pairing(
      res.locals.owner,
      String(req.params.agentId),
      String(req.params.id),
      code,
    );
    res.status(204).end();
  });
  app.post(root + "/agents/:agentId/setup/check", async (req, res) => {
    object.parse(req.body);
    const agent = service.owned(String(req.params.agentId), res.locals.owner);
    const config = configuration.configuration(agent) ?? {
      agentId: agent.id,
      connections: [],
    };
    const runtime = await service.runtime(agent.id),
      live = runtime.extension?.status() as
        | {
            connections?: Array<{
              id: string;
              started: boolean;
              error?: string;
            }>;
          }
        | undefined;
    const checks = await checkChannels({
      directory: configuration.agentDirectory(agent.id),
      agents: [config],
    });
    for (const check of checks)
      if (check.connectionId) {
        const running = live?.connections?.find(
          (connection) => connection.id === check.connectionId,
        );
        if (!running?.started || running.error) {
          check.status = "needs_action";
          check.detail = "Connection is not running cleanly";
        } else if (["matrix", "weixin"].includes(check.kind)) {
          check.status = "verified";
          check.detail =
            "Connection started; send a real message to verify a reply";
        }
      }
    res.json({ checks });
  });
  return {router: app, close: () => connections.close()};
}
