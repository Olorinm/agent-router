import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import express, { type RequestHandler } from "express";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
  type Task,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from "@a2a-js/sdk/server/express";

const port = integerEnv("PORT", 8080);
const publicBaseUrl = requiredEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
const endpointToken = requiredEnv("ENDPOINT_BEARER_TOKEN");
const timeoutMs = integerEnv("CODEX_TIMEOUT_MS", 240_000);
const maxPromptChars = integerEnv("MAX_PROMPT_CHARS", 20_000);
const codexBinary = process.env.CODEX_BIN?.trim() || "/app/node_modules/.bin/codex";

const card: AgentCard = {
  name: "Isolated Codex Verifier",
  description: "A minimal, isolated Codex employee used to verify durable Agent Router delivery.",
  supportedInterfaces: [
    {
      url: `${publicBaseUrl}/a2a/rest`,
      protocolBinding: "HTTP+JSON",
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
    {
      url: `${publicBaseUrl}/a2a/jsonrpc`,
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  provider: { organization: "Example operator", url: publicBaseUrl },
  version: "1.0.0",
  documentationUrl: "",
  capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
  securitySchemes: {
    Bearer: {
      scheme: {
        $case: "httpAuthSecurityScheme",
        value: { description: "Router-to-employee bearer credential.", scheme: "bearer", bearerFormat: "opaque" },
      },
    },
  },
  securityRequirements: [{ schemes: { Bearer: { list: [] } } }],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain", "task-status"],
  skills: [
    {
      id: "codex-verification",
      name: "Codex verification",
      description: "Runs a bounded, non-interactive Codex task in a read-only container.",
      tags: ["codex", "verification"],
      examples: ["Reply exactly ROUTER_CODEX_OK"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain", "task-status"],
      securityRequirements: [{ schemes: { Bearer: { list: [] } } }],
    },
  ],
  signatures: [],
  iconUrl: "",
};

class CodexExecutor implements AgentExecutor {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cancelled = new Set<string>();

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    const task: Task = context.task ?? {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
      artifacts: [],
      history: [userMessage],
      metadata: userMessage.metadata,
    };
    eventBus.publish(AgentEvent.task(task));
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined },
        metadata: {},
      }),
    );

    try {
      const prompt = textFromMessage(userMessage).slice(0, maxPromptChars);
      if (!prompt) throw new Error("text_prompt_required");
      const output = await this.runCodex(taskId, prompt);
      if (this.cancelled.has(taskId)) return;
      const artifact: Artifact = {
        artifactId: crypto.randomUUID(),
        name: "Codex result",
        description: "Final response from the isolated Codex employee.",
        parts: [textPart(output)],
        metadata: {},
        extensions: [],
      };
      eventBus.publish(
        AgentEvent.artifactUpdate({ taskId, contextId, artifact, lastChunk: true, append: false, metadata: {} }),
      );
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            timestamp: new Date().toISOString(),
            message: agentMessage(taskId, contextId, output),
          },
          metadata: {},
        }),
      );
    } catch (error) {
      if (this.cancelled.has(taskId)) return;
      const code = error instanceof Error ? error.message.slice(0, 200) : "codex_execution_failed";
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_FAILED,
            timestamp: new Date().toISOString(),
            message: agentMessage(taskId, contextId, `Codex execution failed: ${code}`),
          },
          metadata: {},
        }),
      );
    } finally {
      this.processes.delete(taskId);
      this.cancelled.delete(taskId);
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.cancelled.add(taskId);
    this.processes.get(taskId)?.kill("SIGTERM");
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: "",
        status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined },
        metadata: {},
      }),
    );
  }

  private async runCodex(taskId: string, prompt: string): Promise<string> {
    const outputPath = `/tmp/codex-${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`;
    const child = spawn(
      codexBinary,
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--output-last-message",
        outputPath,
        "-",
      ],
      { cwd: "/workspace", env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.processes.set(taskId, child);
    child.stdin.end(
      `You are a minimal verification employee. Complete only the requested response; do not inspect the environment or call tools.\n\n${prompt}`,
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.stdout.resume();
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    if (exitCode !== 0) throw new Error(`codex_exit_${exitCode}:${redact(stderr)}`);
    try {
      const output = (await readFile(outputPath, "utf8")).trim();
      if (!output) throw new Error("codex_empty_output");
      return output;
    } finally {
      await unlink(outputPath).catch(() => undefined);
    }
  }
}

const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new CodexExecutor());
const app = express();
app.disable("x-powered-by");
app.get("/health/live", (_request, response) => response.json({ status: "ok" }));
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 60 } }));
app.use("/a2a/rest", requireBearer(endpointToken), restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.use("/a2a/jsonrpc", requireBearer(endpointToken), jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.use((_request, response) => response.status(404).json({ error: "not_found" }));
app.listen(port, "0.0.0.0", () => process.stdout.write(`${JSON.stringify({ event: "employee.listening", port })}\n`));

function requireBearer(expected: string): RequestHandler {
  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  return (request, response, next) => {
    const actual = Buffer.from(request.header("authorization") ?? "");
    if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function textFromMessage(message: Message): string {
  return message.parts
    .filter((part) => part.content?.$case === "text")
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("\n")
    .trim();
}

function textPart(text: string) {
  return { content: { $case: "text" as const, value: text }, mediaType: "text/plain", filename: "", metadata: {} };
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: crypto.randomUUID(),
    taskId,
    contextId,
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}_invalid`);
  return value;
}

function redact(value: string): string {
  return value.replace(/(Bearer\s+|sk-|ogr_)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]").slice(0, 1000);
}
