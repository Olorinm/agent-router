import { createCipheriv, randomBytes } from "node:crypto";
import { bindAccount, ChannelSendError, type ChannelAdapter, type ChannelContext, type NotifyPurpose, type ReplyRoute } from "../api.js";

export interface BarkOptions {
  /** The Bark server, e.g. a self-hosted bark-server or bark-worker. */
  server: string;
  deviceKey: string;
  /** Push encryption (Bark app → Push Encryption): AES-CBC with this 16, 24 or 32 character key. */
  encryptionKey?: string | undefined;
  /** `user:password` for a server behind HTTP Basic authentication. */
  basicAuth?: string | undefined;
  title: string;
  /** Opened when the notification is tapped. */
  openUrl?: string | undefined;
  /** False: the body says only what happened, never the agent's text. */
  preview: boolean;
  /** Characters of the body; longer text is cut. */
  maxLength: number;
}
const GENERIC: Record<NotifyPurpose, string> = { reply: "有新的回复", question: "有问题需要你处理", schedule: "有一条提醒" };
/** Answers wait for the owner; questions block a turn, so they break through Focus (`timeSensitive`). */
const LEVEL: Record<NotifyPurpose, string> = { reply: "active", question: "timeSensitive", schedule: "active" };
/** Errors raised before a request reached the server: resending cannot duplicate a notification. */
const UNSENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * A one-way push channel: it receives nothing and sends the owner notifications through a Bark server to the Bark iOS
 * app (`docs/guides/personal-channels.md`). Bark does not deduplicate requests, so an interrupted send is `uncertain`.
 */
export class BarkChannel implements ChannelAdapter {
  readonly kind = "bark";
  readonly retrySafe = false;
  readonly capabilities = { receive: [] as string[], send: ["text"], stream: false, buttons: false, native: [] as string[] };
  constructor(readonly options: BarkOptions, private readonly fetchImpl: typeof fetch = fetch) {}
  async start(context: ChannelContext): Promise<void> { bindAccount(context, account(this.options.server, this.options.deviceKey)); }
  async stop(): Promise<void> {}
  async send(route: ReplyRoute, text: string): Promise<{ externalId: string }> {
    const purpose = (["reply", "question", "schedule"] as const).find((item) => item === route.data.purpose) ?? "reply";
    const body = this.options.preview ? truncate(text.trim(), this.options.maxLength) : GENERIC[purpose];
    const message = { title: this.options.title, body, ...(this.options.openUrl ? { url: this.options.openUrl } : {}) };
    // Presentation fields stay readable: APNs needs the level and thread before the app decrypts the content.
    const fields: Record<string, string> = { level: LEVEL[purpose], group: this.options.title,
      ...(this.options.encryptionKey ? encrypt(this.options.encryptionKey, message) : message) };
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.server.replace(/\/$/, "")}/${encodeURIComponent(this.options.deviceKey)}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), body: new URLSearchParams(fields),
        headers: { "content-type": "application/x-www-form-urlencoded", ...(this.options.basicAuth ? { authorization: `Basic ${Buffer.from(this.options.basicAuth).toString("base64")}` } : {}) },
      });
    } catch (error) {
      const code = (error as { cause?: { code?: unknown } })?.cause?.code;
      throw new ChannelSendError(typeof code === "string" && UNSENT.has(code) ? "retry" : "uncertain", "bark_request_failed");
    }
    const result = await response.json().catch(() => null) as { code?: unknown; message?: unknown } | null;
    // Bark returns no message id.
    if (response.ok && result?.code === 200) return { externalId: `bark:${Date.now()}` };
    if (response.status === 429 || response.status >= 500) throw new ChannelSendError("retry", `bark_http_${response.status}`, 30_000);
    throw new ChannelSendError("failed", response.ok ? "bark_rejected" : `bark_http_${response.status}`);
  }
}

export const account = (server: string, deviceKey: string) => `${server.replace(/\/$/, "")}/${deviceKey}`;
function truncate(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length > limit ? characters.slice(0, limit - 1).join("") + "…" : text;
}
/** Bark push encryption: the JSON of the push fields, AES-CBC (PKCS#7), with a fresh IV passed alongside. */
export function encrypt(key: string, message: Record<string, string>): { ciphertext: string; iv: string } {
  const iv = randomBytes(12).toString("base64url").slice(0, 16);
  const cipher = createCipheriv(`aes-${Buffer.byteLength(key) * 8}-cbc`, Buffer.from(key), Buffer.from(iv));
  return { ciphertext: Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final()]).toString("base64"), iv };
}
