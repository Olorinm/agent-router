import { readFile } from "node:fs/promises";
import { AgentCard, Role, TaskState, type Message, type SendMessageResult, type Task } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";

const cardUrl = requiredEnv("ROUTER_AGENT_CARD_URL");
const credential = (await readFile(requiredEnv("ROUTER_CREDENTIAL_FILE"), "utf8")).trim();
const prompt = requiredEnv("ROUTER_PROMPT");
const returnOnly = process.env.ROUTER_RETURN_ONLY === "true";
const timeoutMs = Number(process.env.ROUTER_WAIT_TIMEOUT_MS ?? "360000");
const cardResponse = await fetch(cardUrl, { signal: AbortSignal.timeout(15_000) });
if (!cardResponse.ok) throw new Error(`agent_card_http_${cardResponse.status}`);
const card = AgentCard.fromJSON(await cardResponse.json());
const client = await new ClientFactory().createFromAgentCard(card);
const serviceParameters = { Authorization: `Bearer ${credential}` };
const requestMessage: Message = {
  role: Role.ROLE_USER,
  messageId: crypto.randomUUID(),
  taskId: "",
  contextId: "",
  parts: [{ content: { $case: "text", value: prompt }, mediaType: "text/plain", filename: "", metadata: {} }],
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
};
let result = await client.sendMessage(
  {
    message: requestMessage,
    configuration: {
      acceptedOutputModes: ["text/plain"],
      returnImmediately: true,
      historyLength: 20,
      taskPushNotificationConfig: undefined,
    },
    metadata: {},
    tenant: "",
  },
  { serviceParameters },
);
if ("messageId" in result) {
  process.stdout.write(`${JSON.stringify({ kind: "message", text: textFromMessage(result) })}\n`);
  process.exit(0);
}
if (!returnOnly) result = await pollTask(result, timeoutMs);
process.stdout.write(`${JSON.stringify(summarize(result))}\n`);

async function pollTask(initial: Task, waitMs: number): Promise<Task> {
  const deadline = Date.now() + waitMs;
  let task = initial;
  while (!terminal(task.status?.state)) {
    if (Date.now() >= deadline) return task;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    task = await client.getTask({ id: task.id, historyLength: 20, tenant: "" }, { serviceParameters });
  }
  return task;
}

function summarize(result: SendMessageResult) {
  if ("messageId" in result) return { kind: "message", text: textFromMessage(result) };
  const artifactText = (result.artifacts ?? [])
    .flatMap((artifact) => artifact.parts)
    .filter((part) => part.content?.$case === "text")
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("\n");
  return { kind: "task", taskId: result.id, state: result.status?.state, artifactText };
}

function textFromMessage(message: Message): string {
  return message.parts
    .filter((part) => part.content?.$case === "text")
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("\n");
}

function terminal(state: TaskState | undefined): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}
