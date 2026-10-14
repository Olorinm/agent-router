#!/usr/bin/env node
import { createRouter, loadServiceConfig } from "../server.js";
import { configureChannels } from "../channels/config.js";

const router = createRouter(loadServiceConfig(), { connections: process.env.AGENT_ROUTER_CONNECTIONS_FILE ?? {} });
const service = router.service;
const channelFile = process.env.AGENT_CHANNELS_CONFIG_FILE;
const channelIds = channelFile ? configureChannels(service.channels, channelFile, id => { service.agent(id); }) : [];
const server = router.app.listen(Number(process.env.PORT ?? "8790"), process.env.HOST ?? "127.0.0.1");
let channelTimer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; clearInterval(channelTimer); server.close(); server.closeAllConnections(); await router.close(); };
process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
service.start().then(() => {
  if (!stopping && channelIds.length) channelTimer = setInterval(() => { for (const id of channelIds) void service.channels.tick(id); }, 1000);
  process.stdout.write(JSON.stringify({ event: "agent_service.started", server: service.config.serverName, channels: channelIds }) + "\n");
})
  .catch(async () => { process.stderr.write("agent_service_start_failed\n"); await stop(); process.exitCode = 1; });
