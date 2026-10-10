#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { ServiceHttp } from "../channels/http.js";
import { loadChannelConfiguration } from "./channels.js";
import { checkChannels } from "./check.js";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  node: { type: "string" }, "owner-token-file": { type: "string" }, help: { type: "boolean", short: "h" },
} });
if (values.help || positionals.length !== 1) {
  process.stdout.write("Usage: npm run channels:check -- CHANNELS_FILE [--node https://router.example --owner-token-file FILE]\nRead-only access checks. Does not consume messages or start a model.\n"); process.exit(values.help ? 0 : 1);
}
try {
  if (Boolean(values.node) !== Boolean(values["owner-token-file"])) throw new Error("node_and_owner_token_file_required_together");
  const node = values.node ? new ServiceHttp(values.node, readFileSync(values["owner-token-file"]!, "utf8").trim()) : undefined;
  const checks = await checkChannels(loadChannelConfiguration(positionals[0]!), node);
  process.stdout.write(JSON.stringify({ checks }, null, 2) + "\n");
  if (checks.some((check) => check.status === "needs_action")) process.exitCode = 1;
} catch { process.stderr.write("channel_configuration_check_failed\n"); process.exitCode = 1; }
