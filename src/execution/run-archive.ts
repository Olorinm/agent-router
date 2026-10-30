import type { DurableStore } from "../communication/store.js";
import type { HostCall, HostPort, HostRun } from "./host.js";

/** Router's own copy of a finished run, so history stays readable while the Host sleeps. */
export interface RunArchive {
  runId: string;
  run: HostRun;
  calls: HostCall[];
  events: Array<{ sequence: number; event: Record<string, unknown> }>;
  truncated: boolean;
  bytes: number;
  archivedAt: string;
}

const collection = "communication_run_archives";
const maxBytes = 512 * 1024, maxString = 16_000, maxPages = 200;
// Streaming fragments are merged; final items, tool events and interactions are kept as-is.
const mergedTypes = new Set(["assistant.delta", "reasoning.delta"]);
const mergedMethods = new Set(["item/agentMessage/delta", "item/commandExecution/outputDelta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/plan/delta"]);
const droppedMethods = new Set(["thread/tokenUsage/updated", "account/rateLimits/updated"]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function clamp(value: unknown): unknown {
  if (typeof value === "string") return value.length > maxString ? `${value.slice(0, maxString)}…[truncated]` : value;
  if (Array.isArray(value)) return value.map(clamp);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clamp(item)]));
  return value;
}

/** Fragment key: consecutive fragments with the same key become one event. */
function fragment(event: Record<string, unknown>): string | undefined {
  if (mergedTypes.has(String(event.type))) return String(event.type);
  if (event.type !== "native.notification") return undefined;
  const notification = record(event.notification), params = record(notification.params);
  return mergedMethods.has(String(notification.method)) ? `${notification.method}:${params.itemId ?? ""}:${event.threadId ?? params.threadId ?? ""}` : undefined;
}

export function compactRunEvents(events: Array<Record<string, unknown>>) {
  const compact: Array<Record<string, unknown>> = [];
  let previous: string | undefined;
  for (const event of events) {
    const notification = record(event.notification);
    if (event.type === "native.notification" && droppedMethods.has(String(notification.method))) continue;
    const key = fragment(event), last = compact.at(-1);
    if (key && key === previous && last) {
      if (mergedTypes.has(String(event.type))) last.text = String(last.text ?? "") + String(event.text ?? "");
      else {
        const params = record(record(last.notification).params);
        params.delta = String(params.delta ?? "") + String(record(notification.params).delta ?? "");
      }
      continue;
    }
    previous = key;
    compact.push(structuredClone(event));
  }
  const kept: Array<{ sequence: number; event: Record<string, unknown> }> = [];
  let bytes = 0, truncated = false;
  for (const event of compact) {
    const value = clamp(event) as Record<string, unknown>, size = Buffer.byteLength(JSON.stringify(value));
    if (size !== Buffer.byteLength(JSON.stringify(event))) truncated = true;
    if (bytes + size > maxBytes) { truncated = true; break; }
    bytes += size; kept.push({ sequence: kept.length + 1, event: value });
  }
  return { events: kept, truncated, bytes };
}

export function runArchive(store: DurableStore, claimId: string): RunArchive | undefined {
  return store.get<RunArchive>(collection, claimId);
}

/** Copies a terminal run from the Host. Running runs are never archived. */
export async function archiveRun(store: DurableStore, host: HostPort, claimId: string, runId: string): Promise<RunArchive | undefined> {
  const existing = runArchive(store, claimId);
  if (existing?.runId === runId) return existing;
  if (!host.events) return undefined;
  const run = await host.get(runId);
  if (run.status === "running") return undefined;
  const calls = (await host.calls(runId)).filter((call) => call.runId === runId);
  const events: Array<Record<string, unknown>> = [];
  let after = 0, historyTruncated = false;
  for (let page = 0; page < maxPages; page++) {
    const result = await host.events(runId, after, 500);
    historyTruncated ||= result.historyTruncated;
    for (const item of result.events) if (item.event.runId === runId) events.push(item.event);
    if (!result.hasMore) break;
    after = result.cursor;
  }
  const compact = compactRunEvents(events);
  const archive: RunArchive = { runId, run, calls: calls.map((call) => clamp(call) as HostCall), events: compact.events,
    truncated: compact.truncated || historyTruncated, bytes: compact.bytes, archivedAt: new Date().toISOString() };
  store.set(collection, claimId, archive);
  return archive;
}

export function archivedEvents(archive: RunArchive, after: number, limit: number) {
  const events = archive.events.filter((item) => item.sequence > after).slice(0, limit);
  const cursor = events.at(-1)?.sequence ?? after;
  return { events, cursor, hasMore: cursor < archive.events.length, historyTruncated: archive.truncated };
}
