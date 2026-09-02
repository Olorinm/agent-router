import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { Pool } from "pg";
import { ZodError } from "zod";
import type { AuthService } from "./auth.js";
import type { DeliveryRuntime } from "./delivery.js";
import { FederationCallbackError, type FederationCallbackReceiver } from "./federation-callback.js";
import {
  FEDERATION_JWKS_PATH,
  FEDERATION_WELL_KNOWN_PATH,
  FederationAuthError,
  splitAgentAddress,
  type FederationService,
} from "./federation.js";
import { normalizeFederationDomain } from "./federation-policy.js";
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
  federationRequestsPerMinute: number;
  federation: FederationService;
  federationCallbacks: FederationCallbackReceiver;
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

  app.get(FEDERATION_WELL_KNOWN_PATH, (_request, response) => {
    if (!dependencies.federation.enabled) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=300").json(dependencies.federation.discoveryDocument());
  });
  app.get(FEDERATION_JWKS_PATH, (_request, response) => {
    if (!dependencies.federation.enabled) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=300").json(dependencies.federation.jwks());
  });

  const adminRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const federationRateLimit = rateLimit({
    windowMs: 60_000,
    limit: dependencies.federationRequestsPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (request) => !dependencies.auth.currentUser(request).federationIdentity,
    keyGenerator: (request) => dependencies.auth.currentUser(request).federationIdentity?.domain ?? "local",
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
    if (!agent || agent.targetKind !== "local") {
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

  app.patch("/v1/agents/:address", dependencies.auth.requireAdmin, async (request, response) => {
    const actor = dependencies.auth.currentUser(request);
    const agent = await dependencies.registry.update(
      routeParam(request.params.address),
      request.body,
      actor.userName,
    );
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

  app.get("/v1/federation/domains", dependencies.auth.requireAdmin, async (_request, response) => {
    response.json({ data: await dependencies.federation.policy.list() });
  });
  app.put("/v1/federation/domains/:domain", dependencies.auth.requireAdmin, async (request, response) => {
    const status = request.body?.status;
    if (status !== "allowed" && status !== "blocked") {
      response.status(400).json({ error: "federation_status_invalid" });
      return;
    }
    const actor = dependencies.auth.currentUser(request);
    const domain = parseFederationDomainParam(request, response);
    if (!domain) return;
    const policy = await dependencies.federation.policy.set(domain, status, actor.userName);
    response.json({ data: policy });
  });
  app.delete("/v1/federation/domains/:domain", dependencies.auth.requireAdmin, async (request, response) => {
    const domain = parseFederationDomainParam(request, response);
    if (!domain) return;
    const deleted = await dependencies.federation.policy.delete(domain);
    response.status(deleted ? 204 : 404).end();
  });

  app.use(
    "/a2a/agents/:localpart/card",
    dependencies.auth.requireCaller,
    federationRateLimit,
    localFederationCardHandler(dependencies),
  );
  app.post(
    "/federation/v1/push/:routerTaskId",
    express.json({ limit: "2mb", type: ["application/a2a+json", "application/json"] }),
    dependencies.auth.requireCaller,
    federationRateLimit,
    async (request, response) => {
      const identity = dependencies.auth.currentUser(request).federationIdentity;
      if (!identity) {
        response.status(404).json({ error: "not_found" });
        return;
      }
      await dependencies.federationCallbacks.receive(
        routeParam(request.params.routerTaskId),
        identity,
        request.body,
      );
      response.status(204).end();
    },
  );

  app.use(
    "/agents/:address/.well-known/agent-card.json",
    dependencies.auth.requireCaller,
    federationRateLimit,
    requireLocalTargetForFederatedCaller(dependencies),
    dynamicProxyHandler(dependencies.proxyHandlers, "card"),
  );
  app.use(
    "/agents/:address/a2a/rest",
    dependencies.auth.requireCaller,
    federationRateLimit,
    requireLocalTargetForFederatedCaller(dependencies),
    dynamicProxyHandler(dependencies.proxyHandlers, "rest"),
  );
  app.use(
    "/agents/:address/a2a/jsonrpc",
    dependencies.auth.requireCaller,
    federationRateLimit,
    requireLocalTargetForFederatedCaller(dependencies),
    dynamicProxyHandler(dependencies.proxyHandlers, "jsonRpc"),
  );

  app.use((_request, response) => response.status(404).json({ error: "not_found" }));
  app.use(((error, _request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: "invalid_request", issues: error.issues.map((issue) => issue.message) });
      return;
    }
    if (error instanceof FederationCallbackError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof FederationAuthError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    const status = error instanceof SyntaxError ? 400 : 500;
    if (status === 500) logError("http.unhandled", error);
    response.status(status).json({ error: status === 400 ? "invalid_json" : "internal_error" });
  }) satisfies ErrorRequestHandler);
  return app;
}

function localFederationCardHandler(dependencies: AppDependencies): RequestHandler {
  return async (request, response, next) => {
    try {
      const localpart = routeParam(request.params.localpart).toLowerCase();
      const address = `${localpart}@${dependencies.federation.domain}`;
      const suite = await dependencies.proxyHandlers.get(address);
      if (!suite) {
        response.status(404).json({ error: "agent_not_found" });
        return;
      }
      await Promise.resolve(suite.card(request, response, next));
    } catch (error) {
      next(error);
    }
  };
}

function requireLocalTargetForFederatedCaller(dependencies: AppDependencies): RequestHandler {
  return (request, response, next) => {
    const user = dependencies.auth.currentUser(request);
    if (!user.federationIdentity) {
      next();
      return;
    }
    try {
      if (splitAgentAddress(routeParam(request.params.address)).domain !== dependencies.federation.domain) {
        response.status(404).json({ error: "agent_not_found" });
        return;
      }
      next();
    } catch {
      response.status(404).json({ error: "agent_not_found" });
    }
  };
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

function parseFederationDomainParam(
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
): string | undefined {
  try {
    return normalizeFederationDomain(routeParam(request.params.domain));
  } catch {
    response.status(400).json({ error: "federation_domain_invalid" });
    return undefined;
  }
}
