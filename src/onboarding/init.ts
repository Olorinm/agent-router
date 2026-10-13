#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { onboardingOptionsSchema } from "./configuration.js";
import { privateFile } from "../services/feishu/cli.js";
import { environmentOptionsSchema } from "./environments.js";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "environments-file": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  process.stdout.write(
    "Usage: npm run onboarding:init -- --out /private/onboarding.json [--environments-file /private/environments.json]\n",
  );
} else {
  try {
    if (!values.out) throw new Error("output_file_required");
    const file = resolve(values.out);
    if (existsSync(file)) throw new Error("configuration_already_exists");
    let environments;
    if (values["environments-file"]) {
      const source = resolve(values["environments-file"]),
        base = dirname(source);
      environments = environmentOptionsSchema.parse(
        JSON.parse(readFileSync(source, "utf8")),
      );
      environments.configFile = resolve(base, environments.configFile);
      if (environments.modulePath)
        environments.modulePath = resolve(base, environments.modulePath);
      for (const profile of environments.profiles) {
        profile.hostConfigFile = resolve(base, profile.hostConfigFile);
        for (const item of profile.files)
          item.source = resolve(base, item.source);
      }
    }
    privateFile(
      file,
      onboardingOptionsSchema.parse({
        ...(environments ? { environments } : {}),
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
