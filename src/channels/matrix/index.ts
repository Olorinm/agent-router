import { z } from "zod";
import type { MatrixConnector } from "../../matrix/connector.js";
import { connectionFields, defineChannel } from "../api.js";
import { MatrixChannel } from "./channel.js";

export { MatrixChannel } from "./channel.js";

declare module "../api.js" {
  interface ChannelServices {
    /** The agent's Matrix connector while Matrix runs for it (ADR 0005 19.2). `trusted`: the owner and the owner's agents. */
    matrix?: { connector: MatrixConnector; trusted(member: string): boolean } | undefined;
  }
}

/** Built-in: uses the agent's own Matrix connector (Application Service identity), not a credential file. */
export const matrixChannel = defineChannel({
  kind: "matrix",
  schema: z.object({ ...connectionFields, kind: z.literal("matrix") }).strict(),
  singleton: true,
  runningVerifies: true,
  account: (_config, { agentId }) => agentId,
  create: (config, { owner, services }) => {
    if (!services.matrix) throw new Error("matrix_connector_unavailable");
    const adapter = new MatrixChannel(services.matrix.connector, { trusted: services.matrix.trusted });
    // Started before the first /sync transaction so the synchronous receipt hook is installed.
    return { adapter, reload: () => adapter, eager: true, ownerAddresses: config.ownerAddresses.length ? config.ownerAddresses : [owner],
      namespace: owner.slice(owner.indexOf(":") + 1) };
  },
  check: async () => ({ status: "not_verified", detail: "Uses the managed node's Application Service identity; provide node status to verify startup" }),
});
