import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalUrl = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().url().optional(),
);

const optionalSecret = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(32).max(4096).optional(),
);

const configSchema = z.object({
  PUBLIC_BASE_URL: z.string().url().transform((value) => value.replace(/\/+$/, "")),
  ADMIN_AUTH_MODE: z.enum(["userinfo", "static"]).default("userinfo"),
  IDENTITY_USERINFO_URL: optionalUrl,
  IDENTITY_ADMIN_ROLE: z.string().min(1).default("admin"),
  STATIC_ADMIN_TOKEN: optionalSecret,
  STATIC_ADMIN_SUBJECT: z.string().min(1).max(200).default("local-admin"),
  STATIC_ADMIN_DISPLAY_NAME: z.string().min(1).max(200).default("Local Administrator"),
  AGENT_ADDRESS_DOMAIN: z.string().min(3),
  DATABASE_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
  MASTER_ENCRYPTION_KEY_BASE64: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  AUTH_CACHE_TTL_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(1_800_000).default(300_000),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  DELIVERY_RETRY_BASE_MS: z.coerce.number().int().min(100).max(3_600_000).default(5000),
  ALLOW_HTTP_AGENT_ENDPOINTS: booleanString,
  ALLOW_PRIVATE_AGENT_ENDPOINTS: booleanString,
  FEDERATION_ENABLED: booleanString,
  FEDERATION_PRIVATE_KEY_FILE: z.string().min(1).default("/run/secrets/federation-private-key.pem"),
  FEDERATION_ADDITIONAL_JWKS_FILE: z.string().default(""),
  FEDERATION_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(300),
  FEDERATION_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60).default(15),
  FEDERATION_DISCOVERY_CACHE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),
  FEDERATION_REMOTE_CARD_CACHE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  REMOTE_TASK_POLL_MS: z.coerce.number().int().min(5000).max(3_600_000).default(30_000),
  FEDERATION_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
}).superRefine((value, context) => {
  if (value.ADMIN_AUTH_MODE === "userinfo" && !value.IDENTITY_USERINFO_URL) {
    context.addIssue({ code: "custom", path: ["IDENTITY_USERINFO_URL"], message: "required in userinfo mode" });
  }
  if (value.ADMIN_AUTH_MODE === "static" && !value.STATIC_ADMIN_TOKEN) {
    context.addIssue({ code: "custom", path: ["STATIC_ADMIN_TOKEN"], message: "required in static mode" });
  }
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
    adminAuth: parsed.ADMIN_AUTH_MODE === "static"
      ? {
          mode: "static" as const,
          token: parsed.STATIC_ADMIN_TOKEN!,
          subject: parsed.STATIC_ADMIN_SUBJECT,
          displayName: parsed.STATIC_ADMIN_DISPLAY_NAME,
        }
      : {
          mode: "userinfo" as const,
          userInfoUrl: parsed.IDENTITY_USERINFO_URL!,
          requiredRole: parsed.IDENTITY_ADMIN_ROLE,
        },
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
    federationEnabled: parsed.FEDERATION_ENABLED,
    federationPrivateKeyFile: parsed.FEDERATION_PRIVATE_KEY_FILE,
    federationAdditionalJwksFile: parsed.FEDERATION_ADDITIONAL_JWKS_FILE || undefined,
    federationTokenTtlSeconds: parsed.FEDERATION_TOKEN_TTL_SECONDS,
    federationClockToleranceSeconds: parsed.FEDERATION_CLOCK_TOLERANCE_SECONDS,
    federationDiscoveryCacheMs: parsed.FEDERATION_DISCOVERY_CACHE_MS,
    federationRemoteCardCacheMs: parsed.FEDERATION_REMOTE_CARD_CACHE_MS,
    remoteTaskPollMs: parsed.REMOTE_TASK_POLL_MS,
    federationRequestsPerMinute: parsed.FEDERATION_REQUESTS_PER_MINUTE,
  };
}
