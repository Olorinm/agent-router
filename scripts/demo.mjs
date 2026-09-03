import { AgentCard, Role, TaskState } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";

const baseUrl = process.env.DEMO_BASE_URL ?? "http://127.0.0.1:8080";
const adminToken = process.env.DEMO_ADMIN_TOKEN ?? "agent-router-demo-admin-token-not-for-production";

await waitUntilReady();
const localpart = `echo-${Date.now().toString(36)}`;
const registrationResponse = await fetch(`${baseUrl}/v1/agents`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    address: localpart,
    displayName: "Demo Echo Agent",
    description: "A disposable agent registered by the local demo.",
    agentCard: {
      name: "Echo Agent",
      description: "A deterministic A2A agent for the local Agent Router demo.",
      supportedInterfaces: [
        {
          url: "http://echo-agent:8080/a2a/rest",
          protocolBinding: "HTTP+JSON",
          protocolVersion: "1.0",
        },
      ],
      provider: { organization: "Agent Router contributors", url: "http://echo-agent:8080" },
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "echo", name: "Echo", description: "Echoes text.", tags: ["demo", "echo"] }],
    },
  }),
});
if (!registrationResponse.ok) throw new Error(`registration_http_${registrationResponse.status}:${await registrationResponse.text()}`);
const registration = await registrationResponse.json();
const credential = registration.data.machineCredential;
const card = AgentCard.fromJSON(registration.data.agentCard);
const client = await new ClientFactory().createFromAgentCard(card);
const serviceParameters = { Authorization: `Bearer ${credential}` };

let result = await client.sendMessage({
  message: {
    role: Role.ROLE_USER,
    messageId: crypto.randomUUID(),
    taskId: "",
    contextId: "",
    parts: [{ content: { $case: "text", value: "hello through the router" }, mediaType: "text/plain", filename: "", metadata: {} }],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  },
  configuration: {
    acceptedOutputModes: ["text/plain"],
    returnImmediately: true,
    historyLength: 10,
    taskPushNotificationConfig: undefined,
  },
  metadata: {},
  tenant: "",
}, { serviceParameters });

if ("id" in result) {
  const deadline = Date.now() + 30_000;
  while (!terminal(result.status?.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    result = await client.getTask({ id: result.id, historyLength: 10, tenant: "" }, { serviceParameters });
  }
}

const artifactText = "artifacts" in result
  ? (result.artifacts ?? []).flatMap((artifact) => artifact.parts)
      .filter((part) => part.content?.$case === "text")
      .map((part) => part.content?.$case === "text" ? part.content.value : "")
      .join("\n")
  : "";
if (artifactText !== "Echo: hello through the router") throw new Error(`unexpected_demo_result:${artifactText}`);
process.stdout.write(`${JSON.stringify({ address: registration.data.address, result: artifactText })}\n`);

async function waitUntilReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("router_not_ready");
}

function terminal(state) {
  return state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED;
}
