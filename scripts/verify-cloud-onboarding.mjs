#!/usr/bin/env node
// Independent packages + actual Host process, with deterministic cloud/native fixtures.
import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    "environment-archive": { type: "string" },
    "host-archive": { type: "string" },
    "host-fixture": { type: "string" },
  },
});
for (const key of ["environment-archive", "host-archive", "host-fixture"])
  if (!values[key]) throw new Error("--" + key + " is required");
const temporary = await mkdtemp(join(tmpdir(), "router-cloud-consumer-"));
try {
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temporary], {
      encoding: "utf8",
    }),
  )[0];
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      resolve(values["host-archive"]),
      resolve(values["environment-archive"]),
      join(temporary, packed.filename),
    ],
    { cwd: temporary, stdio: "pipe" },
  );
  await copyFile(
    new URL("../test/fixtures/cloud-consumer.mjs", import.meta.url),
    join(temporary, "verify.mjs"),
  );
  await copyFile(
    new URL("../test/fixtures/cloud-driver.mjs", import.meta.url),
    join(temporary, "cloud-driver.mjs"),
  );
  execFileSync(
    process.execPath,
    [
      join(temporary, "verify.mjs"),
      resolve("bin/agent-router"),
      resolve(values["host-fixture"]),
    ],
    { cwd: temporary, stdio: "inherit", timeout: 120000 },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
