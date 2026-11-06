import { readFileSync } from "node:fs";
import { externalIdentityConfigSchema } from "../matrix/external-identity.js";
import { loadEdgeIdentityConfig } from "../auth/edge-identity.js";
import type { ServiceConfig } from "../matrix/managed.js";
import { blobConfigFromEnv } from "../ledger/blobs.js";

/** Operator configuration shared by the standalone Router and embedding products. */
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const required = (key: string) => { const value = env[key]; if (!value) throw new Error(`${key}_required`); return value; };
  const token = (key: string) => readFileSync(required(key), "utf8").trim();
  const matrix = matrixSwitch(env.AGENT_MATRIX);
  return {
    serverName: required("MATRIX_SERVER_NAME"),
    publicUrl: required("AGENT_SERVICE_URL").replace(/\/$/, ""), stateDir: env.AGENT_SERVICE_STATE ?? "state/agent-service",
    // ADR 0005 19.1: with `AGENT_MATRIX=off` the homeserver URL and Application Service tokens are optional and unused.
    matrix: { enabled: matrix },
    ...(matrix ? { homeserver: required("MATRIX_HOMESERVER_URL").replace(/\/$/, ""), asToken: token("MATRIX_AS_TOKEN_FILE"), hsToken: token("MATRIX_HS_TOKEN_FILE") } : {}),
    ...(["1", "true"].includes(env.AGENT_LEDGER_READ ?? "") ? { ledgerRead: true } : {}),
    ...(["1", "true"].includes(env.AGENT_LEDGER_SEND ?? "") ? { ledgerSend: true } : {}),
    ...(["1", "true"].includes(env.AGENT_LEDGER_CARDS ?? "") ? { ledgerCards: true } : {}),
    ...(["1", "true"].includes(env.AGENT_LEDGER_CONTROL ?? "") ? { ledgerControl: true } : {}),
    ...(["1", "true"].includes(env.AGENT_LEDGER_GROUPS ?? "") ? { ledgerGroups: true } : {}),
    ...(["1", "true"].includes(env.AGENT_LEDGER_IDENTITY ?? "") ? { ledgerIdentity: true } : {}),
    ...(env.AGENT_TRUST_PROXY ? { trustedProxies: env.AGENT_TRUST_PROXY.split(",").map(v => v.trim()).filter(Boolean) } : {}),
    ...(env.AGENT_EDGE_IDENTITY_FILE ? { edgeIdentity: loadEdgeIdentityConfig(env.AGENT_EDGE_IDENTITY_FILE) } : {}),
    ...(env.AGENT_IDENTITY_CONFIG_FILE ? { externalIdentity: externalIdentityConfigSchema.parse({
      providers: JSON.parse(readFileSync(env.AGENT_IDENTITY_CONFIG_FILE, "utf8")), ...(matrix ? { adminToken: token("MATRIX_ADMIN_TOKEN_FILE") } : {}),
    }) } : {}),
    // ADR 0005 16.5: attachments and the blob store (R2 key files are read when the service starts).
    ...blobConfigFromEnv(env),
  };
}

/** `AGENT_MATRIX=on|off` (also `1/0`, `true/false`); unset is on. Anything else fails the start. */
export function matrixSwitch(value: string | undefined): boolean {
  const normalized = (value ?? "on").trim().toLowerCase();
  if (["on", "1", "true", ""].includes(normalized)) return true;
  if (["off", "0", "false"].includes(normalized)) return false;
  throw new Error("invalid_agent_matrix");
}
