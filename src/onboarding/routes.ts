import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  Task,
  SendMessageRequest,
  GetTaskRequest,
  CancelTaskRequest,
} from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { MatrixA2AHandler, requestSignal } from "../matrix/gateway.js";
import { agentName, type ManagedService } from "../matrix/managed.js";
import { WorkError } from "../matrix/cli-work.js";
import { ServiceHttp } from "../channels/http.js";
import { privateFile } from "../services/feishu/cli.js";
import { checkChannels } from "../service/check.js";
import { interaction } from "../communication/interaction.js";
import type { HostCall } from "../execution/host.js";
import { OnboardingConfiguration } from "./configuration.js";
import { ConnectionSetup } from "./connections.js";
import { BrowserSessions, matrixLogin, setupPath } from "./sessions.js";

const root = setupPath + "/api";
const object = z.object({}).strict();
const credentials = z
  .object({
    username: z.string().min(1).max(255),
    password: z.string().min(1).max(1024),
    registrationToken: z.string().min(1).max(1024).optional(),
  })
  .strict();
const targetSchema = z.string().min(1).max(512);
const safeError = (error: unknown) =>
  error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(error.message)
    ? error.message
    : "operation_failed";

export function createOnboarding(
  service: ManagedService,
  configuration: OnboardingConfiguration,
) {
  const app = express.Router(),
    sessions = new BrowserSessions(service),
    connections = new ConnectionSetup(service, configuration);
  const origin = new URL(service.config.publicUrl).origin;
  app.use(
    setupPath,
    rateLimit({
      windowMs: 60_000,
      limit: 1200,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) =>
        ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
      message: { error: "rate_limit_exceeded" },
    }),
  );
  app.use(setupPath, (_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });
  const publicDirectory = fileURLToPath(new URL("./public/", import.meta.url));
  app.get([setupPath, setupPath + "/"], (_req, res) =>
    res.sendFile(join(publicDirectory, "index.html"), { dotfiles: "allow" }),
  );
  for (const file of ["app.js", "style.css"])
    app.get(setupPath + "/" + file, (_req, res) =>
      res.sendFile(join(publicDirectory, file), { dotfiles: "allow" }),
    );
  app.use(
    root,
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) =>
        ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
      message: { error: "rate_limit_exceeded" },
    }),
  );
  app.use(root, (req, _res, next) => {
    if (
      req.get("X-Agent-Router-UI") !== "1" ||
      (req.method !== "GET" && req.get("origin") !== origin)
    )
      throw new WorkError("same_origin_browser_required", 403);
    next();
  });
  app.use(
    root + "/auth",
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) =>
        ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
      message: { error: "rate_limit_exceeded" },
    }),
  );
  app.get(root + "/options", (_req, res) =>
    res.json({
      serverName: service.config.serverName,
      registration: configuration.options.registration,
      productLoginUrl: configuration.options.productLoginUrl ?? null,
    }),
  );
  app.post(root + "/auth/login", async (req, res) => {
    sessions.establish(
      req,
      res,
      await matrixLogin(service, credentials.parse(req.body), false),
    );
    res.json({ status: "signed_in" });
  });
  app.post(root + "/auth/register", async (req, res) => {
    if (!configuration.options.registration)
      throw new WorkError("registration_disabled", 403);
    const input = credentials.parse(req.body);
    if (!/^[a-z0-9][a-z0-9._=-]{0,63}$/.test(input.username))
      throw new WorkError("invalid_username", 400);
    sessions.establish(req, res, await matrixLogin(service, input, true));
    res.status(201).json({ status: "signed_in" });
  });
  app.post(root + "/auth/redeem", async (req, res) => {
    const { ticket } = z
      .object({ ticket: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) })
      .strict()
      .parse(req.body);
    await sessions.redeem(ticket, req, res);
    res.json({ status: "signed_in" });
  });
  app.post(root + "/auth/handoff", (req, res) => {
    const { ticket } = z
      .object({ ticket: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) })
      .strict()
      .parse(req.body);
    res.json(sessions.preview(ticket));
  });
  app.post(root + "/auth/logout", async (req, res) => {
    object.parse(req.body);
    await sessions.logout(req, res);
    res.status(204).end();
  });
  app.post(
    "/_agent-router/v1/onboarding/link",
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) =>
        ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown"),
      message: { error: "rate_limit_exceeded" },
    }),
    async (req, res) => {
      object.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.json(
        await sessions.issueLink(
          req.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "",
        ),
      );
    },
  );
  app.use(root, async (req, res, next) => {
    res.locals.session = await sessions.authenticate(req);
    res.locals.owner = res.locals.session.owner;
    next();
  });
  app.get(root + "/session", async (_req, res) => {
    const owner = res.locals.owner,
      caller = await service.create(owner, "client");
    res.json({
      owner,
      caller,
      agents: service
        .agents(owner)
        .map((agent) => configuration.summary(agent)),
      hosts: configuration.hosts(owner).map((host) => ({
        id: host.id,
        label: host.label,
        runtimeId: host.runtimeId,
      })),
      mailServices: configuration.options.mailServices.map((mail) => ({
        id: mail.id,
        label: mail.label,
      })),
      targets: configuration.options.targets,
    });
  });
  app.post(root + "/agents", async (req, res) => {
    const { name } = z.object({ name: agentName }).strict().parse(req.body);
    res
      .status(201)
      .json(
        configuration.summary(await service.create(res.locals.owner, name)),
      );
  });
  app.use(root + "/agents/:agentId", (req, res, next) => {
    service.owned(String(String(req.params.agentId)), res.locals.owner);
    next();
  });
  app.get(root + "/agents/:agentId", async (req, res) => {
    const agent = service.owned(String(req.params.agentId), res.locals.owner),
      runtime = await service.runtime(agent.id);
    res.json({
      ...configuration.summary(agent),
      communication: runtime.extension?.status() ?? null,
    });
  });
  app.post(root + "/agents/:agentId/host", async (req, res) => {
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
  app.post(root + "/agents/:agentId/connections", async (req, res) => {
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
  app.get(root + "/agents/:agentId/jobs", (req, res) =>
    res.json({
      data: connections.list(res.locals.owner, String(req.params.agentId)),
    }),
  );
  app.get(root + "/agents/:agentId/jobs/:id", (req, res) =>
    res.json(
      connections.status(
        res.locals.owner,
        String(req.params.agentId),
        String(req.params.id),
      ),
    ),
  );
  app.post(root + "/agents/:agentId/jobs/:id/pairing", (req, res) => {
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
  app.post(root + "/agents/:agentId/check", async (req, res) => {
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
  app.post(
    root + "/agents/:agentId/authorization/:connectionId/:action",
    async (req, res) => {
      object.parse(req.body);
      const action = z
          .enum(["status", "begin", "complete"])
          .parse(String(req.params.action)),
        runtime = await service.runtime(String(req.params.agentId));
      if (!runtime.extension?.authorization)
        throw new WorkError("personal_authorization_not_configured", 404);
      res.json(
        await runtime.extension.authorization(
          String(req.params.connectionId),
          action,
        ),
      );
    },
  );
  const resolve = (address: string) => {
    const target = service
      .agents()
      .find((agent) => agent.address === address && agent.status === "active");
    if (!target) throw new WorkError("agent_not_found", 404);
    return target;
  };
  app.get(root + "/agents/:agentId/access", async (req, res) => {
    const { connector } = await service.runtime(String(req.params.agentId));
    res.json({ contacts: connector.contacts() });
  });
  app.post(root + "/agents/:agentId/access", async (req, res) => {
    const { address, decision } = z
      .object({
        address: targetSchema,
        decision: z.enum(["allow", "ask", "deny"]),
      })
      .strict()
      .parse(req.body);
    const target = resolve(address),
      agent = service.owned(String(req.params.agentId), res.locals.owner);
    if (target.id === agent.id || target.owner === agent.owner)
      throw new WorkError("friend_agent_required", 400);
    const { connector } = await service.runtime(agent.id);
    await connector.updateContact({
      address: target.matrixId,
      note: target.address,
      receive: decision,
      execution: decision,
    });
    res.json({ address: target.address, decision });
  });
  app.get(root + "/agents/:agentId/requests", async (req, res) => {
    const { connector } = await service.runtime(String(req.params.agentId));
    res.json({
      data: connector
        .pending()
        .filter((record) => record.status === "pending")
        .map((record) => ({
          id: record.id,
          sender:
            service.agents().find((agent) => agent.matrixId === record.sender)
              ?.address ?? record.sender,
          input: record.request.body.message,
        })),
    });
  });
  app.post(
    root + "/agents/:agentId/requests/:id/decision",
    async (req, res) => {
      const { decision } = z
        .object({ decision: z.enum(["allow", "deny"]) })
        .strict()
        .parse(req.body);
      const { connector } = await service.runtime(String(req.params.agentId)),
        id = String(req.params.id);
      if (
        !connector
          .pending()
          .some((record) => record.id === id && record.status === "pending")
      )
        throw new WorkError("pending_request_not_found", 404);
      if (decision === "allow") connector.approve(id);
      else connector.deny(id);
      res.status(204).end();
    },
  );
  const pendingCalls = async (agentId: string) => {
    const runtime = await service.runtime(agentId);
    const live = runtime.extension?.status() as
      | { host?: { calls?: HostCall[] } }
      | undefined;
    return {
      extension: runtime.extension,
      calls: (live?.host?.calls ?? []).filter(
        (call) => call.kind === "interaction" && call.status === "pending",
      ),
    };
  };
  app.get(root + "/agents/:agentId/interactions", async (req, res) => {
    const { calls } = await pendingCalls(String(req.params.agentId));
    res.json({
      data: calls.map((call) => {
        const view = interaction(call);
        return {
          id: call.id,
          text: view.text,
          choices: view.choices.map((choice) => choice.label),
          sensitive: view.sensitive ?? false,
          deadlineAt: call.deadlineAt,
        };
      }),
    });
  });
  app.post(
    root + "/agents/:agentId/interactions/:id/answer",
    async (req, res) => {
      const body = z
        .object({
          choice: z.number().int().nonnegative().optional(),
          text: z.string().min(1).max(32_000).optional(),
        })
        .strict()
        .parse(req.body);
      if ((body.choice === undefined) === (body.text === undefined))
        throw new WorkError("interaction_answer_required", 400);
      const { calls, extension } = await pendingCalls(
          String(req.params.agentId),
        ),
        call = calls.find((call) => call.id === req.params.id);
      if (!call || !extension)
        throw new WorkError("pending_call_not_found", 404);
      const view = interaction(call);
      if (view.sensitive)
        throw new WorkError("native_sensitive_input_required", 409);
      let result: unknown;
      try {
        result =
          body.choice === undefined
            ? view.answer(body.text!)
            : view.choices[body.choice]?.result;
      } catch {
        throw new WorkError("invalid_interaction_answer", 400);
      }
      if (result === undefined)
        throw new WorkError("invalid_interaction_answer", 400);
      await extension.resolve(call.id, result);
      res.status(204).end();
    },
  );
  const handler = async (owner: string, address: string) => {
    const caller = await service.create(owner, "client"),
      target = resolve(address);
    if (target.owner === owner) {
      const { connector } = await service.runtime(target.id);
      await connector.updateContact({
        address: caller.matrixId,
        note: "Owner's browser",
        receive: "allow",
        execution: "allow",
      });
      connector.store.set("communication_owner_callers", caller.matrixId, true);
    }
    return new MatrixA2AHandler(
      (await service.runtime(caller.id)).connector,
      target.matrixId,
      service.config.publicUrl,
    );
  };
  app.get(root + "/chat/tasks", async (req, res) => {
    const h = await handler(
      res.locals.owner,
      targetSchema.parse(req.query.address),
    );
    const ids = h.connector
      .tasks()
      .filter((task) => h.connector.taskTarget(task.id) === h.target)
      .slice(-20)
      .map((task) => task.id);
    res.json({
      tasks: await Promise.all(
        ids.map(async (id) =>
          Task.toJSON(
            await h.getTask(GetTaskRequest.fromJSON({ id, historyLength: 20 })),
          ),
        ),
      ),
    });
  });
  app.post(root + "/chat/send", async (req, res) => {
    const body = z
      .object({
        address: targetSchema,
        messageId: z.uuid(),
        text: z.string().min(1).max(32_000),
        contextId: z.string().min(1).max(512).optional(),
        taskId: z.string().min(1).max(512).optional(),
      })
      .strict()
      .parse(req.body);
    const h = await handler(res.locals.owner, body.address);
    const task = await h.sendMessage(
      SendMessageRequest.fromJSON({
        message: {
          messageId: body.messageId,
          parts: [{ text: body.text }],
          role: "ROLE_USER",
          ...(body.contextId ? { contextId: body.contextId } : {}),
          ...(body.taskId ? { taskId: body.taskId } : {}),
        },
        configuration: { returnImmediately: true, historyLength: 20 },
      }),
      new ServerCallContext(),
    );
    res.json(Task.toJSON(task));
  });
  app.get(root + "/chat/tasks/:id", async (req, res) => {
    res.json(
      Task.toJSON(
        await (
          await handler(res.locals.owner, targetSchema.parse(req.query.address))
        ).getTask(
          GetTaskRequest.fromJSON({
            id: String(req.params.id),
            historyLength: 20,
          }),
        ),
      ),
    );
  });
  app.post(root + "/chat/tasks/:id/cancel", async (req, res) => {
    const { address } = z
        .object({ address: targetSchema })
        .strict()
        .parse(req.body),
      controller = new AbortController();
    res.once("close", () => controller.abort());
    const h = await handler(res.locals.owner, address);
    const task = await requestSignal.run(controller.signal, () =>
      h.cancelTask(CancelTaskRequest.fromJSON({ id: String(req.params.id) })),
    );
    res.json(Task.toJSON(task));
  });
  app.use(
    [setupPath, "/_agent-router/v1/onboarding"],
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(
          error instanceof WorkError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : safeError(error) === "host_binding_configuration_changed"
                ? 409
                : 500,
        )
        .json({
          error:
            error instanceof z.ZodError ? "invalid_request" : safeError(error),
        });
    },
  );
  return {
    router: app,
    close: async () => {
      await Promise.all([connections.close(), sessions.close()]);
    },
  };
}
