import { ServiceHttp } from "../http.js";
import { channelModule } from "../channels/registry.js";
import { channelFiles, type ChannelConfiguration } from "./channels.js";

export interface Check { agentId: string; connectionId?: string; kind: string; status: "verified" | "needs_action" | "not_verified" | "disabled"; detail: string; }
/** Checks access without starting consumers, consuming messages, sending replies or running a model. */
export async function checkChannels(configuration: ChannelConfiguration, node?: ServiceHttp, suppliedHost?: ServiceHttp): Promise<Check[]> {
  const checks: Check[] = [], files = channelFiles(configuration.directory);
  for (const agent of configuration.agents) {
    if (agent.host) {
      try {
        if (agent.host.binding && !suppliedHost) throw new Error("host_binding_provider_required");
        const host = suppliedHost ?? new ServiceHttp(agent.host.url!, files.read(agent.host.tokenFile!));
        const health = await host.request("/v1/health"), runtimes = await host.request("/v1/runtimes");
        if (health.protocolVersion !== 1 || !runtimes.runtimes?.some((item: { id: string }) => item.id === agent.host!.runtimeId)) throw new Error("host_runtime_not_found");
        checks.push({ agentId: agent.agentId, kind: "host", status: "verified", detail: "HTTP service and runtime exist; model execution has not been tested" });
      } catch { checks.push({ agentId: agent.agentId, kind: "host", status: "needs_action", detail: "Host address/token/runtime check failed" }); }
    } else checks.push({ agentId: agent.agentId, kind: "host", status: "not_verified", detail: "No direct Host configured; an external worker is required" });
    let live: any;
    if (node) try { live = await node.request(`/_agent-router/v1/agents/${encodeURIComponent(agent.agentId)}/communication`); } catch { /* Each channel will report unverified service state. */ }
    if (!agent.connections.length) checks.push({ agentId: agent.agentId, kind: "connections", status: "not_verified", detail: "No messaging connection configured; Host health does not verify channel access" });
    for (const connection of agent.connections) {
      const module = channelModule(connection.kind);
      const check: Check = { agentId: agent.agentId, connectionId: connection.id, kind: connection.kind, status: "not_verified", detail: "" };
      try {
        const result = await module.check?.(connection, files);
        if (result) { check.status = result.status; check.detail = result.detail; }
        const running = live?.connections?.find((item: { id: string }) => item.id === connection.id);
        if (node && (!running?.started || running?.error)) { check.status = "needs_action"; check.detail += "; Router connection is not running cleanly"; }
        else if (running && module.runningVerifies) { check.status = "verified"; check.detail += "; Router reports successful startup (send/receive still needs a real message)"; }
      } catch { check.status = "needs_action"; check.detail = `${connection.kind} credential/access check failed`; }
      checks.push(check);
    }
  }
  return checks;
}
