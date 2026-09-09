#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { externalIdentityConfigSchema } from "./external-identity.js";
import { ManagedService, createManagedApp } from "./managed.js";

const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`${key}_required`); return value; };
const externalFile=process.env.AGENT_IDENTITY_CONFIG_FILE;
const externalIdentity=externalFile?externalIdentityConfigSchema.parse({
  providers:JSON.parse(readFileSync(externalFile,"utf8")),
  adminToken:readFileSync(required("MATRIX_ADMIN_TOKEN_FILE"),"utf8").trim(),
}):undefined;
const service = new ManagedService({
  ...(process.env.AGENT_TRUST_PROXY ? { trustedProxies: process.env.AGENT_TRUST_PROXY.split(",").map(v => v.trim()).filter(Boolean) } : {}),
  ...(externalIdentity?{externalIdentity}:{}),
  serverName: required("MATRIX_SERVER_NAME"), homeserver: required("MATRIX_HOMESERVER_URL").replace(/\/$/, ""),
  publicUrl: required("AGENT_SERVICE_URL").replace(/\/$/, ""), stateDir: process.env.AGENT_SERVICE_STATE ?? "state/agent-service",
  asToken: readFileSync(required("MATRIX_AS_TOKEN_FILE"), "utf8").trim(),
  hsToken: readFileSync(required("MATRIX_HS_TOKEN_FILE"), "utf8").trim(),
});
const server = createManagedApp(service).listen(Number(process.env.PORT ?? "8790"), process.env.HOST ?? "127.0.0.1");
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; server.close(); server.closeAllConnections(); await service.close(); };
process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
service.start().then(() => process.stdout.write(JSON.stringify({ event: "agent_service.started", server: service.config.serverName }) + "\n"))
  .catch(async () => { process.stderr.write("agent_service_start_failed\n"); await stop(); process.exitCode = 1; });
