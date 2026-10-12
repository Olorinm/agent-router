import type { MediaContent } from "./types.js";

export const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
export async function readBytes(source: AsyncIterable<Uint8Array>, limit = MAX_MEDIA_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > limit) throw new Error("attachment_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function download(url: string, options: RequestInit = {}, limit = MAX_MEDIA_BYTES): Promise<Buffer> {
  const response = await fetch(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("attachment_download_failed");
  if (Number(response.headers.get("content-length")) > limit) throw new Error("attachment_too_large");
  return readBytes(response.body, limit);
}
export function mediaContent(name: string, mediaType: string, bytes: Buffer): MediaContent {
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error("attachment_too_large");
  // Native providers often omit image MIME types; infer them from the actual bytes.
  if (mediaType === "image/*" || mediaType === "application/octet-stream") {
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mediaType = "image/png";
    else if (bytes[0] === 255 && bytes[1] === 216) mediaType = "image/jpeg";
    else if (bytes.subarray(0, 3).toString() === "GIF") mediaType = "image/gif";
    else if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") mediaType = "image/webp";
  }
  let boundedName = "";
  for (const character of name) { if (Buffer.byteLength(boundedName + character) > 200) break; boundedName += character; }
  return { name: boundedName || "attachment", mediaType, data: bytes.toString("base64") };
}
