import { createClient, Direction, Method, Preset, type MatrixClient } from "matrix-js-sdk";
import { ROOM_EVENT, sized, type RoomEvent } from "./protocol.js";

export interface SyncBatch {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events: RoomEvent[]; limited?: boolean; prev_batch?: string };
      state?: { events: RoomEvent[] } }>;
    invite?: Record<string, { invite_state: { events: Array<RoomEvent & { state_key?: string }> } }>;
  };
}
export interface MatrixTransport {
  identity(): Promise<string>;
  sync(since: string | undefined, timeout: number): Promise<SyncBatch>;
  history(room: string, from: string | undefined): Promise<{ events: RoomEvent[]; end?: string }>;
  createRoom(peer: string): Promise<string>;
  join(room: string): Promise<void>;
  state(room: string): Promise<RoomEvent[]>;
  send(room: string, type: string, body: object, txnId: string): Promise<string>;
  stop(): void;
}

/** SDK HTTP/auth transport with explicit sync transactions so checkpointing follows durable receipt. */
export class SdkMatrixTransport implements MatrixTransport {
  readonly client: MatrixClient;
  constructor(baseUrl: string, accessToken: string, userId: string) {
    this.client = createClient({ baseUrl, accessToken, userId });
  }
  async identity(): Promise<string> { return (await this.client.whoami()).user_id; }
  async sync(since: string | undefined, timeout: number): Promise<SyncBatch> {
    return this.client.http.authedRequest<SyncBatch>(Method.Get, "/sync", {
      ...(since ? { since } : {}), timeout, set_presence: "offline",
      filter: JSON.stringify({ room: { timeline: { limit: 100 } }, presence: { types: [] } }),
    }, undefined, { localTimeoutMs: timeout + 15_000 });
  }
  async history(room: string, from: string | undefined): Promise<{ events: RoomEvent[]; end?: string }> {
    const result = await this.client.createMessagesRequest(room, from ?? null, 100, Direction.Backward);
    return { events: result.chunk as unknown as RoomEvent[], ...(result.end ? { end: result.end } : {}) };
  }
  async createRoom(peer: string): Promise<string> {
    return (await this.client.createRoom({ preset: Preset.PrivateChat, invite: [peer], is_direct: true,
      initial_state: [
        { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "invited" } },
        { type: ROOM_EVENT, state_key: "", content: { version: 1, purpose: "a2a", encrypted: false } },
      ],
    })).room_id;
  }
  async join(room: string): Promise<void> { await this.client.joinRoom(room); }
  async state(room: string): Promise<RoomEvent[]> { return await this.client.roomState(room) as unknown as RoomEvent[]; }
  async send(room: string, type: string, body: object, txnId: string): Promise<string> {
    const result = await this.client.http.authedRequest<{ event_id: string }>(Method.Put,
      `/rooms/${encodeURIComponent(room)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`, undefined, sized(body));
    return result.event_id;
  }
  stop(): void { this.client.http.abort(); this.client.stopClient(); }
}
