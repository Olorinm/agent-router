import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { Pool } from "pg";
import { ZodError } from "zod";
import type { AuthService } from "./auth.js";
import type { DeliveryRuntime } from "./delivery.js";
import { logError } from "./log.js";
import type { ProxyHandlerCache, ProxyHandlerSuite } from "./proxy-agent.js";
import { buildProxyAgentCard } from "./proxy-agent.js";
import type { AgentRegistry } from "./registry.js";

interface AppDependencies {
  pool: Pool;
  registry: AgentRegistry;
  auth: AuthService;
  proxyHandlers: ProxyHandlerCache;
  delivery: DeliveryRuntime;
  publicBaseUrl: string;
  trustProxy: number;
}

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", dependencies.trustProxy);

  app.get("/health/live", (_request, response) => response.json({ status: "ok" }));
  app.get("/health/ready", async (_request, response) => {
    try {
      await dependencies.pool.query("SELECT 1");
      if (!dependencies.delivery.isReady()) throw new Error("delivery_not_ready");
      response.json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });

  const adminRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.use("/v1", adminRateLimit, express.json({ limit: "256kb", type: "application/json" }));

  app.get("/v1/agents", dependencies.auth.requireAdmin, async (request, response) => {
    const search = typeof request.query.q === "string" ? request.query.q : "";
    const agents = await dependencies.registry.list(search);
    response.json({
      data: agents.map((agent) => ({
        id: agent.id,
        address: agent.address,
        displayName: agent.displayName,
        description: agent.description,
        status: agent.status,
        ownerPrincipalId: agent.ownerPrincipalId,
        updatedAt: agent.updatedAt,
        agentCard: buildProxyAgentCard(agent, dependencies.publicBaseUrl),
      })),
    });
  });

  app.get("/v1/agents/:address", dependencies.auth.requireAdmin, async (request, response) => {
    const agent = await dependencies.registry.getByAddress(routeParam(request.params.address));
    if (!agent) {
      response.status(404).json({ error: "agent_not_found" });
      return;
    }
    response.json({
      data: {
        id: agent.id,
        address: agent.address,
        displayName: agent.displayName,
        description: agent.description,
        status: agent.status,
        ownerPrincipalId: agent.ownerPrincipalId,
        updatedAt: agent.updatedAt,
        agentCard: buildProxyAgentCard(agent, dependencies.publicBaseUrl),
      },
    });
  });

  app.post("/v1/agents", dependencies.auth.requireAdmin, async (request, response) => {
    const owner = dependencies.auth.currentUser(request);
    const registration = await dependencies.registry.register(request.body, {
      id: owner.userName,
      displayName: owner.displayName,
      ...(owner.email ? { email: owner.email } : {}),
    });
    response.status(201).json({
      data: {
        id: registration.agent.id,
        address: registration.agent.address,
        agentCard: buildProxyAgentCard(registration.agent, dependencies.publicBaseUrl),
        machineCredential: registration.machineCredential,
      },
      warning: "The machine credential is shown once. Store it as a secret.",
    });
  });

  app.get(
    "/agents/:address/.well-known/agent-card.json",
    dynamicProxyHandler(dependencies.proxyHandlers, "card"),
  );
  app.use(
    "/agents/:address/a2a/rest",
    dependencies.auth.requireCaller,
    dynamicProxyHandler(dependencies.proxyHandlers, "rest"),
  );
  app.use(
    "/agents/:address/a2a/jsonrpc",
    dependencies.auth.requireCaller,
    dynamicProxyHandler(dependencies.proxyHandlers, "jsonRpc"),
  );

  app.use((_request, response) => response.status(404).json({ error: "not_found" }));
  app.use(((error, _request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: "invalid_request", issues: error.issues.map((issue) => issue.message) });
      return;
    }
    const status = error instanceof SyntaxError ? 400 : 500;
    if (status === 500) logError("http.unhandled", error);
    response.status(status).json({ error: status === 400 ? "invalid_json" : "internal_error" });
  }) satisfies ErrorRequestHandler);
  return app;
}

function dynamicProxyHandler(cache: ProxyHandlerCache, kind: keyof Pick<ProxyHandlerSuite, "card" | "rest" | "jsonRpc">): RequestHandler {
  return async (request, response, next) => {
    try {
      const suite = await cache.get(routeParam(request.params.address));
      if (!suite) {
        response.status(404).json({ error: "agent_not_found" });
        return;
      }
      await Promise.resolve(suite[kind](request, response, next));
    } catch (error) {
      next(error);
    }
  };
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
