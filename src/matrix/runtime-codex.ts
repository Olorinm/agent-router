import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ConnectorStore } from "./store.js";

/** A2A context -> persisted Codex session, using the official CLI's JSON and resume interfaces. */
export class CodexSessionRuntime {
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(private readonly store: ConnectorStore) {}
  cancel(taskId: string): void { this.children.get(taskId)?.kill("SIGTERM"); }
  async run(taskId: string, contextId: string, prompt: string): Promise<string> {
    if (prompt.length > 20_000) throw new Error("codex_prompt_too_large");
    const session = this.store.get<string>("codex_sessions", contextId);
    const args = ["exec", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
      ...(session ? ["resume", session] : []), "--skip-git-repo-check", "--json", "-"];
    const child = spawn(process.env.CODEX_BIN ?? "codex", args, { cwd: process.env.CODEX_WORKSPACE ?? "/workspace",
      env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.children.set(taskId, child);
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, Number(process.env.CODEX_TIMEOUT_MS ?? "240000"));
    let pending = "", output = "", bytes = 0, protocolError = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) { protocolError = true; child.kill("SIGTERM"); return; }
      pending += chunk.toString();
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            if (session && session !== event.thread_id) { protocolError = true; child.kill("SIGTERM"); return; }
            this.store.set("codex_sessions", contextId, event.thread_id);
          }
          if (event.type === "item.completed" && event.item?.type === "agent_message") output = event.item.text;
          if (event.type === "turn.failed") protocolError = true;
        } catch { protocolError = true; }
      }
    });
    // Runtime stderr may contain prompt or provider data; drain it without exposing it to peer messages/logs.
    child.stderr.resume();
    child.stdin.end(`This is a bounded conversation-memory verification. Answer only the requested text; do not inspect files or call tools.\n\n${prompt}`);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      this.store.set("runtime_runs", taskId, { contextId, code, timedOut, protocolError, hasOutput: Boolean(output), session: this.store.get("codex_sessions", contextId) });
      if (code !== 0 || protocolError || !output || !this.store.get("codex_sessions", contextId)) throw new Error("codex_session_execution_failed");
      return output;
    } finally { clearTimeout(deadline); this.children.delete(taskId); }
  }
}
