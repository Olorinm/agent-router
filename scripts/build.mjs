import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = spawnSync("tsc", ["-p", "tsconfig.json"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
