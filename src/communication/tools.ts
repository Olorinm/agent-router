import { z } from "zod";
import type { HostCall, HostPort } from "../execution/host.js";
import type { HostTool, HostToolResult } from "../execution/tools.js";
import type { CommunicationCore } from "./core.js";
import type { MediaContent } from "./types.js";
const argumentsSchema = z.object({
  operation: z.enum(["capabilities", "message", "send", "delivery", "native"]), text: z.string().max(100_000).optional(), html: z.string().max(100_000).optional(), deliveryId: z.string().optional(),
  files: z.array(z.object({ path: z.string(), name: z.string(), mediaType: z.string() }).strict()).max(30).optional(),
  card: z.record(z.string(), z.unknown()).optional(), nativeOperation: z.string().optional(), args: z.record(z.string(), z.unknown()).optional(),
}).strict();
export class ChannelTools {
  readonly definition: HostTool = { name: "channel", timeoutMs: 180_000,
    description: "Use the current conversation's native channel capabilities. Inspect capabilities and nativeArguments first. message returns the received message and native metadata. send queues text, supported HTML/cards, or files from this Host session's workspace and returns a delivery receipt. Only state=accepted confirms submission; inspect delivery with deliveryId before claiming success. native invokes an advertised operation with the described args. Never claim an unsupported channel or model capability.",
    inputSchema: z.toJSONSchema(argumentsSchema) };
  constructor(readonly core: CommunicationCore, readonly host: HostPort) {}
  async execute(call: HostCall): Promise<HostToolResult> {
    const input = argumentsSchema.parse(call.input);
    const binding = this.core.store.entries<{ runId: string; taskId: string; sessionId: string; phase: string }>("communication_runs")
      .find(({ value }) => value.runId === call.runId && value.phase === "running")?.value;
    if (!binding) throw new Error("channel_run_not_active");
    let result: unknown;
    if (input.operation === "capabilities") result = this.core.capabilities(binding.taskId);
    if (input.operation === "message") {
      const source = this.core.input(binding.taskId)?.source;
      // CDN encryption keys/context tokens are transport credentials, not model context.
      result = source && { text: source.text, quoted: source.quoted, native: source.native, event: source.event,
        attachments: source.attachments?.map(({ id, name, mediaType, kind }) => ({ id, name, mediaType, kind })) };
    }
    if (input.operation === "send") {
      const media: MediaContent[] = []; let bytes = 0;
      for (const file of input.files ?? []) {
        if (!this.host.readFile) throw new Error("host_file_transfer_unavailable");
        const content = await this.host.readFile(binding.sessionId, file.path);
        if (content.encoding !== "base64") throw new Error("host_binary_transfer_required");
        bytes += Buffer.byteLength(content.content, "base64"); if (bytes > 30 * 1024 * 1024) throw new Error("attachments_too_large");
        media.push({ name: file.name, mediaType: file.mediaType, data: content.content });
      }
      const id = this.core.queueContent(binding.taskId, { text: input.text ?? "", ...(input.html ? { html: input.html } : {}), ...(media.length ? { media } : {}), ...(input.card ? { card: input.card } : {}) }, `${call.runId}:${call.id}`);
      await this.core.flush(); result = this.core.delivery(binding.taskId, id);
    }
    if (input.operation === "delivery") result = this.core.delivery(binding.taskId, input.deliveryId ?? "");
    if (input.operation === "native") result = await this.core.native(binding.taskId, input.nativeOperation ?? "", { ...input.args, key: `${call.runId}:${call.id}` });
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result ?? { ok: true }) }] };
  }
}
