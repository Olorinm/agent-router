/** Public embedding API. Router remains independently runnable via agent:service. */
import { ManagedService, createManagedApp, type ServiceConfig, type ServiceDependencies } from "./matrix/managed.js";
import { ConnectionConfiguration, type ConnectionOptions, type HostBindingProvider } from "./connections/configuration.js";
import { createConnections } from "./connections/routes.js";
import { configureChannels } from "./channels/config.js";

export function createRouter(config: ServiceConfig, options: {
  connections?: string | Partial<ConnectionOptions>;
  hosts?: HostBindingProvider;
  dependencies?: Omit<ServiceDependencies, "configure">;
} = {}) {
  const connections = new ConnectionConfiguration(config.stateDir, options.connections ?? {}, options.hosts);
  const service = new ManagedService(config, { ...options.dependencies, configure: connections.factory });
  connections.attach(service);
  const routes = createConnections(service, connections);
  const channelIds = config.channelConfigFile
    ? configureChannels(service.channels, config.channelConfigFile, id => { service.agent(id); }) : [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  return {
    service, connections, channelIds, app: createManagedApp(service, routes.router),
    start: () => {
      if (closed) return Promise.reject(new Error("router_closed"));
      return starting ??= service.start().then(() => {
        if (!closed && channelIds.length) {
          timer = setInterval(() => { for (const id of channelIds) void service.channels.tick(id); }, 1000);
          timer.unref();
        }
      });
    },
    close: () => {
      closed = true; clearInterval(timer);
      return closing ??= (async () => { await starting?.catch(() => {}); await routes.close(); await service.close(); })();
    },
  };
}
export { ManagedService, type ManagedAgent, type ServiceConfig, type ServiceDependencies } from "./matrix/managed.js";
export { ConnectionConfiguration, type HostBindingProvider } from "./connections/configuration.js";
export { WorkError as RouterError } from "./matrix/cli-work.js";
export { HttpAgentHost, type HostPort } from "./execution/host.js";
export { ServiceHttp } from "./channels/http.js";
export { checkChannels } from "./service/check.js";
export { externalIdentityConfigSchema } from "./matrix/external-identity.js";
export { loadServiceConfig } from "./service/config.js";

export { RunObservation, type CommunicationTask, type RunReference, type TaskFilter } from "./execution/observation.js";
