import { createServer } from "node:http";
import { createApp } from "./app.js";
import { AuthService } from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { DeliveryRuntime } from "./delivery.js";
import { logError, logInfo } from "./log.js";
import { ProxyHandlerCache } from "./proxy-agent.js";
import { AgentRegistry } from "./registry.js";
import { PostgresTaskStore } from "./task-store.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);

const registry = new AgentRegistry(pool, config);
const taskStore = new PostgresTaskStore(pool);
const auth = new AuthService(pool, config.wwBaseUrl, config.authCacheTtlMs);
const delivery = new DeliveryRuntime(pool, registry, taskStore, config);
await delivery.start();
const proxyHandlers = new ProxyHandlerCache(registry, taskStore, auth.userBuilder, config.publicBaseUrl);
const app = createApp({
  pool,
  registry,
  auth,
  proxyHandlers,
  delivery,
  publicBaseUrl: config.publicBaseUrl,
  trustProxy: config.trustProxy,
});
const server = createServer(app);
server.listen(config.port, "0.0.0.0", () => logInfo("http.listening", { port: config.port }));

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logInfo("shutdown.started", { signal });
  server.close();
  await delivery.stop();
  await pool.end();
  logInfo("shutdown.completed");
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  logError("process.uncaught_exception", error);
  void shutdown("uncaughtException").finally(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  logError("process.unhandled_rejection", error);
  void shutdown("unhandledRejection").finally(() => process.exit(1));
});
