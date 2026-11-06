#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { ApplicationInbox, ApplicationTransport } from "./application-service.js";
import { ConnectorStore } from "./store.js";
import { exportMatrix, forgetMatrix, promoteMedia, type MediaReader } from "./removal.js";
import { blobConfigFromEnv, createBlobStore } from "../ledger/blobs.js";
import { matrixSwitch } from "../service/config.js";

/**
 * Synapse removal runbook (ADR 0005 19.4), run with the Router service stopped:
 *   ledger promote-media (--agent <id> | --all) [--channel matrix] [--dry-run] [--state <dir>]   item 6, Synapse running
 *   matrix export (--agent <id> | --all) --out <dir> [--state <dir>]                             item 7 + consistency report
 *   matrix forget --all [--dry-run] [--state <dir>]                                              item 14, needs AGENT_MATRIX=off
 */
const argv = process.argv.slice(2);
const command = argv.slice(0, 2).join(" ");
const args = argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const agentId = value("--agent"), all = args.includes("--all"), dryRun = args.includes("--dry-run");
const stateDir = value("--state") ?? process.env.AGENT_SERVICE_STATE ?? "state/agent-service";
const fail = (message: string): never => { process.stderr.write(message + "\n"); process.exit(2); };
const usage = "usage: ledger promote-media (--agent <id> | --all) [--channel matrix] [--dry-run] | matrix export (--agent <id> | --all) --out <dir> | matrix forget --all [--dry-run]";
if (!agentId === !all) fail(usage);

async function main(): Promise<unknown> {
  if (command === "ledger promote-media") {
    const channel = value("--channel") ?? "matrix";
    if (channel !== "matrix") fail("promote-media supports --channel matrix only");
    let read: MediaReader | undefined;
    if (!dryRun) {
      const homeserver = process.env.MATRIX_HOMESERVER_URL?.replace(/\/$/, ""), tokenFile = process.env.MATRIX_AS_TOKEN_FILE;
      if (!homeserver || !tokenFile) fail("promote-media requires MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN_FILE (Synapse still running)");
      const asToken = readFileSync(tokenFile!, "utf8").trim(), inbox = new ApplicationInbox(new ConnectorStore(":memory:", "ledger-promote-media"), () => undefined);
      read = (agent) => {
        const media = new ApplicationTransport(homeserver!, asToken, agent.matrixId, agent.id, inbox).media;
        return (uri) => media.read(uri);
      };
    }
    // The same blob store the service uses (AGENT_BLOB_STORE, AGENT_R2_*, AGENT_BLOB_DIR).
    const store = createBlobStore(blobConfigFromEnv(process.env).blobStore, stateDir);
    const report = await promoteMedia({ stateDir, agentId, all, dryRun, store, read });
    if (!dryRun && report.remaining) process.exitCode = 1;
    return report;
  }
  if (command === "matrix export") {
    const out = value("--out") ?? fail(usage);
    const { report } = await exportMatrix({ stateDir, agentId, all, out });
    if (!report.ready) process.exitCode = 1;
    return { out, report };
  }
  if (command === "matrix forget") {
    if (!all) fail("matrix forget clears registry-wide Matrix records: use --all");
    if (!dryRun && matrixSwitch(process.env.AGENT_MATRIX)) fail("matrix forget requires AGENT_MATRIX=off (or --dry-run)");
    return forgetMatrix({ stateDir, all, dryRun });
  }
  return fail(usage);
}
main().then((result) => { process.stdout.write(JSON.stringify(result, null, 2) + "\n"); })
  .catch((error: unknown) => { process.stderr.write(`matrix_removal_failed: ${error instanceof Error ? error.message : "unknown"}\n`); process.exitCode = 1; });
