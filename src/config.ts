import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const configSchema = z.object({
  PUBLIC_BASE_URL: z.string().url().transform((value) => value.replace(/\/+$/, "")),
  WW_BASE_URL: z.string().url().transform((value) => value.replace(/\/+$/, "")),
  AGENT_ADDRESS_DOMAIN: z.string().min(3).default("agents.welltop.cn"),
  DATABASE_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
  MASTER_ENCRYPTION_KEY_BASE64: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  AUTH_CACHE_TTL_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(1_800_000).default(300_000),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  DELIVERY_RETRY_BASE_MS: z.coerce.number().int().min(100).max(3_600_000).default(5000),
  ALLOW_HTTP_AGENT_ENDPOINTS: booleanString,
  ALLOW_PRIVATE_AGENT_ENDPOINTS: booleanString,
});

export type RouterConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = configSchema.parse(env);
  const encryptionKey = Buffer.from(parsed.MASTER_ENCRYPTION_KEY_BASE64, "base64");
  if (encryptionKey.length !== 32) {
    throw new Error("MASTER_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes");
  }
  return {
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    wwBaseUrl: parsed.WW_BASE_URL,
    agentAddressDomain: parsed.AGENT_ADDRESS_DOMAIN.toLowerCase(),
    databaseUrl: parsed.DATABASE_URL,
    rabbitmqUrl: parsed.RABBITMQ_URL,
    encryptionKey,
    port: parsed.PORT,
    trustProxy: parsed.TRUST_PROXY,
    authCacheTtlMs: parsed.AUTH_CACHE_TTL_MS,
    deliveryConcurrency: parsed.DELIVERY_CONCURRENCY,
    deliveryTimeoutMs: parsed.DELIVERY_TIMEOUT_MS,
    deliveryMaxAttempts: parsed.DELIVERY_MAX_ATTEMPTS,
    deliveryRetryBaseMs: parsed.DELIVERY_RETRY_BASE_MS,
    allowHttpAgentEndpoints: parsed.ALLOW_HTTP_AGENT_ENDPOINTS,
    allowPrivateAgentEndpoints: parsed.ALLOW_PRIVATE_AGENT_ENDPOINTS,
  };
}
