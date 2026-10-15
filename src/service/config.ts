import { readFileSync } from "node:fs";
import { externalIdentityConfigSchema } from "../matrix/external-identity.js";
import type { ServiceConfig } from "../matrix/managed.js";

/** Operator configuration shared by the standalone Router and embedding products. */
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const required = (key: string) => { const value = env[key]; if (!value) throw new Error(`${key}_required`); return value; };
  const token = (key: string) => readFileSync(required(key), "utf8").trim();
  return {
    serverName: required("MATRIX_SERVER_NAME"), homeserver: required("MATRIX_HOMESERVER_URL").replace(/\/$/, ""),
    publicUrl: required("AGENT_SERVICE_URL").replace(/\/$/, ""), stateDir: env.AGENT_SERVICE_STATE ?? "state/agent-service",
    asToken: token("MATRIX_AS_TOKEN_FILE"), hsToken: token("MATRIX_HS_TOKEN_FILE"),
    ...(env.AGENT_CHANNELS_CONFIG_FILE ? { channelConfigFile: env.AGENT_CHANNELS_CONFIG_FILE } : {}),
    ...(env.AGENT_TRUST_PROXY ? { trustedProxies: env.AGENT_TRUST_PROXY.split(",").map(v => v.trim()).filter(Boolean) } : {}),
    ...(env.AGENT_IDENTITY_CONFIG_FILE ? { externalIdentity: externalIdentityConfigSchema.parse({
      providers: JSON.parse(readFileSync(env.AGENT_IDENTITY_CONFIG_FILE, "utf8")), adminToken: token("MATRIX_ADMIN_TOKEN_FILE"),
    }) } : {}),
  };
}
