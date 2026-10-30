import type { HostCall } from "./host.js";
export interface HostTool { name: string; namespace?: string; deferLoading?: boolean; description: string; inputSchema: unknown; timeoutMs: number; }
export interface HostToolResult { success: boolean; contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>; }
export interface HostTools {
  definitions: HostTool[];
  instructions: string;
  allowed(conversationId: string, taskId: string): boolean;
  execute(call: HostCall): Promise<HostToolResult>;
}
