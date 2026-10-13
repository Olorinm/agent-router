/** Public embedding API. Router remains independently runnable via agent:service. */
import { ManagedService, createManagedApp, type ServiceConfig, type ServiceDependencies } from "./matrix/managed.js";
import { ConnectionConfiguration, type ConnectionOptions, type HostBindingProvider } from "./connections/configuration.js";
import { createConnections } from "./connections/routes.js";

export function createRouter(config: ServiceConfig, options: {
  connections?: string | Partial<ConnectionOptions>;
  hosts?: HostBindingProvider;
  dependencies?: Omit<ServiceDependencies, "configure">;
} = {}) {
  const connections = new ConnectionConfiguration(config.stateDir, options.connections ?? {}, options.hosts);
  const service = new ManagedService(config, { ...options.dependencies, configure: connections.factory });
  connections.attach(service);
  const routes = createConnections(service, connections);
  return {
    service, connections, app: createManagedApp(service, routes.router),
    start: () => service.start(),
    close: async () => { await routes.close(); await service.close(); },
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
