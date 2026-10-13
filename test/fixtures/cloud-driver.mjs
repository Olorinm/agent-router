// Lifecycle is simulated; execution/files/HTTP Host process are real local resources.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SandboxNotFoundError, CommandExitError } from "e2b";
import {
  createVolcengineProvider,
  EnvironmentManager,
} from "@olorinm/agent-environment";
let config,
  host,
  exited,
  state = "missing",
  metadata = {},
  creates = 0;
const children = new Set();
const id = "fixture-cloud-environment";
async function boot() {
  host = spawn(
    process.execPath,
    [
      resolve("node_modules/@olorinm/agent-host/dist/service/cli.js"),
      "serve",
      "--config",
      join(config.directory, "host.json"),
      "--token-file",
      join(config.directory, "token"),
      "--ready-file",
      join(config.directory, "ready.json"),
      "--host",
      "127.0.0.1",
      "--port",
      String(config.port),
    ],
    {
      env: { ...process.env, AGENT_HOST_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((r) => host.once("exit", r));
  let log = "";
  host.stdout.on("data", (b) => (log += b));
  host.stderr.on("data", (b) => (log += b));
  state = "running";
  return log;
}
async function stop() {
  if (host && host.exitCode === null) {
    host.kill();
    await exited;
  }
  host = undefined;
}
const handle = () => ({
  sandboxId: id,
  getHost: (port) => "127.0.0.1:" + port,
  commands: {
    async run(command, options) {
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: config.root,
        env: { ...process.env, ...options.envs },
      });
      children.add(child);
      child.stdout.on("data", (b) => options.onStdout(String(b)));
      child.stderr.on("data", (b) => options.onStderr(String(b)));
      const waiting = new Promise((r, j) => {
        child.once("error", j);
        child.once("close", (code) => {
          children.delete(child);
          code === 0
            ? r({ exitCode: 0 })
            : j(
                new CommandExitError({
                  exitCode: code ?? 137,
                  stdout: "",
                  stderr: "",
                  error: "exit",
                }),
              );
        });
      });
      return {
        wait: () => waiting,
        kill: async () => child.kill("SIGKILL"),
        disconnect: async () => {},
      };
    },
  },
  files: {
    read: (path) => readFile(path),
    write: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        typeof data === "string" ? data : new Uint8Array(data),
      );
    },
    remove: (path) => rm(path),
    list: async () => [],
  },
});
const driver = {
  async create(template, options) {
    creates++;
    metadata = options.metadata;
    await boot();
    return handle();
  },
  async connect() {
    if (state === "missing") throw new SandboxNotFoundError("missing");
    if (state === "paused") await boot();
    return handle();
  },
  async info() {
    if (state === "missing") throw new SandboxNotFoundError("missing");
    return { sandboxId: id, state, templateId: "fixture", metadata };
  },
  async list() {
    return state === "missing"
      ? []
      : [{ sandboxId: id, state, templateId: "fixture", metadata }];
  },
  async pause() {
    await stop();
    state = "paused";
  },
  async kill() {
    await stop();
    state = "missing";
  },
  async setTimeout() {},
};
export async function loadConfiguration(path) {
  config = JSON.parse(await readFile(path, "utf8"));
  return new EnvironmentManager([
    createVolcengineProvider({
      id: "volc",
      apiKey: "fixture-private-cloud-key",
      domain: "fixture",
      serviceUrl: "http://127.0.0.1:" + config.port,
      allowHttp: true,
      driver,
    }),
  ]);
}
export const count = () => creates;
export const close = async () => {
  await stop();
  for (const child of children) child.kill("SIGKILL");
};
