#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { ClientFactory, DefaultAgentCardResolver, RestTransportFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Message, Task, TaskState } from "@a2a-js/sdk";
import { delay } from "../matrix/connector.js";
import { terminal } from "../matrix/protocol.js";
import { ProfileStore } from "../matrix/profile.js";
import { accountCommand } from "./matrix-account.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  "context-id": { type: "string" }, "task-id": { type: "string" }, "message-id": { type: "string" },
  "allow-execution": { type: "boolean", default: false },
  "allow-receive": { type: "boolean", default: false },
  note: { type: "string", default: "" },
  help: { type: "boolean", short: "h" }, profile: { type: "string" }, homeserver: { type: "string" },
  "password-stdin": { type: "boolean" }, "password-file": { type: "string" }, "registration-token-file": { type: "string" },
  "device-name": { type: "string" }, "connector-url": { type: "string" }, "endpoint-token-file": { type: "string" },
  "allow-local": { type: "boolean" }, "allow-http": { type: "boolean" },
  tag: { type: "string", multiple: true }, from: { type: "string" }, since: { type: "string" }, room: { type: "string" },
  worker: { type: "string" }, wait: { type: "string" }, all: { type: "boolean" }, "data-file": { type: "string" },
} });
let base: string, token: string;
const authFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (new URL(url).origin !== new URL(base).origin) throw new Error("gateway_origin_mismatch");
  const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers, redirect: "error" });
};
async function api(path: string, method = "GET", body?: object): Promise<void> {
  const res = await authFetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) {
    const error = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error && /^[a-z0-9_]+$/.test(error.error) ? error.error : `connector_http_${res.status}`);
  }
  if (res.status !== 204) process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");
}
async function main(): Promise<void> {
  const [command, target, argument] = positionals;
  if (values.help || !command) {
    process.stdout.write(`Agent network CLI:
  register SERVER USERNAME       Register with the homeserver and save this device
  login @name:server             Log in and save credentials (password prompt)
  whoami | logout                Verify identity / revoke this device's login
  discover SERVER                Discover the homeserver and its login methods
  find TEXT | lookup [MATRIX_ID]  Native user directory and public profile
  profile-set DISPLAY_NAME       Update your Matrix display name
  bind AGENT_CARD_URL            Optional: delegate execution to an existing A2A service
  configure --connector-url URL  Choose a local gateway port
  connect                        Run the saved profile's connector in the foreground
  doctor | status | contacts | conversations
  contact-add MATRIX_ID [--note TEXT] [--tag TAG] [--allow-receive] [--allow-execution]
  contact-remove MATRIX_ID       Remove a saved contact; keep room history
  blocked | block MATRIX_ID | unblock MATRIX_ID
  invites | invite-accept ROOM_ID | invite-reject ROOM_ID
  requests | approve REQUEST_ID | reject REQUEST_ID
  inbox [--all]                  See incoming work and requests awaiting approval
  claim [WORK_ID] --worker NAME [--wait SECONDS]
                                Claim work; retrying returns this worker's assignment
  work WORK_OR_CLAIM_ID          Read input, history and cancellation state
  progress CLAIM_ID TEXT         Report progress to the sender
  reply CLAIM_ID TEXT [--data-file FILE]
                                Return the result and complete the request
  need-input CLAIM_ID TEXT       Ask the sender for missing input
  fail CLAIM_ID TEXT             Report failure
  cancelled CLAIM_ID             Confirm you have stopped canceled work
  conversation-open MATRIX_ID    Create a separate direct conversation
  history ROOM_ID [--from TOKEN] | read ROOM_ID [EVENT_ID] | leave ROOM_ID
  watch [--since CURSOR] [--room ROOM_ID]
                                Observe new messages and task events as JSON lines
  send MATRIX_ID TEXT [--context-id ID] [--task-id ID] [--wait SECONDS]
                                Send to an agent; returns immediately unless --wait is set
  get MATRIX_ID TASK_ID | list MATRIX_ID | cancel MATRIX_ID TASK_ID
  agent-guide                    Print the complete self-onboarding guide

Advanced Matrix interoperability: say MATRIX_ID TEXT emits a native text event.

Use --profile NAME for separate local agent profiles (default: default).
For automation: --password-stdin or --password-file PATH; --registration-token-file PATH.
bind accepts --endpoint-token-file PATH. Secrets are never accepted as argument values.
`); return;
  }
  if (command === "agent-guide") {
    process.stdout.write(readFileSync(new URL("../../docs/guides/agent-connect.md", import.meta.url), "utf8")); return;
  }
  if (values.profile) process.env.MATRIX_PROFILE = values.profile;
  if (await accountCommand(command, positionals.slice(1), values)) return;
  if (command === "connect") { await (await import("../matrix/index.js")).runConnector(); return; }
  const saved = values.profile || process.env.MATRIX_PROFILE || (!process.env.CONNECTOR_API_TOKEN && !process.env.CONNECTOR_API_TOKEN_FILE)
    ? new ProfileStore(values.profile).require() : undefined;
  base = (saved?.connectorUrl ?? process.env.CONNECTOR_URL ?? process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  token = saved?.gatewayToken ?? (process.env.CONNECTOR_API_TOKEN_FILE ? readFileSync(process.env.CONNECTOR_API_TOKEN_FILE, "utf8").trim() : process.env.CONNECTOR_API_TOKEN ?? "");
  if (command === "doctor") return api("/health/ready");
  if (command === "status") return api("/api/status");
  if (command === "inbox") return api(`/api/inbox?all=${Boolean(values.all)}`);
  if (command === "work" && target) return api(`/api/work/${encodeURIComponent(target)}`);
  if (command === "claim") {
    if (!values.worker?.trim()) throw new Error("claim_requires_worker_name");
    return api("/api/work/claim", "POST", { worker: values.worker, ...(target ? { id: target } : {}), wait: waitSeconds(60) });
  }
  if (["progress", "reply", "need-input", "fail", "cancelled"].includes(command) && target) {
    const text = argument === "-" ? readFileSync(0, "utf8") : argument ?? "";
    const data = values["data-file"] ? JSON.parse(readFileSync(values["data-file"], "utf8")) as unknown : undefined;
    return api(`/api/work/${encodeURIComponent(target)}/update`, "POST", { action: command, text, ...(data ? { data } : {}) });
  }
  if (command === "conversations") return api("/api/conversations");
  if (command === "conversation-open" && target) return api("/api/conversations", "POST", { address: target });
  if (command === "say" && target && argument) return api("/api/messages", "POST", { address: target,
    text: argument === "-" ? readFileSync(0, "utf8") : argument, ...(values["context-id"] ? { contextId: values["context-id"] } : {}),
    ...(values["message-id"] ? { messageId: values["message-id"] } : {}) });
  if (command === "contacts") return api("/api/contacts");
  if (command === "contact-add" && target) return api("/api/contacts", "POST", { address: target, note: values.note,
    receive: values["allow-receive"] ? "allow" : "ask",
    execution: values["allow-execution"] ? "allow" : "ask", tags: values.tag ?? [] });
  if (command === "blocked") return api("/api/blocked");
  if ((command === "block" || command === "unblock") && target) return api(`/api/blocked/${encodeURIComponent(target)}`, command === "block" ? "POST" : "DELETE");
  if (command === "contact-remove" && target) return api(`/api/contacts/${encodeURIComponent(target)}`, "DELETE");
  if (command === "requests") return api("/api/requests");
  if (command === "invites") return api("/api/invites");
  if (command === "invite-accept" && target) return api(`/api/invites/${encodeURIComponent(target)}/accept`, "POST");
  if (command === "invite-reject" && target) return api(`/api/invites/${encodeURIComponent(target)}/reject`, "POST");
  if (command === "history" && target) return api(`/api/rooms/${encodeURIComponent(target)}/history${values.from ? `?from=${encodeURIComponent(values.from)}` : ""}`);
  if (command === "read" && target) return api(`/api/rooms/${encodeURIComponent(target)}/read`, "POST", argument ? { eventId: argument } : {});
  if (command === "leave" && target) return api(`/api/rooms/${encodeURIComponent(target)}/leave`, "POST");
  if (command === "watch") {
    const query = new URLSearchParams();
    if (values.since) query.set("since", values.since);
    if (values.room) query.set("room", values.room);
    const abort = new AbortController();
    const onSignal = () => abort.abort(); process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    try {
      const response = await authFetch(`${base}/api/events?${query}`, { signal: abort.signal });
      if (!response.ok || !response.body) throw new Error(`connector_http_${response.status}`);
      let pending = ""; const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (line.startsWith("data: ")) process.stdout.write(line.slice(6) + "\n");
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally { process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal); }
    return;
  }
  if ((command === "approve" || command === "reject") && target) return api(`/api/requests/${encodeURIComponent(target)}/${command}`, "POST");
  if (!target || !["send", "get", "list", "cancel"].includes(command ?? "")) {
    throw new Error("Unknown or incomplete command. Run agent-router --help.");
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
  const wait = waitSeconds(600);
  let result = await client.sendMessage({ message: Message.fromJSON({ role: "ROLE_USER", messageId: values["message-id"] ?? crypto.randomUUID(),
    contextId: values["context-id"] ?? "", taskId: values["task-id"] ?? "", parts: [{ text }] }),
    configuration: { returnImmediately: true, acceptedOutputModes: [], historyLength: 20, taskPushNotificationConfig: undefined }, metadata: {}, tenant: "" });
  if (!("messageId" in result) && wait > 0) {
    process.stderr.write(`Task ${result.id}; context ${result.contextId}\n`);
    const deadline = Date.now() + wait * 1000;
    while (!terminal(result) && result.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED && result.status?.state !== TaskState.TASK_STATE_AUTH_REQUIRED) {
      if (Date.now() > deadline) throw new Error("wait_timed_out_task_remains_available");
      await delay(500); result = await client.getTask({ id: result.id, tenant: "", historyLength: 20 });
    }
  }
  process.stdout.write(JSON.stringify("messageId" in result ? Message.toJSON(result) : Task.toJSON(result), null, 2) + "\n");
}
function waitSeconds(max: number): number {
  const value = Number(values.wait ?? "0");
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`wait_must_be_between_0_and_${max}_seconds`);
  return value;
}
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "command_failed"}\n`); process.exitCode = 1; });
