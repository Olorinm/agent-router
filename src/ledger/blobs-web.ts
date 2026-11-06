import type express from "express";
import { rateLimit } from "express-rate-limit";
import { WorkError } from "../execution/work.js";
import { ATTACHMENT_LIMITS, type OwnerAttachments } from "./blobs-hub.js";
import type { BlobRange } from "./blobs.js";

/** Same-origin download headers (ADR 16.5): only these types render inline; everything else downloads. */
const inline = (type: string) => /^(image|audio|video)\//.test(type) || type === "application/pdf";
const mediaType = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,96}$/;
/** `X-File-Name: UTF-8''<pct-encoded>` (RFC 8187) or plain ASCII. Path separators and controls are removed; ≤ 200 bytes. */
export function fileName(header: string | undefined): string {
  let name = header ?? "";
  const encoded = /^UTF-8''(.*)$/i.exec(name);
  if (encoded) { try { name = decodeURIComponent(encoded[1]!); } catch { throw new WorkError("invalid_file_name", 400); } }
  else if (/[^\x00-\x7e]/.test(name)) throw new WorkError("invalid_file_name", 400);
  name = name.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
  if (name === "." || name === "..") name = "";
  let bounded = "";
  for (const character of name) { if (Buffer.byteLength(bounded + character) > 200) break; bounded += character; }
  return bounded || "attachment";
}
/** A single `bytes=` range; multiple ranges are not supported and are answered with the whole body. */
export function parseRange(header: string | undefined, size: number): BlobRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) { const suffix = Number(match[2]); if (suffix === 0) throw new WorkError("range_not_satisfiable", 416); return { start: Math.max(0, size - suffix) }; }
  return { start: Number(match[1]), ...(match[2] ? { end: Number(match[2]) } : {}) };
}
const disposition = (type: string, name: string) =>
  `${inline(type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

/**
 * ADR 0005 16.5 upload and download routes, mounted on the authenticated web router (`/_agent-router/v1/web`).
 * `attachments` is undefined while the `attachments` feature is off; the routes then answer 404 `attachments_disabled`.
 */
export function attachmentRoutes(router: express.Router, attachments: OwnerAttachments | undefined,
  principal: (res: express.Response) => { ownerId: string; personId: string }): void {
  const enabled = (res: express.Response) => { if (!attachments) { res.set("Connection", "close"); throw new WorkError("attachments_disabled", 404); } return attachments; };
  const uploads = rateLimit({ windowMs: 60_000, limit: ATTACHMENT_LIMITS.uploadsPerMinute, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (_req, res) => principal(res).personId, message: { error: "rate_limit_exceeded" } });
  router.post("/attachments", uploads, async (req, res) => {
    const store = enabled(res);
    // Early rejections close the connection, so an unread body never reaches the next request.
    const reject = (code: string, status: number) => { res.set("Connection", "close"); req.resume(); return new WorkError(code, status); };
    const length = req.headers["content-length"];
    if (req.headers["transfer-encoding"] || length === undefined || !/^\d{1,12}$/.test(length)) throw reject("content_length_required", 411);
    const size = Number(length);
    if (size > ATTACHMENT_LIMITS.uploadBytes) throw reject("attachment_too_large", 413);
    const type = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    if (!mediaType.test(type)) throw reject("invalid_content_type", 400);
    const sha = req.headers["x-sha256"];
    if (sha !== undefined && (typeof sha !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha))) throw reject("invalid_sha256", 400);
    let name: string;
    try { name = fileName(typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : undefined); }
    catch (error) { res.set("Connection", "close"); req.resume(); throw error; }
    try {
      const meta = await store.upload(principal(res), req, { size, contentType: type, name, ...(sha ? { sha256: sha.toLowerCase() } : {}) });
      res.status(201).json({ ...meta, url: `/_agent-router/v1/web/attachments/${meta.attachmentId}` });
    } catch (error) { if (!req.readableEnded) { res.set("Connection", "close"); req.resume(); } throw error; }
  });
  router.get("/attachments/:attachmentId", async (req, res) => {
    const store = enabled(res), owner = principal(res);
    const meta = await store.resolve(owner, req.params.attachmentId!);
    let range: BlobRange | undefined;
    try { range = req.headers.range ? parseRange(req.headers.range, meta.size) : undefined; }
    catch (error) { res.set("Content-Range", `bytes */${meta.size}`); throw error; }
    let blob;
    try { blob = await store.open(owner, meta, range); }
    catch (error) { if (error instanceof WorkError && error.status === 416) res.set("Content-Range", `bytes */${meta.size}`); throw error; }
    res.status(range ? 206 : 200).set({
      "Content-Length": String(blob.size === 0 ? 0 : blob.end - blob.start + 1),
      "Content-Disposition": disposition(meta.contentType, meta.name),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Accept-Ranges": "bytes",
      ETag: `"sha256:${meta.sha256}"`,
      ...(range ? { "Content-Range": `bytes ${blob.start}-${blob.end}/${blob.size}` } : {}),
    });
    // Set directly: `res.set` would append a charset to text types.
    res.setHeader("Content-Type", meta.contentType || "application/octet-stream");
    blob.body.on("error", () => res.destroy());
    res.on("close", () => blob.body.destroy());
    blob.body.pipe(res);
  });
}
