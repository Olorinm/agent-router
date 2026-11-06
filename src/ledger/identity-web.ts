import type express from "express";
import { z } from "zod";
import type { Identities } from "./identity.js";

/** The principal fields the identity routes need. `email` is set for edge (Cloudflare Access) logins. */
interface Principal { personId: string; ownerId: string; email?: string | undefined }
const INSTRUCTIONS = (code: string) => `在要关联的渠道里私聊你的任一 Agent，发送：/link ${code}`;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * Identity page API (ADR 0005 18.1, 18.4, 18.5), mounted under `/_agent-router/v1/web` with `features.identity`:
 * - `GET /identities` → `{ data: IdentityView[] }`
 * - `DELETE /identities/:identityId` → 204; 409 `identity_from_config` | `identity_in_use`; 404 `identity_not_found`
 * - `POST /identities/pairing-codes` `{}` → 201 `{ id, code, expiresAt, instructions }`; 429 `pairing_codes_pending_limit`
 * - `GET /identities/pairing-codes` → `{ data: [{ id, createdAt, expiresAt }] }` (pending only; codes are stored hashed)
 * - `DELETE /identities/pairing-codes/:codeId` → 204; 404 `pairing_code_not_found`
 */
export function identityRoutes(router: express.Router, identity: Identities, principal: (res: express.Response) => Principal): void {
  router.get("/identities", (_req, res) => {
    const owner = principal(res);
    res.set("Cache-Control", "no-store").json({ data: identity.list(owner.personId, owner) });
  });
  router.post("/identities/pairing-codes", (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const created = identity.createCode(principal(res).ownerId);
    res.status(201).set("Cache-Control", "no-store").json({ ...created, instructions: INSTRUCTIONS(created.code) });
  });
  router.get("/identities/pairing-codes", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ data: identity.pendingCodes(principal(res).ownerId) });
  });
  router.delete("/identities/pairing-codes/:codeId", (req, res) => {
    identity.cancelCode(principal(res).ownerId, id.parse(req.params.codeId));
    res.status(204).end();
  });
  router.delete("/identities/:identityId", (req, res) => {
    const owner = principal(res);
    identity.revoke(owner.personId, id.parse(req.params.identityId), owner);
    res.status(204).end();
  });
}
