import express from "express";
import { z } from "zod";
import { WorkError } from "../execution/work.js";
import type { OwnerHub } from "./hub.js";
import { roomChatId } from "./rooms.js";
import type { OwnerPrincipal } from "./web.js";

export interface RoomRoutesContext {
  principal(res: express.Response): OwnerPrincipal;
  hub(res: express.Response): OwnerHub;
  owned(ownerId: string): Array<{ id: string; name: string }>;
  /** Opens the member agents' runtimes so room sessions and replies can be served. */
  open(agentId: string): Promise<void>;
  /** `features.groups`: room commands are accepted. */
  enabled: boolean;
  kick(): void;
}
const key = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const agentId = z.string().min(1).max(128);
const roomId = z.string().regex(/^rm_[0-9A-Za-z]{10,40}$/);

/** Group commands of ADR 0005 section 17.1. With the flag off they are 403 `feature_disabled`. */
export function mountRoomRoutes(router: express.Router, context: RoomRoutesContext): void {
  const enabled = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (!context.enabled) { next(new WorkError("feature_disabled", 403)); return; }
    next();
  };
  const active = (res: express.Response) => new Map(context.owned(context.principal(res).ownerId).map((agent) => [agent.id, agent.name]));
  const room = (res: express.Response, id: unknown) => {
    const parsed = roomId.safeParse(id), hub = context.hub(res);
    if (!parsed.success || !hub.rooms.room(parsed.data)) throw new WorkError("chat_not_found", 404);
    return { hub, roomId: parsed.data };
  };
  router.post("/groups", enabled, async (req, res) => {
    const body = z.object({ idempotencyKey: key, title: z.string().min(1).max(256), agentIds: z.array(agentId).min(1).max(20) }).strict().parse(req.body);
    const hub = context.hub(res), { personId } = context.principal(res);
    for (const id of new Set(body.agentIds)) if (active(res).has(id)) await context.open(id).catch(() => undefined);
    const { roomId } = hub.rooms.create(personId, body, active(res));
    const summary = hub.rooms.summary(roomChatId(roomId), personId);
    res.status(201).json({ ...summary, members: hub.rooms.members(roomId) });
  });
  router.patch("/groups/:roomId", enabled, (req, res) => {
    const body = z.object({ title: z.string().min(1).max(256).optional(), archived: z.boolean().optional() }).strict().parse(req.body ?? {});
    const target = room(res, req.params.roomId);
    target.hub.rooms.update(target.roomId, context.principal(res).personId, body);
    res.json(target.hub.rooms.summary(roomChatId(target.roomId), context.principal(res).personId));
  });
  router.post("/groups/:roomId/members", enabled, async (req, res) => {
    const body = z.object({ agentId }).strict().parse(req.body);
    const target = room(res, req.params.roomId);
    if (active(res).has(body.agentId)) await context.open(body.agentId).catch(() => undefined);
    res.json({ members: target.hub.rooms.addMember(target.roomId, context.principal(res).personId, body.agentId, active(res)) });
  });
  router.delete("/groups/:roomId/members/:agentId", enabled, (req, res) => {
    const target = room(res, req.params.roomId), member = agentId.parse(req.params.agentId);
    res.json({ members: target.hub.rooms.removeMember(target.roomId, { type: "person", id: context.principal(res).personId }, member) });
  });
}
