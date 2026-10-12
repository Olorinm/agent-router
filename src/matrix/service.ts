#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { externalIdentityConfigSchema } from "./external-identity.js";
import { ManagedService, createManagedApp } from "./managed.js";
import { createChannelRuntime, loadChannelConfiguration } from "../service/channels.js";
import { configureChannels } from "../channels/config.js";
import { OnboardingConfiguration } from "../onboarding/configuration.js";
import { createOnboarding } from "../onboarding/routes.js";

const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`${key}_required`); return value; };
const externalFile=process.env.AGENT_IDENTITY_CONFIG_FILE;
const externalIdentity=externalFile?externalIdentityConfigSchema.parse({
  providers:JSON.parse(readFileSync(externalFile,"utf8")),
  adminToken:readFileSync(required("MATRIX_ADMIN_TOKEN_FILE"),"utf8").trim(),
}):undefined;
const channels = process.env.AGENT_ROUTER_CHANNELS_FILE ? loadChannelConfiguration(process.env.AGENT_ROUTER_CHANNELS_FILE) : undefined;
const stateDir = process.env.AGENT_SERVICE_STATE ?? "state/agent-service";
const onboarding = process.env.AGENT_ROUTER_ONBOARDING_FILE ? new OnboardingConfiguration(stateDir, process.env.AGENT_ROUTER_ONBOARDING_FILE, channels) : undefined;
const service: ManagedService = new ManagedService({
  ...(process.env.AGENT_TRUST_PROXY ? { trustedProxies: process.env.AGENT_TRUST_PROXY.split(",").map(v => v.trim()).filter(Boolean) } : {}),
  ...(externalIdentity?{externalIdentity}:{}),
  serverName: required("MATRIX_SERVER_NAME"), homeserver: required("MATRIX_HOMESERVER_URL").replace(/\/$/, ""),
  publicUrl: required("AGENT_SERVICE_URL").replace(/\/$/, ""), stateDir,
  asToken: readFileSync(required("MATRIX_AS_TOKEN_FILE"), "utf8").trim(),
  hsToken: readFileSync(required("MATRIX_HS_TOKEN_FILE"), "utf8").trim(),
}, onboarding ? { configure: onboarding.factory } : channels ? {
  configure: async (agent, connector) => {
    const config = channels.agents.find((item) => item.agentId === agent.id);
    if (!config) return undefined;
    return createChannelRuntime(agent, connector, config, channels.directory, (name) => {
      const issued = service.issue(agent.id, name);
      return { id: issued.instance.id, validate: () => { service.instance(issued.token, agent.id); } };
    });
  },
} : {});
onboarding?.attach(service);
const setup = onboarding ? createOnboarding(service, onboarding) : undefined;
const channelFile = process.env.AGENT_CHANNELS_CONFIG_FILE;
const channelIds = channelFile ? configureChannels(service.channels, channelFile, id => { service.agent(id); }) : [];
const server = createManagedApp(service, setup?.router).listen(Number(process.env.PORT ?? "8790"), process.env.HOST ?? "127.0.0.1");
let channelTimer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; clearInterval(channelTimer); server.close(); server.closeAllConnections(); await setup?.close(); await service.close(); };
process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
service.start().then(() => {
  if (!stopping && channelIds.length) channelTimer = setInterval(() => { for (const id of channelIds) void service.channels.tick(id); }, 1000);
  process.stdout.write(JSON.stringify({ event: "agent_service.started", server: service.config.serverName, channels: channelIds }) + "\n");
})
  .catch(async () => { process.stderr.write("agent_service_start_failed\n"); await stop(); process.exitCode = 1; });
