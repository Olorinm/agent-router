import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/communication/store.js";
import { AgentLedger } from "../src/ledger/ledger.js";
import { OwnerHub, type HubDirectory } from "../src/ledger/hub.js";
import { PersonRegistry } from "../src/ledger/registry.js";
import { ALPHA10_AGENT_LEDGER_V1, ALPHA10_AGENT_LEDGER_V2, ALPHA10_OWNER_HUB_V1, ALPHA10_REGISTRY_V1 } from "./fixtures/schema-0.7.0-alpha.10.js";

/**
 * Every ledger, hub and registry migration applies in order both on a fresh store and on a store created by the
 * released 0.7.0-alpha.10 schema, and both paths end in the same schema. Phase steps with their own version counter
 * (hub rooms, ...) are covered by opening the store the way the service does.
 */
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const dir = () => { const path = mkdtempSync(join(tmpdir(), "ledger-migrations-")); cleanup.push(() => rmSync(path, { recursive: true, force: true })); return path; };
const store = (path: string, identity = "@alice:example.test") => { const value = new DurableStore(path, identity); cleanup.push(() => { try { value.close(); } catch { /* closed */ } }); return value; };
const directory: HubDirectory = { owns: () => true, agentName: (id) => id, ledger: () => undefined, personName: () => undefined };

/** Tables, indexes and their columns, without SQLite internals. */
function schema(db: DurableStore["db"]) {
  const objects = db.prepare("SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{ type: string; name: string; tbl_name: string }>;
  return objects.map((object) => ({ ...object, columns: object.type === "table"
    ? (db.prepare(`PRAGMA table_info("${object.name}")`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>)
      .map((column) => `${column.name} ${column.type}${column.notnull ? " NOT NULL" : ""}${column.dflt_value === null ? "" : ` DEFAULT ${String(column.dflt_value)}`}${column.pk ? ` PK${column.pk}` : ""}`)
    : (db.prepare(`PRAGMA index_info("${object.name}")`).all() as Array<{ name: string | null }>).map((column) => column.name ?? "<expr>") }));
}
const versions = (value: DurableStore) => Object.fromEntries((value.db.prepare("SELECT id,value FROM documents WHERE collection='meta' AND id LIKE '%schema_version' ORDER BY id").all() as Array<{ id: string; value: string }>)
  .map((row) => [row.id, JSON.parse(row.value)]));

/** Create the stores as 0.7.0-alpha.10 did, with one row each, and close them. */
function alpha10(root: string) {
  const agent = store(join(root, "agent.sqlite"), "agent-1");
  agent.migrate(1, ALPHA10_AGENT_LEDGER_V1); agent.migrate(2, ALPHA10_AGENT_LEDGER_V2);
  agent.set("meta", "probe", "agent");
  agent.close();
  const hub = store(join(root, "hub.sqlite"));
  hub.migrate(1, ALPHA10_OWNER_HUB_V1); hub.set("meta", "probe", "hub"); hub.close();
  const registry = store(join(root, "registry.sqlite"), "service");
  registry.migrate(1, ALPHA10_REGISTRY_V1, "registry_schema_version"); registry.set("meta", "probe", "registry"); registry.close();
}
/** Open the stores the way the current service does (every migration it knows). */
function current(root: string) {
  const agent = store(join(root, "agent.sqlite"), "agent-1");
  AgentLedger.open(agent);
  const hub = new OwnerHub("@alice:example.test", join(root, "hub.sqlite"), directory);
  cleanup.push(() => { try { hub.close(); } catch { /* closed */ } });
  const registryStore = store(join(root, "registry.sqlite"), "service");
  new PersonRegistry(registryStore);
  return { agent, hub: hub.store, registry: registryStore };
}

describe("ledger migrations", () => {
  it("upgrade a 0.7.0-alpha.10 store to the same schema as a fresh store", () => {
    const upgraded = dir(), fresh = dir();
    alpha10(upgraded);
    const a = current(upgraded), b = current(fresh);
    for (const name of ["agent", "hub", "registry"] as const) {
      expect(schema(a[name].db), name).toEqual(schema(b[name].db));
      expect(versions(a[name]), name).toEqual(versions(b[name]));
      expect(a[name].get("meta", "probe"), name).toBe(name);
    }
    expect(versions(a.agent)).toEqual({ ledger_schema_version: 4 });
    expect(versions(a.hub)).toMatchObject({ ledger_schema_version: 1, hub_rooms_schema_version: 1 });
    expect(versions(a.registry)).toMatchObject({ registry_schema_version: 1 });
  });
  it("is idempotent when the stores are opened again", () => {
    const root = dir();
    alpha10(root);
    const first = current(root), before = { agent: schema(first.agent.db), hub: schema(first.hub.db), registry: schema(first.registry.db) };
    for (const close of cleanup.splice(1).reverse()) close();
    const again = current(root);
    expect({ agent: schema(again.agent.db), hub: schema(again.hub.db), registry: schema(again.registry.db) }).toEqual(before);
  });
  it("keeps the shipped 0.7.0-alpha.10 steps unedited", async () => {
    const shipped = await import("../src/ledger/schema.js");
    expect(shipped.AGENT_LEDGER_V1).toBe(ALPHA10_AGENT_LEDGER_V1);
    expect(shipped.AGENT_LEDGER_V2).toBe(ALPHA10_AGENT_LEDGER_V2);
    expect(shipped.OWNER_HUB_V1).toBe(ALPHA10_OWNER_HUB_V1);
    expect(shipped.REGISTRY_V1).toBe(ALPHA10_REGISTRY_V1);
  });
});
