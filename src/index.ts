import { createServer } from "node:http";
import { createApp } from "./app.js";
import { AuthService } from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { DeliveryRuntime } from "./delivery.js";
import { FederationCallbackReceiver } from "./federation-callback.js";
import { RouterPushNotificationSender } from "./federation-push.js";
import { FederationService } from "./federation.js";
import { logError, logInfo } from "./log.js";
import { ProxyHandlerCache } from "./proxy-agent.js";
import { PostgresPushNotificationStore } from "./push-notifications.js";
import { AgentRegistry } from "./registry.js";
import { PostgresTaskStore } from "./task-store.js";
import { TaskEventHub } from "./task-events.js";
import { AgentTargetResolver } from "./target-resolver.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);

const registry = new AgentRegistry(pool, config);
const federation = await FederationService.create(pool, config);
const targets = new AgentTargetResolver(registry, federation);
const pushNotificationStore = new PostgresPushNotificationStore(pool, config, federation);
const pushNotificationSender = new RouterPushNotificationSender(pushNotificationStore, federation);
const taskStore = new PostgresTaskStore(pool, pushNotificationSender);
const taskEvents = new TaskEventHub();
const federationCallbacks = new FederationCallbackReceiver(pool, taskStore, taskEvents);
const auth = new AuthService(pool, config.wwBaseUrl, config.authCacheTtlMs, federation);
const delivery = new DeliveryRuntime(pool, registry, taskStore, taskEvents, config, federation);
await delivery.start();
const proxyHandlers = new ProxyHandlerCache(
  targets,
  taskStore,
  taskEvents,
  pushNotificationStore,
  auth.userBuilder,
  config.publicBaseUrl,
  federation.domain,
);
const app = createApp({
  pool,
  registry,
  auth,
  proxyHandlers,
  delivery,
  publicBaseUrl: config.publicBaseUrl,
  trustProxy: config.trustProxy,
  federationRequestsPerMinute: config.federationRequestsPerMinute,
  federation,
  federationCallbacks,
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
  await federation.close();
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
