import { setTimeout as sleep } from "node:timers/promises";
import { ChannelHttpError } from "./http.js";
import type { ChannelContext } from "../communication/types.js";

/** One reader per connection. Checkpoints are owned by the durable communication store. */
export abstract class PollingChannel {
  protected context!: ChannelContext;
  protected controller = new AbortController();
  private loop: Promise<void> | undefined;
  protected abstract poll(signal: AbortSignal): Promise<void>;
  protected async initialize(): Promise<void> {}
  async start(context: ChannelContext): Promise<void> {
    if (this.loop) throw new Error("channel_already_started");
    this.context = context; this.controller = new AbortController();
    await this.initialize();
    this.loop = this.run();
  }
  async stop(): Promise<void> {
    this.controller.abort(); await this.loop; this.loop = undefined;
  }
  private async run(): Promise<void> {
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try { await this.poll(this.controller.signal); failures = 0; this.context.error(""); }
      catch (error) {
        if (this.controller.signal.aborted) break;
        const permanent = error instanceof ChannelHttpError && [401, 403, 410].includes(error.status);
        this.context.error(error instanceof ChannelHttpError ? error.code : "channel_receive_failed");
        if (permanent) break; // Expired cursors and credentials require explicit repair, not silent resets.
        failures++;
      }
      try { await sleep(failures ? Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) : 250, undefined, { signal: this.controller.signal }); }
      catch { break; }
    }
  }
}
