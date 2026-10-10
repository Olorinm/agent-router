import { z } from "zod";
import { createHash } from "node:crypto";
import type { HostCall } from "../../execution/host.js";
import type { HostTool, HostToolResult } from "../../execution/tools.js";
import { FeishuAccount } from "./cli.js";

const services = new Set(["approval", "apps", "attendance", "base", "calendar", "contact", "docs", "drive", "im", "mail", "markdown",
  "mindnotes", "minutes", "note", "okr", "sheets", "slides", "task", "vc", "whiteboard", "wiki", "schema", "skills"]);
const argsSchema = z.object({ args: z.array(z.string().max(100_000)).min(1).max(100) }).strict();
export class FeishuTools {
  readonly definition: HostTool;
  constructor(readonly id: string, readonly account: FeishuAccount) {
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
    return { success: result.code === 0, contentItems: [{ type: "inputText", text: output.slice(0, 500_000) || `lark_cli_exit_${result.code}` }] };
  }
}
