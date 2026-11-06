import { digest } from "../execution/protocol.js";
import type { LedgerEvent } from "./ledger.js";

/**
 * The owner surfaces the ledger serves itself (ADR 0005 phases 3 and 5). Their adapters live in `src/channels/web` and
 * `src/channels/room`; the ledger knows only these names and the ports below, never the adapters.
 */
/** The connection id of the web channel on every agent's channel core. */
export const WEB_CONNECTION = "web";
/** The connection id of the hub room channel on every agent's channel core. */
export const ROOM_CONNECTION = "room";
/** The web channel's account is the owner (ADR 4.1 `account_id`: ownerKey for web). */
export const webAccount = (ownerId: string) => digest(ownerId);
export const webTarget = (personId: string) => `person:${personId}`;
export interface WebSendInput { personId: string; idempotencyKey: string; text: string; replyTo?: string | undefined; attachments?: string[] | undefined }
export interface WebSendResult { duplicate: boolean; event: LedgerEvent; inputState: string | null }
/** What the web API needs from an agent's web channel. */
export interface WebIngress {
  submit(input: WebSendInput): WebSendResult;
  redact(personId: string, sessionKey: string, eventId: string, idempotencyKey: string): { duplicate: boolean; event: LedgerEvent; dropped: boolean };
}
