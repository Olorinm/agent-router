import { z } from "zod";
import { configFile, connectionFields, defineChannel, key, ServiceHttp } from "../api.js";
import { GroveMailChannel } from "./channel.js";

export { GroveMailChannel } from "./channel.js";

export const groveMailChannel = defineChannel({
  kind: "grove-mail",
  schema: z.object({ ...connectionFields, kind: z.literal("grove-mail"), url: z.url(), inboxId: z.email(), apiKeyFile: configFile,
    initialCursor: z.number().int().nonnegative().default(0), attachmentOrigins: z.array(z.url()).default([]),
    /** ADR 0005 18.4 / open question 4: `/link` over mail, only for senders the provider marks verified. Off by default. */
    pairing: z.boolean().optional() }).strict(),
  account: (config) => key(config.url.replace(/\/$/, ""), config.inboxId),
  create: (config, { files }) => {
    const make = () => new GroveMailChannel(config.inboxId, new ServiceHttp(config.url, files.secret(config.apiKeyFile)), config.initialCursor, config.attachmentOrigins);
    return { adapter: make(), reload: make, mailPairing: Boolean(config.pairing) };
  },
  check: async (config, files) => {
    const mail = new ServiceHttp(config.url, files.read(config.apiKeyFile));
    const inbox = await mail.request(`/v0/inboxes/${encodeURIComponent(config.inboxId)}`);
    if (inbox.inbox_id !== config.inboxId) throw new Error("mail_inbox_mismatch");
    return config.ownerAddresses.length
      ? { status: "verified", detail: "Grove Mail inbox access verified; external SMTP delivery has not been tested" }
      : { status: "needs_action", detail: "Bind the owner's sender email address" };
  },
});
