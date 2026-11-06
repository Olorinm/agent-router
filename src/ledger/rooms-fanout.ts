import type { OwnerHubs } from "./hub.js";
import type { RoomDelivery } from "./rooms.js";

export interface RoomFanoutDependencies {
  /** Owners whose hubs may hold queued fan-out rows. */
  owners(): string[];
  /** The agent's room channel; opens the runtime when needed. Undefined when the agent has no channel runtime. */
  channel(agentId: string): Promise<RoomDelivery | undefined>;
}

/**
 * The fan-out worker of ADR 0005 section 17.2 for one Router process: it polls every owner hub with queued rows
 * and runs immediately after a room send (`kick`). Runs never overlap.
 */
export class RoomFanout {
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly hubs: OwnerHubs, private readonly dependencies: RoomFanoutDependencies, intervalMs = 1000) {
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref?.();
  }
  kick(): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    this.running = this.tick().finally(() => {
      this.running = undefined;
      if (this.again && !this.stopped) { this.again = false; this.kick(); }
    });
  }
  /** One pass over every owner hub. Errors stay on the rows (attempts, next_at, error). */
  async tick(now = Date.now()): Promise<void> {
    for (const owner of this.dependencies.owners()) {
      if (this.stopped) return;
      try {
        const rooms = this.hubs.hub(owner).rooms;
        if (rooms.hasQueued()) await rooms.deliver((agentId) => this.dependencies.channel(agentId), now);
      } catch { /* A hub that cannot open is retried on the next pass. */ }
    }
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.running?.catch(() => undefined); }
}
