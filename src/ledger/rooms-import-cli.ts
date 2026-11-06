#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { ApplicationInbox, ApplicationTransport } from "../matrix/application-service.js";
import { ConnectorStore } from "../matrix/store.js";
import type { ManagedAgent } from "../matrix/managed.js";
import { importRooms } from "./rooms-import.js";

/**
 * `agent-router ledger import-rooms (--owner <ownerId> | --all) [--dry-run] [--state <dir>]` (ADR 0005 section 17.6;
 * `import-groups` is an alias). Run with the Router service stopped and Synapse running: history gap filling and the
 * final notice use the agents' virtual users with the Application Service token.
 */
const args = process.argv.slice(2).filter((arg) => !["ledger", "import-rooms", "import-groups"].includes(arg));
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const ownerId = value("--owner"), all = args.includes("--all"), dryRun = args.includes("--dry-run");
if (!ownerId === !all) { process.stderr.write("usage: ledger import-rooms (--owner <ownerId> | --all) [--dry-run] [--state <dir>]\n"); process.exit(2); }
const stateDir = value("--state") ?? process.env.AGENT_SERVICE_STATE ?? "state/agent-service";
const homeserver = process.env.MATRIX_HOMESERVER_URL?.replace(/\/$/, ""), tokenFile = process.env.MATRIX_AS_TOKEN_FILE;
if (!dryRun && (!homeserver || !tokenFile)) { process.stderr.write("import-rooms requires MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN_FILE\n"); process.exit(2); }
let transport: ((agent: ManagedAgent) => ApplicationTransport) | undefined;
if (homeserver && tokenFile) {
  const asToken = readFileSync(tokenFile, "utf8").trim(), inbox = new ApplicationInbox(new ConnectorStore(":memory:", "ledger-import-rooms"), () => undefined);
  transport = (agent) => new ApplicationTransport(homeserver, asToken, agent.matrixId, agent.id, inbox);
}
importRooms({ stateDir, ownerId, dryRun,
  ...(transport ? { history: (agent: ManagedAgent) => { const port = transport!(agent); return (room: string, from?: string) => port.history(room, from); },
    notice: (agent: ManagedAgent) => { const port = transport!(agent); return (room: string, type: string, content: Record<string, unknown>, txnId: string) => port.send(room, type, content, txnId); } } : {}) })
  .then((report) => { process.stdout.write(JSON.stringify(report, null, 2) + "\n"); })
  .catch((error: unknown) => { process.stderr.write(`ledger_import_rooms_failed: ${error instanceof Error ? error.message : "unknown"}\n`); process.exitCode = 1; });
