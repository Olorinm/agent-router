import { createClient, MatrixError } from "matrix-js-sdk";
import { z } from "zod";
import { ConnectorStore } from "./store.js";
import { SdkMatrixTransport, type SyncBatch } from "./transport.js";
import { digest, type RoomEvent } from "./protocol.js";
import { delay } from "./connector.js";
import { WorkError } from "./cli-work.js";

const eventSchema = z.object({ event_id: z.string().min(1), room_id: z.string().min(1),
  sender: z.string().min(1), type: z.string().min(1), state_key: z.string().optional(),
  content: z.record(z.string(), z.unknown()) }).passthrough();
export const transactionSchema = z.object({ events: z.array(eventSchema).max(1000) }).passthrough();

/** ACK follows the atomic transaction journal + per-Agent fanout, never model execution. */
export class ApplicationInbox {
  constructor(readonly store: ConnectorStore, readonly agentForUser: (userId: string) => string | undefined) {}
  receive(id: string, input: unknown): void {
    const { events } = transactionSchema.parse(input);
    const hash = digest(events);
    this.store.transaction(() => {
      const prior = this.store.get<string>("as_transactions", id);
      if (prior) {
        if (prior !== hash) throw new WorkError("transaction_id_reused");
        return;
      }
      const sequence = (this.store.get<number>("meta", "as_sequence") ?? 0) + 1;
      const batches = new Map<string, SyncBatch>();
      for (const event of events) {
        const members = this.store.get<Record<string, string>>("as_members", event.room_id) ?? {};
        const target = event.type === "m.room.member" && event.state_key ? this.agentForUser(event.state_key) : undefined;
        if (target) {
          members[target] = String(event.content.membership);
          this.store.set("as_members", event.room_id, members);
        }
        const audience = new Set(Object.keys(members).filter((agent) => members[agent] === "join"));
        if (target) audience.add(target);
        for (const agent of audience) {
          let batch = batches.get(agent);
          if (!batch) { batch = { next_batch: String(sequence), rooms: { join: {}, invite: {}, leave: {} } }; batches.set(agent, batch); }
          const rooms = batch.rooms!;
          if (agent === target && members[agent] === "invite") {
            rooms.invite![event.room_id] = { invite_state: { events: [event as RoomEvent] } };
          } else if (agent === target && ["leave", "ban"].includes(members[agent]!)) {
            rooms.leave![event.room_id] = {};
            delete rooms.join![event.room_id]; delete rooms.invite![event.room_id];
          } else if (members[agent] === "join") {
            delete rooms.invite![event.room_id]; delete rooms.leave![event.room_id];
            const joined = rooms.join![event.room_id] ??= { timeline: { events: [] } };
            joined.timeline!.events.push(event as RoomEvent);
          }
        }
      }
      for (const [agent, batch] of batches) this.store.set(`as_queue:${agent}`, String(sequence), batch);
      this.store.set("meta", "as_sequence", sequence);
      this.store.set("as_transactions", id, hash);
    });
  }
  next(agent: string, since = "0"): SyncBatch | undefined {
    const cursor = Number(since);
    for (const { id, value } of this.store.entries<SyncBatch>(`as_queue:${agent}`)) {
      if (Number(id) <= cursor) this.store.delete(`as_queue:${agent}`, id);
      else return value;
    }
    return undefined;
  }
}

/** All Matrix credentials stay here. Runtime instances never receive an AS token. */
export class ApplicationTransport extends SdkMatrixTransport {
  private stopped = false;
  constructor(baseUrl: string, token: string, userId: string, readonly agentId: string, readonly inbox: ApplicationInbox) {
    super(baseUrl, token, userId, createClient({ baseUrl, accessToken: token, userId, queryParams: { user_id: userId } }));
  }
  override async sync(since: string | undefined, timeout: number): Promise<SyncBatch> {
    const until = Date.now() + Math.min(timeout, 1000);
    do {
      const next = this.inbox.next(this.agentId, since);
      if (next) return next;
      if (this.stopped) throw new Error("transport_stopped");
      await delay(100);
    } while (Date.now() < until);
    return { next_batch: since ?? "0" };
  }
  override async state(room: string): Promise<RoomEvent[]> {
    try { return await super.state(room); }
    catch (error) {
      // A delayed transaction may describe a room the Agent has since left.
      // Never execute an event if current membership/state cannot be established.
      if (error instanceof MatrixError && error.errcode === "M_FORBIDDEN") return [{
        type: "m.room.encryption", event_id: "", sender: "", content: {},
      }];
      throw error;
    }
  }
  override stop(): void { this.stopped = true; super.stop(); }
}
