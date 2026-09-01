import { chmod, readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { createPool, migrate } from "../db.js";
import { AgentRegistry } from "../registry.js";

const cardPath = requiredEnv("VERIFIER_AGENT_CARD_FILE");
const endpointTokenPath = requiredEnv("VERIFIER_ENDPOINT_TOKEN_FILE");
const callerTokenOutputPath = requiredEnv("CALLER_TOKEN_OUTPUT_FILE");
const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  await migrate(pool);
  const [cardText, endpointTokenText] = await Promise.all([
    readFile(cardPath, "utf8"),
    readFile(endpointTokenPath, "utf8"),
  ]);
  const agentCard = JSON.parse(cardText) as unknown;
  const endpointBearerToken = endpointTokenText.trim();
  const registry = new AgentRegistry(pool, config);
  const registration = await registry.register(
    {
      address: process.env.VERIFIER_AGENT_ADDRESS ?? "codex-verifier",
      displayName: process.env.VERIFIER_AGENT_NAME ?? "Codex Verifier",
      description: "Isolated Codex employee used to verify durable A2A Router delivery.",
      agentCard,
      endpointBearerToken,
    },
    { id: "operator:bootstrap", displayName: "Router bootstrap operator" },
  );
  await writeFile(callerTokenOutputPath, `${registration.machineCredential}\n`, { mode: 0o600 });
  await chmod(callerTokenOutputPath, 0o600);
  process.stdout.write(`${JSON.stringify({ agentId: registration.agent.id, address: registration.agent.address, credentialFile: callerTokenOutputPath })}\n`);
} finally {
  await pool.end();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}
