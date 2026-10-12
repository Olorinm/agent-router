#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { onboardingOptionsSchema } from "./configuration.js";
import { privateFile } from "../services/feishu/cli.js";
import { mxid } from "../matrix/protocol.js";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    owner: { type: "string" },
    "host-url": { type: "string" },
    "host-token-file": { type: "string" },
    runtime: { type: "string" },
    label: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  process.stdout.write(
    "Usage: npm run onboarding:init -- --out /private/onboarding.json [--owner @alice:example.org --host-url http://host:8787 --host-token-file /private/host-token --runtime codex]\n",
  );
} else {
  try {
    if (!values.out) throw new Error("output_file_required");
    const file = resolve(values.out);
    if (existsSync(file)) throw new Error("configuration_already_exists");
    const anyHost = [
      values.owner,
      values["host-url"],
      values["host-token-file"],
      values.runtime,
    ].some(Boolean);
    if (
      anyHost &&
      ![
        values.owner,
        values["host-url"],
        values["host-token-file"],
        values.runtime,
      ].every(Boolean)
    )
      throw new Error("all_host_options_required");
    const hosts = anyHost
      ? [
          {
            id: "personal",
            label: values.label ?? "Personal execution service",
            owners: [mxid.parse(values.owner)],
            url: values["host-url"]!,
            tokenFile: resolve(values["host-token-file"]!),
            runtimeId: values.runtime!,
          },
        ]
      : [];
    for (const host of hosts) {
      const url = new URL(host.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("invalid_host_url");
      if (!readFileSync(host.tokenFile, "utf8").trim())
        throw new Error("empty_host_token");
    }
    privateFile(
      file,
      onboardingOptionsSchema.parse({
        hosts,
      }),
    );
    process.stdout.write(
      JSON.stringify({
        status: "created",
        file,
        next: "Set AGENT_ROUTER_ONBOARDING_FILE and restart the Router once. Then use agent-router setup in the existing Go CLI.",
      }) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message + "\n"
        : "onboarding_configuration_invalid\n",
    );
    process.exitCode = 1;
  }
}
