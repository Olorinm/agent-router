import { AgentCard, type AgentCard as AgentCardType } from "@a2a-js/sdk";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { RouterConfig } from "./config.js";
import { createMachineCredential, encryptSecret, hashCredential } from "./crypto.js";
import { oneOrUndefined, withTransaction } from "./db.js";
import { assertSafeEndpoint } from "./endpoint-policy.js";

export interface RegisteredAgent {
  id: string;
  address: string;
  displayName: string;
  description: string;
  sourceAgentCard: AgentCardType;
  endpointAuthCiphertext?: string;
  targetKind: "local" | "federated";
  originDomain?: string;
  remoteCardExpiresAt?: string;
  status: "active" | "disabled";
  ownerPrincipalId: string;
  updatedAt: string;
}

interface AgentRow {
  id: string;
  address: string;
  display_name: string;
  description: string;
  source_agent_card: unknown;
  endpoint_auth_ciphertext: string | null;
  target_kind: "local" | "federated";
  origin_domain: string | null;
  remote_card_expires_at: Date | null;
  status: "active" | "disabled";
  owner_principal_id: string;
  updated_at: Date;
}

const registrationSchema = z.object({
  address: z.string().min(1).max(180),
  displayName: z.string().min(1).max(160),
  description: z.string().min(1).max(2000),
  agentCard: z.unknown(),
  endpointBearerToken: z.string().min(16).max(4096).optional(),
});

const updateSchema = z
  .object({
    displayName: z.string().min(1).max(160).optional(),
    description: z.string().min(1).max(2000).optional(),
    agentCard: z.unknown().optional(),
    endpointBearerToken: z.union([z.string().min(16).max(4096), z.null()]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "agent_update_empty");

export type RegisterAgentInput = z.infer<typeof registrationSchema>;

export class AgentRegistry {
  constructor(
    private readonly pool: Pool,
    private readonly config: RouterConfig,
  ) {}

  async list(search = ""): Promise<RegisteredAgent[]> {
    const value = `%${search.trim().toLowerCase()}%`;
    const result = await this.pool.query<AgentRow>(
      `SELECT id, address, display_name, description, source_agent_card, endpoint_auth_ciphertext,
              target_kind, origin_domain, remote_card_expires_at, status, owner_principal_id, updated_at
         FROM agents
        WHERE target_kind = 'local' AND (
              $1 = '%%'
           OR address LIKE $1
           OR lower(display_name) LIKE $1
           OR lower(description) LIKE $1
           OR EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(source_agent_card->'skills', '[]'::jsonb)) AS skill
              WHERE lower(COALESCE(skill->>'id', '')) LIKE $1
                 OR lower(COALESCE(skill->>'name', '')) LIKE $1
                 OR lower(COALESCE(skill->>'description', '')) LIKE $1
                 OR EXISTS (
                   SELECT 1 FROM jsonb_array_elements_text(COALESCE(skill->'tags', '[]'::jsonb)) AS tag(value)
                    WHERE lower(value) LIKE $1
                 )
           ))
        ORDER BY address ASC
        LIMIT 200`,
      [value],
    );
    return result.rows.map(mapAgentRow);
  }

  async listDeliveryTargets(): Promise<RegisteredAgent[]> {
    const result = await this.pool.query<AgentRow>(
      `SELECT id, address, display_name, description, source_agent_card, endpoint_auth_ciphertext,
              target_kind, origin_domain, remote_card_expires_at, status, owner_principal_id, updated_at
         FROM agents
        WHERE status = 'active'
        ORDER BY address`,
    );
    return result.rows.map(mapAgentRow);
  }

  async getByAddress(address: string): Promise<RegisteredAgent | undefined> {
    const row = await oneOrUndefined<AgentRow>(
      this.pool,
      `SELECT id, address, display_name, description, source_agent_card, endpoint_auth_ciphertext,
              target_kind, origin_domain, remote_card_expires_at, status, owner_principal_id, updated_at
         FROM agents WHERE address = $1`,
      [normalizeAnyAddress(address)],
    );
    return row ? mapAgentRow(row) : undefined;
  }

  async getById(id: string): Promise<RegisteredAgent | undefined> {
    const row = await oneOrUndefined<AgentRow>(
      this.pool,
      `SELECT id, address, display_name, description, source_agent_card, endpoint_auth_ciphertext,
              target_kind, origin_domain, remote_card_expires_at, status, owner_principal_id, updated_at
         FROM agents WHERE id = $1`,
      [id],
    );
    return row ? mapAgentRow(row) : undefined;
  }

  async register(
    rawInput: unknown,
    owner: { id: string; displayName: string; email?: string },
  ): Promise<{ agent: RegisteredAgent; machineCredential: string }> {
    const input = registrationSchema.parse(rawInput);
    const address = normalizeAddress(input.address, this.config.agentAddressDomain);
    const sourceAgentCard = AgentCard.fromJSON(input.agentCard);
    assertAgentCard(sourceAgentCard);
    await Promise.all(
      sourceAgentCard.supportedInterfaces.map((entry) =>
        assertSafeEndpoint(entry.url, {
          allowHttp: this.config.allowHttpAgentEndpoints,
          allowPrivate: this.config.allowPrivateAgentEndpoints,
        }),
      ),
    );
    const token = createMachineCredential();
    const endpointAuthCiphertext = input.endpointBearerToken
      ? encryptSecret(input.endpointBearerToken, this.config.encryptionKey)
      : undefined;

    const agent = await withTransaction(this.pool, async (client) => {
      await upsertPrincipal(client, { ...owner, kind: "human" });
      const row = await oneOrUndefined<AgentRow>(
        client,
        `INSERT INTO agents(
           address, display_name, description, source_agent_card, endpoint_auth_ciphertext, owner_principal_id
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id, address, display_name, description, source_agent_card, endpoint_auth_ciphertext,
                   target_kind, origin_domain, remote_card_expires_at, status, owner_principal_id, updated_at`,
        [
          address,
          input.displayName,
          input.description,
          JSON.stringify(sourceAgentCard),
          endpointAuthCiphertext ?? null,
          owner.id,
        ],
      );
      if (!row) throw new Error("agent_registration_failed");
      const principalId = `agent:${row.id}`;
      await upsertPrincipal(client, { id: principalId, kind: "agent", displayName: input.displayName });
      await client.query(
        `INSERT INTO credentials(principal_id, token_hash, token_prefix)
         VALUES ($1, $2, $3)`,
        [principalId, hashCredential(token), token.slice(0, 12)],
      );
      await client.query(
        `INSERT INTO audit_logs(principal_id, action, target, outcome, facts)
         VALUES ($1, 'agent.register', $2, 'success', $3::jsonb)`,
        [owner.id, address, JSON.stringify({ agentId: row.id })],
      );
      return mapAgentRow(row);
    });
    return { agent, machineCredential: token };
  }

  async update(
    addressValue: string,
    rawInput: unknown,
    actorPrincipalId: string,
  ): Promise<RegisteredAgent | undefined> {
    const input = updateSchema.parse(rawInput);
    const address = normalizeAddress(addressValue, this.config.agentAddressDomain);
    const existing = await this.getByAddress(address);
    if (!existing) return undefined;

    const sourceAgentCard = input.agentCard === undefined
      ? existing.sourceAgentCard
      : AgentCard.fromJSON(input.agentCard);
    assertAgentCard(sourceAgentCard);
    await Promise.all(
      sourceAgentCard.supportedInterfaces.map((entry) =>
        assertSafeEndpoint(entry.url, {
          allowHttp: this.config.allowHttpAgentEndpoints,
          allowPrivate: this.config.allowPrivateAgentEndpoints,
        }),
      ),
    );
    const endpointAuthCiphertext = input.endpointBearerToken === undefined
      ? existing.endpointAuthCiphertext
      : input.endpointBearerToken === null
        ? undefined
        : encryptSecret(input.endpointBearerToken, this.config.encryptionKey);

    return withTransaction(this.pool, async (client) => {
      const row = await oneOrUndefined<AgentRow>(
        client,
        `UPDATE agents SET
           display_name = $2,
           description = $3,
           source_agent_card = $4::jsonb,
           endpoint_auth_ciphertext = $5,
           status = $6,
           updated_at = now()
         WHERE address = $1
         RETURNING id, address, display_name, description, source_agent_card, endpoint_auth_ciphertext,
                   target_kind, origin_domain, remote_card_expires_at, status, owner_principal_id, updated_at`,
        [
          address,
          input.displayName ?? existing.displayName,
          input.description ?? existing.description,
          JSON.stringify(sourceAgentCard),
          endpointAuthCiphertext ?? null,
          input.status ?? existing.status,
        ],
      );
      if (!row) return undefined;
      await client.query(
        `INSERT INTO audit_logs(principal_id, action, target, outcome, facts)
         VALUES ($1, 'agent.update', $2, 'success', $3::jsonb)`,
        [actorPrincipalId, address, JSON.stringify({ fields: Object.keys(input).sort() })],
      );
      return mapAgentRow(row);
    });
  }

  async upsertFederated(
    addressValue: string,
    originDomain: string,
    sourceAgentCard: AgentCardType,
  ): Promise<RegisteredAgent> {
    const address = normalizeAnyAddress(addressValue);
    if (address.endsWith(`@${this.config.agentAddressDomain}`)) throw new Error("federation_remote_address_required");
    assertAgentCard(sourceAgentCard);
    return withTransaction(this.pool, async (client) => {
      await upsertPrincipal(client, {
        id: "operator:federation-cache",
        kind: "operator",
        displayName: "Federation cache",
      });
      const row = await oneOrUndefined<AgentRow>(
        client,
        `INSERT INTO agents(
           address, display_name, description, source_agent_card, owner_principal_id,
           target_kind, origin_domain, remote_card_expires_at
         ) VALUES ($1, $2, $3, $4::jsonb, 'operator:federation-cache', 'federated', $5, $6)
         ON CONFLICT (address) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           source_agent_card = EXCLUDED.source_agent_card,
           origin_domain = EXCLUDED.origin_domain,
           remote_card_expires_at = EXCLUDED.remote_card_expires_at,
           status = 'active',
           updated_at = now()
         WHERE agents.target_kind = 'federated'
         RETURNING id, address, display_name, description, source_agent_card, endpoint_auth_ciphertext,
                   target_kind, origin_domain, remote_card_expires_at, status, owner_principal_id, updated_at`,
        [
          address,
          sourceAgentCard.name,
          sourceAgentCard.description,
          JSON.stringify(sourceAgentCard),
          originDomain,
          new Date(Date.now() + this.config.federationRemoteCardCacheMs),
        ],
      );
      if (!row) throw new Error("federated_agent_conflicts_with_local_agent");
      return mapAgentRow(row);
    });
  }
}

export async function upsertPrincipal(
  client: Pick<PoolClient, "query"> | Pick<Pool, "query">,
  input: { id: string; kind: "human" | "agent" | "operator" | "federation"; displayName: string; email?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO principals(id, kind, display_name, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       email = COALESCE(EXCLUDED.email, principals.email),
       updated_at = now()`,
    [input.id, input.kind, input.displayName, input.email ?? null],
  );
}

export function normalizeAddress(value: string, domain: string): string {
  const normalized = value.trim().toLowerCase();
  const full = normalizeAnyAddress(normalized.includes("@") ? normalized : `${normalized}@${domain}`);
  if (!full.endsWith(`@${domain}`)) throw new Error("agent_address_domain_invalid");
  return full;
}

export function normalizeAnyAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(normalized)) {
    throw new Error("agent_address_invalid");
  }
  return normalized;
}

function assertAgentCard(card: AgentCardType): void {
  if (!card.name.trim() || !card.description.trim() || !card.version.trim()) throw new Error("agent_card_invalid");
  if (!card.supportedInterfaces.length) throw new Error("agent_card_interface_required");
  if (!card.supportedInterfaces.some((entry) => entry.protocolVersion === "1.0")) {
    throw new Error("agent_card_v1_interface_required");
  }
}

function mapAgentRow(row: AgentRow): RegisteredAgent {
  return {
    id: row.id,
    address: row.address,
    displayName: row.display_name,
    description: row.description,
    sourceAgentCard: AgentCard.fromJSON(row.source_agent_card),
    ...(row.endpoint_auth_ciphertext ? { endpointAuthCiphertext: row.endpoint_auth_ciphertext } : {}),
    targetKind: row.target_kind,
    ...(row.origin_domain ? { originDomain: row.origin_domain } : {}),
    ...(row.remote_card_expires_at ? { remoteCardExpiresAt: row.remote_card_expires_at.toISOString() } : {}),
    status: row.status,
    ownerPrincipalId: row.owner_principal_id,
    updatedAt: row.updated_at.toISOString(),
  };
}
