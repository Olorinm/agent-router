/**
 * The public channel adapter API.
 *
 * Every adapter lives in its own directory, `src/channels/<kind>/`, and its `index.ts` exports a `ChannelModule`
 * (config schema + factory). External adapters import Router code only through this file, never from another
 * adapter; `test/channel-boundaries.test.ts` enforces it. Router builds adapters only through `./registry.ts`.
 * See `docs/guides/adding-a-channel.md`.
 */
import { z } from "zod";
import type { ChannelAdapter, MediaContent } from "../communication/types.js";
import type { HostCall } from "../execution/host.js";
import type { HostTool, HostToolResult } from "../execution/tools.js";

export type {
  AttachmentReference, ChannelAdapter, ChannelCapabilities, ChannelContent, ChannelContext, ChannelMessage, MediaContent,
  RecordedAttachment, RecordedMedia, ReplyRoute, SendReceipt,
} from "../communication/types.js";
export { bindAccount, ChannelSendError, sendChunks, splitText } from "../communication/types.js";
export { download, mediaContent, readBytes, MAX_MEDIA_BYTES } from "../communication/media.js";
export { digest, key } from "../execution/protocol.js";
export { ChannelHttpError, ServiceHttp } from "../http.js";
export { PollingChannel } from "./polling.js";
export type { HostCall, HostTool, HostToolResult };

/** Fields every connection has, whatever its kind. Each module's schema spreads them next to its `kind` literal. */
const addresses = z.array(z.string().min(1).max(512)).max(100).default([]);
export const connectionFields = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  ownerAddresses: addresses, peerAddresses: addresses, groupIds: addresses,
};
/** A credential or file path in the connection config, relative to the config file's directory. */
export const configFile = z.string().min(1);
// Module shapes differ; the registry keeps each module's exact type.
export type ConnectionSchema = z.ZodObject<any>;

/** Reads credential files referenced by a connection config. */
export interface ChannelFiles {
  /** The config file's directory; relative paths resolve against it. */
  readonly directory: string;
  /** Absolute path of a configured file. */
  path(file: string): string;
  /** A configured secret file, trimmed; an empty file is an error. */
  secret(file: string): string;
  /** A configured file, trimmed. */
  read(file: string): string;
}
/**
 * Router services for built-in adapters (Matrix). External adapters do not use it. A built-in module adds its own
 * entry by declaration merging (`declare module "../api.js" { interface ChannelServices { … } }`).
 */
export interface ChannelServices {}
export interface ChannelFactoryContext {
  agentId: string;
  /** The agent owner's Router id (`@user:server`). */
  owner: string;
  files: ChannelFiles;
  services: ChannelServices;
}
/** Personal (user-identity) authorization of a connection, e.g. Feishu personal tools. */
export interface ChannelAuthorization {
  begin(): Promise<unknown>;
  complete(): Promise<unknown>;
  status(verify: boolean): Promise<unknown>;
  /** Polled every few seconds while the runtime runs. */
  poll(): Promise<unknown>;
}
/** A Host tool the connection contributes to owner conversations. `transfer` copies a file into the run's session. */
export interface ChannelTool {
  definition: HostTool;
  execute(call: HostCall, transfer: (item: MediaContent) => Promise<string>): Promise<HostToolResult>;
}
export interface ChannelInstance {
  adapter: ChannelAdapter;
  /** A fresh adapter after the provider disconnected it; default reuses `adapter`. */
  reload?(): ChannelAdapter;
  /** The owner's sender ids on this provider; default the configured `ownerAddresses`. */
  ownerAddresses?: string[];
  /** Identity namespace of sender ids (ADR 0005 section 9), e.g. the Feishu app id; default `""`. */
  namespace?: string;
  /** Start before Router's first receive (Matrix installs its synchronous receipt hook this way). */
  eager?: boolean;
  authorization?: ChannelAuthorization;
  tools?: ChannelTool[];
  /** `/link` pairing codes are accepted over this mail connection from provider-verified senders. */
  mailPairing?: boolean;
}
export type CheckStatus = "verified" | "needs_action" | "not_verified" | "disabled";
export interface ChannelCheckResult {
  status: CheckStatus; detail: string;
  /** Separate checks of the same connection (e.g. personal authorization), reported with their own `kind`. */
  extra?: Array<{ kind: string; status: CheckStatus; detail: string }>;
}
export interface ChannelModule<S extends ConnectionSchema = ConnectionSchema> {
  readonly kind: z.infer<S>["kind"];
  /** The connection config: `z.object({ ...connectionFields, kind: z.literal(kind), … }).strict()`. */
  readonly schema: S;
  /** At most one connection of this kind per agent. */
  readonly singleton?: boolean;
  /** A running connection is the access check (no second consumer is started by `channels:check`). */
  readonly runningVerifies?: boolean;
  /** Cross-field validation; returns issue codes. `agent.host` is true when the agent has a direct Host. */
  validate?(config: z.infer<S>, agent: { host: boolean }): string[];
  /** The provider account, unique per kind across the configuration. May read (and validate) credential files. */
  account(config: z.infer<S>, context: { agentId: string; files: ChannelFiles }): string;
  create(config: z.infer<S>, context: ChannelFactoryContext): ChannelInstance | Promise<ChannelInstance>;
  /** Access check without consuming messages or sending anything. A throw reports `needs_action`. */
  check?(config: z.infer<S>, files: ChannelFiles): Promise<ChannelCheckResult>;
}
export const defineChannel = <S extends ConnectionSchema>(module: ChannelModule<S>): ChannelModule<S> => module;
