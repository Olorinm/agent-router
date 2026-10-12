import { z } from "zod";
import { createHash } from "node:crypto";
import { realpathSync, statSync, readFileSync } from "node:fs";
import { resolve, relative, sep, basename, extname } from "node:path";
import { mediaContent, MAX_MEDIA_BYTES } from "../../communication/media.js";
import type { MediaContent } from "../../communication/types.js";
import type { HostCall } from "../../execution/host.js";
import type { HostTool, HostToolResult } from "../../execution/tools.js";
import { FeishuAccount } from "./cli.js";

const services = new Set(["approval", "apps", "attendance", "base", "calendar", "contact", "docs", "drive", "im", "mail", "markdown",
  "mindnotes", "minutes", "note", "okr", "sheets", "slides", "task", "vc", "whiteboard", "wiki", "schema", "skills", "api", "event", "application"]);
const argsSchema = z.object({ args: z.array(z.string().max(100_000)).min(1).max(100) }).strict();
export class FeishuTools {
  readonly definition: HostTool;
  constructor(readonly id: string, readonly account: FeishuAccount, readonly transfer?: (call: HostCall, item: MediaContent) => Promise<string>) {
    const name = `feishu_${id.replaceAll("-", "_")}`;
    this.definition = { name: name.length <= 64 ? name : `${name.slice(0, 47)}_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`, timeoutMs: 180_000,
      description: "Run the official lark-cli for the owner's Feishu resources. Pass argument strings, without executable or shell syntax. Use skills read / schema / --help to inspect usage. Calls use the linked owner's user identity. Preserve the CLI's confirmation requirements: append --yes only after the owner explicitly confirms the specific operation.",
      inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 } }, required: ["args"], additionalProperties: false } };
  }
  async execute(call: HostCall): Promise<HostToolResult> {
    const parsed = argsSchema.safeParse(call.input);
    if (!parsed.success) return { success: false, contentItems: [{ type: "inputText", text: "invalid_feishu_tool_arguments" }] };
    const { args } = parsed.data;
    if (!services.has(args[0]!) || args.some((arg) => /^(--as|--profile|--user-open-id|--user|--config)(=|$)/.test(arg)) ||
      Buffer.byteLength(JSON.stringify(args)) > 200_000) return { success: false, contentItems: [{ type: "inputText", text: "invalid_feishu_tool_arguments" }] };
    // Guidance is usable before login; business operations require the exact linked user.
    const guidance = args[0] === "skills" || args[0] === "schema" || args.includes("--help") || args.includes("-h");
    if (!guidance) {
      const status = await this.account.status();
      if (!status.authorized) return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({
        error: "feishu_personal_authorization_required", connectionId: this.id, authorizationUrl: await this.account.authorizationLink(),
        instruction: "Send this exact authorization URL to the owner. The service polls automatically; retry the operation after authorization completes.",
      }) }] };
    }
    const result = await this.account.command([...args, ...(guidance ? [] : ["--as", "user"])], 60_000);
    // Preserve the official success/error envelope, including exit 10 confirmation_required.
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    if (!guidance && result.code !== 0) {
      let error: { type?: string; subtype?: string; missing_scopes?: unknown } | undefined;
      try { error = JSON.parse(result.stderr.trim()).error; } catch { /* Preserve non-JSON and partial-result output. */ }
      // User consent can fix these exact official categories. App/admin permissions require the CLI's console guidance.
      if (error?.type === "authentication" || error?.type === "authorization" && error.subtype === "missing_scope") {
        const scopes = z.array(z.string().regex(/^[a-zA-Z0-9_:.-]{1,128}$/)).max(100).safeParse(error.missing_scopes ?? []);
        if (scopes.success) return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({
          error: "feishu_personal_authorization_required", officialError: error, officialOutput: output.slice(0, 500_000), connectionId: this.id,
          authorizationUrl: await this.account.authorizationLink(scopes.data),
          instruction: "Present this exact consent URL to the owner. Do not replay this command automatically; inspect partial results before retrying any write.",
        }) }] };
      }
    }
    const contentItems: HostToolResult["contentItems"] = [{ type: "inputText", text: output.slice(0, 500_000) || `lark_cli_exit_${result.code}` }];
    if (result.code === 0 && this.transfer && args.some((arg) => /download|export|preview/.test(arg))) {
      let value: any; try { value = JSON.parse(result.stdout); } catch { /* Non-JSON formats retain their native output. */ }
      const paths = new Set<string>();
      const visit = (item: any, depth = 0) => {
        if (depth > 10 || !item || typeof item !== "object") return;
        for (const [key, child] of Object.entries(item)) {
          if (["saved_path", "output_path", "file_path", "path"].includes(key) && typeof child === "string") paths.add(child);
          else visit(child, depth + 1);
        }
      }; visit(value);
      let total = 0;
      for (const file of [...paths].slice(0, 10)) {
        const root = realpathSync(this.account.workspace), path = realpathSync(resolve(root, file)), rel = relative(root, path);
        if (rel.startsWith(`..${sep}`) || rel === ".." || rel.split(sep).some((part) => part.startsWith(".") || ["cli-data", "app-secret", "credentials.json"].includes(part))) throw new Error("feishu_artifact_outside_output_scope");
        const stat = statSync(path); total += stat.size; if (!stat.isFile() || total > MAX_MEDIA_BYTES) throw new Error("feishu_artifact_too_large");
        const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4" } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream";
        const item = mediaContent(basename(path), mime, readFileSync(path)), hostPath = await this.transfer(call, item);
        contentItems.push({ type: "inputText", text: JSON.stringify({ attachment: { name: item.name, mediaType: item.mediaType, path: hostPath } }) });
        if (item.mediaType.startsWith("image/")) contentItems.push({ type: "inputImage", imageUrl: `data:${item.mediaType};base64,${item.data}` });
      }
    }
    return { success: result.code === 0, contentItems };
  }
}
