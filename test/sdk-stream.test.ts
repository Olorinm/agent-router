import { expect, test, vi } from "vitest";
import { AgentRouterClient, taskText } from "../packages/sdk/src/index.js";

test("watch consumes A2A task/status/artifact events through one subscription", async () => {
  const methods: string[] = [];
  const initial = { id: "task", contextId: "context", status: { state: "TASK_STATE_WORKING" }, artifacts: [] };
  const client = new AgentRouterClient({ baseUrl: "https://agents.example/_agent-router/v1", accessToken: "token", fetch: async (_url, init) => {
    const rpc = JSON.parse(String(init?.body)); methods.push(rpc.method);
    if (rpc.method === "GetTask") {
      if (methods.length > 1) throw new Error("must subscribe, not poll");
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: initial });
    }
    expect(rpc.method).toBe("SubscribeToTask");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    const updates = [
      { task: initial },
      { artifactUpdate: { taskId: "task", contextId: "context", artifact: { artifactId: "answer", parts: [{ text: "Hello" }] } } },
      { artifactUpdate: { taskId: "task", contextId: "context", append: true, artifact: { artifactId: "answer", parts: [{ text: " world" }] } } },
      { statusUpdate: { taskId: "task", contextId: "context", status: { state: "TASK_STATE_COMPLETED" } } },
    ];
    const bytes = new TextEncoder().encode(updates.map(result => `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`).join(""));
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const tasks = [];
  for await (const task of client.watch({ agentId: "sender", address: "owner/agent@agents.example", resolvedTarget: { address: "owner/agent@agents.example", matrixId: "@agent:agents.example" }, taskId: "task" })) tasks.push(task);
  expect(methods).toEqual(["GetTask", "SubscribeToTask"]);
  expect(taskText(tasks.at(-1)!)).toBe("Hello\n\n world");
  expect(tasks.at(-1)?.status.state).toBe("TASK_STATE_COMPLETED");
});

test("settled tasks are returned without opening a subscription", async () => {
  let requests=0;
  const client=new AgentRouterClient({baseUrl:"https://agents.example/_agent-router/v1",accessToken:"token",fetch:async (_url,init)=>{
    const rpc=JSON.parse(String(init?.body));requests++;
    return Response.json({jsonrpc:"2.0",id:rpc.id,result:{id:"task",contextId:"context",status:{state:"TASK_STATE_INPUT_REQUIRED"}}});
  }});
  for await(const task of client.watch({agentId:"sender",address:"owner/agent@agents.example",resolvedTarget:{address:"owner/agent@agents.example",matrixId:"@agent:agents.example"},taskId:"task"})) expect(task.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
  expect(requests).toBe(1);
});

test("broken subscriptions back off and stop after five reconnects", async () => {
  vi.useFakeTimers();
  try {
    const subscribedAt: number[] = [];
    const client = new AgentRouterClient({baseUrl:"https://agents.example/_agent-router/v1",accessToken:"token",fetch:async (_url,init)=>{
      const rpc=JSON.parse(String(init?.body));
      if(rpc.method==="GetTask")return Response.json({jsonrpc:"2.0",id:rpc.id,result:{id:"task",contextId:"context",status:{state:"TASK_STATE_WORKING"}}});
      subscribedAt.push(Date.now());
      return new Response("",{headers:{"content-type":"text/event-stream"}});
    }});
    const observing=(async()=>{for await(const _ of client.watch({agentId:"sender",address:"owner/agent@agents.example",resolvedTarget:{address:"owner/agent@agents.example",matrixId:"@agent:agents.example"},taskId:"task"})) { /* consume snapshots */ }})();
    const rejected=expect(observing).rejects.toThrow("connection_unavailable");
    await vi.runAllTimersAsync(); await rejected;
    expect(subscribedAt.map((at,index)=>index?at-subscribedAt[index-1]!:0)).toEqual([0,1000,2000,4000,8000,16000]);
  } finally {vi.useRealTimers();}
});
