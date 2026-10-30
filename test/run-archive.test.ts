import { afterEach, expect, it } from "vitest";
import { DurableStore } from "../src/communication/store.js";
import { CliWork } from "../src/execution/work.js";
import { RunObservation } from "../src/execution/observation.js";
import { compactRunEvents, runArchive } from "../src/execution/run-archive.js";
import { ChannelHttpError } from "../src/channels/http.js";
import type { HostPort } from "../src/execution/host.js";

const close: Array<() => void> = [];
afterEach(() => { close.splice(0).forEach((fn) => fn()); });
const note = (method: string, params: Record<string, unknown>) => ({ type: "native.notification", runId: "run-1", notification: { method, params } });

it("compacts streaming fragments in order, drops usage noise and bounds large values", () => {
  const { events, truncated } = compactRunEvents([
    { type: "assistant.delta", runId: "run-1", text: "Let me " }, { type: "assistant.delta", runId: "run-1", text: "check." },
    note("thread/tokenUsage/updated", { usage: 1 }),
    note("item/agentMessage/delta", { itemId: "a", delta: "Pl" }), note("item/agentMessage/delta", { itemId: "a", delta: "an" }),
    { type: "native.tool", runId: "run-1", phase: "finished", callId: "cmd", native: { aggregatedOutput: "x".repeat(20_000) } },
    { type: "assistant.delta", runId: "run-1", text: "Done." },
  ]);
  expect(events.map(({ event }) => event.type)).toEqual(["assistant.delta", "native.notification", "native.tool", "assistant.delta"]);
  expect(events[0]!.event.text).toBe("Let me check.");
  expect((events[1]!.event.notification as any).params.delta).toBe("Plan");
  expect(String((events[2]!.event.native as any).aggregatedOutput)).toMatch(/…\[truncated\]$/);
  expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
  expect(truncated).toBe(true);
});

it("serves a finished run's history from Router while the Host is asleep", async () => {
  const store = new DurableStore(":memory:", "archive"); close.push(() => store.close());
  const work = new CliWork(store, () => "allow");
  store.set("communication_runs", "claim-1", { claimId: "claim-1", taskId: "task-1", contextId: "c-main", sessionId: "h-main", phase: "finished", runId: "run-1" });
  store.set("execution_sessions", "c-main", { sessionId: "h-main", runtimeId: "native" });
  let asleep = false, eventReads = 0;
  const sleeping = () => { if (asleep) throw new ChannelHttpError(409, "environment_not_ready"); };
  const host = {
    get: async (id: string) => { sleeping(); return { id, sessionId: "h-main", runtimeId: "native", status: "completed", answer: "Plan ready." }; },
    calls: async () => { sleeping(); return [{ id: "approval", runId: "run-1", kind: "interaction", name: "approval", input: {}, status: "completed", deadlineAt: "2026-10-30T00:00:00Z" }]; },
    events: async (_id: string, after: number) => {
      sleeping(); eventReads++;
      const all = [{ type: "turn.started", runId: "run-1" }, note("item/completed", { item: { id: "f", type: "agentMessage", phase: "final_answer", text: "Plan ready." } }), { type: "other-run", runId: "run-2" }];
      return { events: all.map((event, index) => ({ sequence: index + 1, event })).filter((item) => item.sequence > after), cursor: 3, hasMore: false, historyTruncated: false };
    },
  } as unknown as HostPort;
  const observation = new RunObservation(store, work, host);
  const first = await observation.events("claim-1", 0, 200);
  expect(first.events.map(({ event }) => event.type)).toEqual(["turn.started", "native.notification"]);
  expect(runArchive(store, "claim-1")?.runId).toBe("run-1");
  asleep = true;
  expect((await observation.run("claim-1")).run.answer).toBe("Plan ready.");
  expect((await observation.run("claim-1")).calls).toHaveLength(1);
  expect(await observation.events("claim-1", 1, 200)).toMatchObject({ cursor: 2, hasMore: false, historyTruncated: false });
  expect(eventReads).toBe(1);

  // A running run is never served from (or written to) the archive.
  store.set("communication_runs", "claim-2", { claimId: "claim-2", taskId: "task-2", contextId: "c-main", sessionId: "h-main", phase: "running", runId: "run-2" });
  await expect(observation.events("claim-2", 0, 200)).rejects.toThrow("environment_not_ready");
  expect(runArchive(store, "claim-2")).toBeUndefined();
});
