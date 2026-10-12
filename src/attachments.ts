import { createHash } from "node:crypto";
import { z } from "zod";

// Stay below AgentMail's 6 MB inline request limit after Base64 and JSON overhead.
export const MAX_ATTACHMENT_BYTES = 4_000_000;
export const MAX_ATTACHMENTS = 8;
export const attachmentSchema = z.object({
  filename: z.string().min(1).max(200).refine(s => !/[\x00-\x1f\x7f/\\]/.test(s) && s !== "." && s !== ".."),
  contentType: z.string().max(160).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  content: z.string().min(4).max(5_333_336).refine(s => Buffer.from(s, "base64").toString("base64") === s),
}).strict();
export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS).refine(
  items => items.reduce((sum, a) => sum + Buffer.byteLength(a.content, "base64"), 0) <= MAX_ATTACHMENT_BYTES,
  "attachments_too_large");
export type Attachment = z.infer<typeof attachmentSchema>;
export function attachmentMetadata(items: Attachment[]) {
  return items.map(({ filename, contentType, content }) => ({ filename, contentType,
    size: Buffer.byteLength(content, "base64"), sha256: createHash("sha256").update(Buffer.from(content, "base64")).digest("hex") }));
}
