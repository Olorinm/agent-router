import { expect, it } from "vitest";
import { AgentRouterClient } from "../packages/sdk/src/index.js";

it("recovers a known task through its home gateway while the recipient directory is unavailable", async () => {
  const target = { id: "recipient", owner: "@owner:remote.example", name: "coder", address: "owner/coder@remote.example", matrixId: "@agent:remote.example" };
  let directoryAvailable = true;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const client = new AgentRouterClient({ baseUrl: "https://home.example/_agent-router/v1", accessToken: "home-only", fetch: async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    if (url.startsWith("https://remote.example/")) {
      if (!directoryAvailable) throw new Error("directory offline");
      return Response.json(target);
    }
    const rpc = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { id: "task-1", contextId: "context-1", status: { state: "TASK_STATE_COMPLETED" } } });
  } });
  const resolved = await client.resolve(target.address);
  directoryAvailable = false;
  // A persisted contact can restore this handle in a fresh client after restart.
  const task = await client.get({ agentId: "sender", address: target.address, resolvedTarget: JSON.parse(JSON.stringify(resolved)), taskId: "task-1" });
  expect(task.id).toBe("task-1");
  expect(calls).toEqual([
    { url: "https://remote.example/_agent-router/v1/directory?address=owner%2Fcoder%40remote.example", authorization: null },
    { url: "https://home.example/_agent-router/v1/agents/sender/gateway/agents/%40agent%3Aremote.example/a2a/jsonrpc", authorization: "Bearer home-only" },
  ]);
  await expect(client.get({ agentId: "sender", address: target.address, resolvedTarget: { ...target, matrixId: "@wrong:other.example" }, taskId: "task-1" })).rejects.toMatchObject({ code: "invalid_agent_target" });
  expect(calls).toHaveLength(2);
});
