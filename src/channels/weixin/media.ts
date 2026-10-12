// Tencent iLink CDN protocol; crypto and URL helpers are vendored from the pinned MIT plugin.
import { randomBytes, createHash } from "node:crypto";
import { decryptAesEcb, encryptAesEcb, aesEcbPaddedSize } from "./vendor/aes-ecb.js";
import { buildCdnDownloadUrl, buildCdnUploadUrl } from "./vendor/cdn-url.js";
import { getUploadUrl } from "./vendor/api.js";
import type { CDNMedia, MessageItem } from "./vendor/types.js";
import { UploadMediaType, MessageItemType } from "./vendor/types.js";
import { download, mediaContent, MAX_MEDIA_BYTES } from "../../communication/media.js";
import type { AttachmentReference, MediaContent } from "../../communication/types.js";
import type { WeixinCredentials } from "./index.js";

const cdn = "https://novac2c.cdn.weixin.qq.com/c2c";
function trusted(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".weixin.qq.com") || parsed.username || parsed.password) throw new Error("weixin_cdn_origin_invalid");
  return url;
}
export async function readWeixinMedia(attachment: AttachmentReference) {
  const reference = attachment.data?.media as CDNMedia | undefined;
  if (!reference) throw new Error("weixin_media_reference_missing");
  let bytes = await download(trusted(reference.full_url || buildCdnDownloadUrl(reference.encrypt_query_param ?? "", cdn)), {}, MAX_MEDIA_BYTES + 16);
  const rawHex = attachment.data?.aeskey;
  if (reference.encrypt_type === 1 && !rawHex && !reference.aes_key) throw new Error("weixin_media_key_missing");
  if (rawHex || reference.aes_key) {
    const decoded = typeof rawHex === "string" ? Buffer.from(rawHex, "hex") : Buffer.from(reference.aes_key!, "base64");
    const key = decoded.length === 32 && /^[a-f0-9]{32}$/i.test(decoded.toString()) ? Buffer.from(decoded.toString(), "hex") : decoded;
    if (key.length !== 16) throw new Error("weixin_media_key_invalid");
    bytes = decryptAesEcb(bytes, key);
  }
  return mediaContent(attachment.name, attachment.mediaType, bytes);
}
export async function uploadWeixinMedia(credentials: WeixinCredentials, target: string, item: MediaContent): Promise<MessageItem> {
  const bytes = Buffer.from(item.data, "base64"); if (bytes.length > MAX_MEDIA_BYTES) throw new Error("attachment_too_large");
  const voiceEncoding = item.mediaType === "audio/mpeg" ? 7 : item.mediaType === "audio/amr" ? 5 : item.mediaType === "audio/silk" ? 6 : undefined;
  if (item.mediaType.startsWith("audio/") && !voiceEncoding) throw new Error("weixin_voice_encoding_unsupported");
  const type = item.mediaType.startsWith("image/") ? UploadMediaType.IMAGE : item.mediaType.startsWith("video/") ? UploadMediaType.VIDEO : item.mediaType.startsWith("audio/") ? UploadMediaType.VOICE : UploadMediaType.FILE;
  const filekey = randomBytes(16).toString("hex"), aeskey = randomBytes(16);
  const url = await getUploadUrl({ baseUrl: credentials.baseUrl, token: credentials.token, filekey, to_user_id: target, media_type: type,
    rawsize: bytes.length, rawfilemd5: createHash("md5").update(bytes).digest("hex"), filesize: aesEcbPaddedSize(bytes.length), no_need_thumb: true, aeskey: aeskey.toString("hex") });
  if (!url.upload_full_url && !url.upload_param) throw new Error("weixin_upload_url_missing");
  const response = await fetch(trusted(url.upload_full_url || buildCdnUploadUrl({ cdnBaseUrl: cdn, uploadParam: url.upload_param!, filekey })), {
    method: "POST", body: new Uint8Array(encryptAesEcb(bytes, aeskey)), headers: { "content-type": "application/octet-stream" }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const param = response.headers.get("x-encrypted-param");
  if (!response.ok || !param) throw new Error("weixin_upload_failed");
  const media: CDNMedia = { encrypt_query_param: param, aes_key: aeskey.toString("base64"), encrypt_type: 1 };
  if (type === UploadMediaType.IMAGE) return { type: MessageItemType.IMAGE, image_item: { media, mid_size: aesEcbPaddedSize(bytes.length) } };
  if (type === UploadMediaType.VIDEO) return { type: MessageItemType.VIDEO, video_item: { media, video_size: bytes.length } };
  if (type === UploadMediaType.VOICE) {
    return { type: MessageItemType.VOICE, voice_item: { media, encode_type: voiceEncoding! } };
  }
  return { type: MessageItemType.FILE, file_item: { media, file_name: item.name, len: String(bytes.length) } };
}
