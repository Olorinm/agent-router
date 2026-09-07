import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { ClientFactory, DefaultAgentCardResolver, RestTransportFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Message, Task, TaskState } from "@a2a-js/sdk";
import { delay } from "../matrix/connector.js";
import { terminal } from "../matrix/protocol.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  "context-id": { type: "string" }, "task-id": { type: "string" }, "message-id": { type: "string" },
  detach: { type: "boolean", default: false }, "allow-execution": { type: "boolean", default: false },
  "allow-receive": { type: "boolean", default: false },
  block: { type: "boolean", default: false }, note: { type: "string", default: "" },
} });
const base = (process.env.CONNECTOR_URL ?? process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.CONNECTOR_API_TOKEN_FILE ? readFileSync(process.env.CONNECTOR_API_TOKEN_FILE, "utf8").trim() : process.env.CONNECTOR_API_TOKEN ?? "";
const authFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (new URL(url).origin !== new URL(base).origin) throw new Error("gateway_origin_mismatch");
  const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers, redirect: "error" });
};
async function api(path: string, method = "GET", body?: object): Promise<void> {
  const res = await authFetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw new Error(`connector_http_${res.status}`);
  if (res.status !== 204) process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");
}
async function main(): Promise<void> {
  const [command, target, argument] = positionals;
  if (command === "connect") { await (await import("../matrix/index.js")).runConnector(); return; }
  if (command === "doctor") return api("/health/ready");
  if (command === "status") return api("/api/status");
  if (command === "conversations") return api("/api/conversations");
  if (command === "contacts") return api("/api/contacts");
  if (command === "contact-add" && target) return api("/api/contacts", "POST", { address: target, note: values.note,
    receive: values.block ? "deny" : values["allow-receive"] ? "allow" : "ask",
    execution: values.block ? "deny" : values["allow-execution"] ? "allow" : "ask" });
  if (command === "contact-remove" && target) return api(`/api/contacts/${encodeURIComponent(target)}`, "DELETE");
  if (command === "requests") return api("/api/requests");
  if (command === "invites") return api("/api/invites");
  if (command === "invite-accept" && target) return api(`/api/invites/${encodeURIComponent(target)}/accept`, "POST");
  if ((command === "approve" || command === "reject") && target) return api(`/api/requests/${encodeURIComponent(target)}/${command}`, "POST");
  if (!target || !["send", "get", "list", "cancel"].includes(command ?? "")) {
    throw new Error("Usage: matrix connect | doctor | send MXID TEXT [--context-id ID] [--task-id ID] [--detach] | get MXID TASK_ID | list MXID | cancel MXID TASK_ID | contacts | contact-add MXID [--allow-execution] | requests | approve REQUEST_ID | invites | invite-accept ROOM_ID");
  }
  const client = await new ClientFactory({ cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
    transports: [new RestTransportFactory({ fetchImpl: authFetch }), new JsonRpcTransportFactory({ fetchImpl: authFetch })] })
    .createFromUrl(`${base}/agents/${encodeURIComponent(target)}/`);
  if (command === "list") {
    const result = await client.listTasks({ pageSize: 100, pageToken: "", contextId: values["context-id"] ?? "", tenant: "", includeArtifacts: true, status: 0, statusTimestampAfter: "" });
    process.stdout.write(JSON.stringify({ ...result, tasks: result.tasks.map(Task.toJSON) }, null, 2) + "\n"); return;
  }
  if (!argument) throw new Error("message_or_task_id_required");
  if (command === "get" || command === "cancel") {
    const result = command === "get" ? await client.getTask({ id: argument, tenant: "", historyLength: 20 })
      : await client.cancelTask({ id: argument, tenant: "", metadata: {} });
    process.stdout.write(JSON.stringify(Task.toJSON(result), null, 2) + "\n"); return;
  }
  const text = argument === "-" ? readFileSync(0, "utf8") : argument;
  let result = await client.sendMessage({ message: Message.fromJSON({ role: "ROLE_USER", messageId: values["message-id"] ?? crypto.randomUUID(),
    contextId: values["context-id"] ?? "", taskId: values["task-id"] ?? "", parts: [{ text }] }),
    configuration: { returnImmediately: true, acceptedOutputModes: [], historyLength: 20, taskPushNotificationConfig: undefined }, metadata: {}, tenant: "" });
  if (!("messageId" in result) && !values.detach) {
    process.stderr.write(`Task ${result.id}; context ${result.contextId}\n`);
    const deadline = Date.now() + 600_000;
    while (!terminal(result) && result.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED && result.status?.state !== TaskState.TASK_STATE_AUTH_REQUIRED) {
      if (Date.now() > deadline) throw new Error("wait_timed_out_task_remains_available");
      await delay(500); result = await client.getTask({ id: result.id, tenant: "", historyLength: 20 });
    }
  }
  process.stdout.write(JSON.stringify("messageId" in result ? Message.toJSON(result) : Task.toJSON(result), null, 2) + "\n");
}
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "command_failed"}\n`); process.exitCode = 1; });
