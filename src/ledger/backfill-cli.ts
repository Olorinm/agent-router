#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { ApplicationInbox, ApplicationTransport } from "../matrix/application-service.js";
import { ConnectorStore } from "../matrix/store.js";
import { backfill } from "./backfill.js";

/** `agent-router ledger backfill [--agent <id>|--all] [--dry-run] [--synapse]`, run with the service stopped (ADR 0005 section 10). */
const args = process.argv.slice(2).filter((arg) => !["ledger", "backfill"].includes(arg));
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const agentId = value("--agent"), all = args.includes("--all");
if (!agentId === !all) { process.stderr.write("usage: ledger backfill (--agent <id> | --all) [--dry-run] [--synapse] [--state <dir>]\n"); process.exit(2); }
const stateDir = value("--state") ?? process.env.AGENT_SERVICE_STATE ?? "state/agent-service";
let history: Parameters<typeof backfill>[0]["history"];
if (args.includes("--synapse")) {
  const homeserver = process.env.MATRIX_HOMESERVER_URL?.replace(/\/$/, ""), tokenFile = process.env.MATRIX_AS_TOKEN_FILE;
  if (!homeserver || !tokenFile) { process.stderr.write("--synapse requires MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN_FILE\n"); process.exit(2); }
  const asToken = readFileSync(tokenFile, "utf8").trim(), inbox = new ApplicationInbox(new ConnectorStore(":memory:", "ledger-backfill"), () => undefined);
  history = (agent) => {
    const transport = new ApplicationTransport(homeserver, asToken, agent.matrixId, agent.id, inbox);
    return (room, from) => transport.history(room, from);
  };
}
backfill({ stateDir, agentId, dryRun: args.includes("--dry-run"), history })
  .then((report) => { process.stdout.write(JSON.stringify(report, null, 2) + "\n"); })
  .catch((error: unknown) => { process.stderr.write(`ledger_backfill_failed: ${error instanceof Error ? error.message : "unknown"}\n`); process.exitCode = 1; });
