import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/** `credentials.json` in the Agent's directory: the app the Feishu channel runs as, next to its `app-secret` file. */
export const feishuCredentialsSchema = z.object({ version: z.literal(1), appId: z.string().min(1),
  appSecretFile: z.string().min(1), domain: z.enum(["feishu", "lark"]), ownerOpenId: z.string().min(1) }).strict();
export type FeishuCredentials = z.infer<typeof feishuCredentialsSchema>;
export function privateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.partial`;
  writeFileSync(temporary, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, path); chmodSync(path, 0o600);
}
export function loadFeishuCredentials(path: string) {
  const credentials = feishuCredentialsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const directory = dirname(resolve(path));
  const appSecret = readFileSync(resolve(directory, credentials.appSecretFile), "utf8").trim();
  if (!appSecret) throw new Error("empty_feishu_app_secret");
  return { credentials, directory, appSecret };
}
