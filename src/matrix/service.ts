#!/usr/bin/env node
import { createRouter, loadServiceConfig } from "../server.js";

const router = createRouter(loadServiceConfig(), { connections: process.env.AGENT_ROUTER_CONNECTIONS_FILE ?? {} });
const service = router.service;
const server = router.app.listen(Number(process.env.PORT ?? "8790"), process.env.HOST ?? "127.0.0.1");
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; server.close(); server.closeAllConnections(); await router.close(); };
process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
router.start().then(() => {
  process.stdout.write(JSON.stringify({ event: "agent_service.started", server: service.config.serverName, channels: router.channelIds }) + "\n");
})
  .catch(async () => { process.stderr.write("agent_service_start_failed\n"); await stop(); process.exitCode = 1; });
