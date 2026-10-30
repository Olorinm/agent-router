// Deterministic app-server protocol fixture. No model, user account, or external service is contacted.
import { createInterface } from "node:readline";
let sequence = 0;
const threads = new Map(), pending = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
createInterface({ input: process.stdin }).on("line", async line => {
  const message = JSON.parse(line), p = message.params ?? {};
  if (!message.method) { pending.get(message.id)?.(message.result); pending.delete(message.id); return; }
  if (message.method === "initialize") return reply(message.id, { userAgent: "codex/0.162.1" });
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const thread = { id: `thread-${++sequence}`, cwd: p.cwd, historyMode: "paginated", status: { type: "idle" }, turns: [] };
    threads.set(thread.id, thread); return reply(message.id, { thread });
  }
  if (message.method === "thread/list") return reply(message.id, { data: [...threads.values()], nextCursor: null });
  if (message.method === "thread/read") {
    const thread = threads.get(p.threadId);
    return reply(message.id, { thread: p.includeTurns ? thread : { ...thread, turns: [] } });
  }
  if (message.method === "thread/resume") return reply(message.id, { thread: threads.get(p.threadId) });
  if (message.method === "thread/fork") {
    const source = threads.get(p.threadId), active = source.turns.find(turn => turn.status === "inProgress");
    if (active && p.beforeTurnId !== active.id) return send({ id: message.id, error: { code: -32602, message: "active fork must exclude the current turn" } });
    const end = p.beforeTurnId ? source.turns.findIndex(turn => turn.id === p.beforeTurnId) : source.turns.length;
    const thread = { ...structuredClone(source), id: `thread-${++sequence}`, status: { type: "idle" }, turns: structuredClone(source.turns.slice(0, end)) };
    threads.set(thread.id, thread); return reply(message.id, { thread });
  }
  if (message.method === "thread/turns/list") return reply(message.id, { data: threads.get(p.threadId).turns.slice(-p.limit || undefined), nextCursor: null });
  if (message.method === "thread/items/list") return reply(message.id, { data: threads.get(p.threadId).turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))), nextCursor: null });
  if (message.method === "account/read") return reply(message.id, { account: { type: "apiKey" } });
  if (message.method === "model/list") return reply(message.id, { data: [{ id: "protocol-fixture" }] });
  if (message.method !== "turn/start") return reply(message.id, {});
  const thread = threads.get(p.threadId), turn = { id: `turn-${++sequence}`, status: "inProgress", items: [] };
  thread.status = { type: "active" }; thread.turns.push(turn);
  const input = p.toolOutput ? JSON.parse(p.toolOutput.output).message : p.input.map(item => item.text ?? "").join("\n");
  turn.items.push({ id: `input-${sequence}`, type: p.toolOutput ? "dynamicToolCall" : "userMessage", content: p.toolOutput ?? p.input });
  reply(message.id, { turn });
  let answer = `Finished: ${input}`;
  if (input === "parent") {
    const id = `call-${++sequence}`;
    const result = await new Promise(resolve => {
      pending.set(id, resolve);
      send({ id, method: "item/tool/call", params: { threadId: thread.id, turnId: turn.id, callId: id, tool: "coordinate", arguments: {} } });
    });
    answer = `Parent received child result: ${JSON.stringify(result)}`;
  }
  const item = { id: `answer-${++sequence}`, type: "agentMessage", text: answer, phase: "final_answer" };
  turn.items.push(item); turn.status = "completed"; thread.status = { type: "idle" };
  notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
  notify("turn/completed", { threadId: thread.id, turn });
});
