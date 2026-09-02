import type { FederationService } from "./federation.js";
import { splitAgentAddress } from "./federation.js";
import type { AgentRegistry, RegisteredAgent } from "./registry.js";

export class AgentTargetResolver {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly federation: FederationService,
  ) {}

  async resolve(addressValue: string): Promise<RegisteredAgent | undefined> {
    const parsed = splitAgentAddress(addressValue.includes("@") ? addressValue : `${addressValue}@${this.federation.domain}`);
    if (parsed.domain === this.federation.domain) {
      const local = await this.registry.getByAddress(parsed.address);
      return local?.targetKind === "local" ? local : undefined;
    }
    if (!this.federation.enabled) return undefined;
    if (!await this.federation.policy.isAllowed(parsed.domain)) return undefined;

    const cached = await this.registry.getByAddress(parsed.address);
    if (
      cached?.targetKind === "federated" &&
      cached.status === "active" &&
      cached.remoteCardExpiresAt &&
      Date.parse(cached.remoteCardExpiresAt) > Date.now()
    ) {
      return cached;
    }
    const remote = await this.federation.fetchAgentCard(parsed.address);
    return this.registry.upsertFederated(parsed.address, remote.domain, remote.card);
  }
}
