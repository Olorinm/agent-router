import { AgentCard, type AgentCard as AgentCardType } from "@a2a-js/sdk";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { RouterConfig } from "./config.js";
import { createEnrollmentToken, createMachineCredential, encryptSecret, hashCredential } from "./crypto.js";
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

const enrollmentSchema = z.object({
  label: z.string().max(160).default(""),
  address: z.string().min(1).max(180).optional(),
  endpointOrigin: z.string().url().optional(),
  expiresInSeconds: z.number().int().min(60).max(86_400).default(900),
});

const credentialSchema = z.object({
  label: z.string().max(160).default(""),
  expiresInSeconds: z.number().int().min(60).max(31_536_000).optional(),
});

interface EnrollmentRow {
  id: string;
  token_prefix: string;
  label: string;
  address: string | null;
  endpoint_origin: string | null;
  status: "active" | "consumed" | "revoked";
  created_by_principal_id: string;
  expires_at: Date;
  created_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
}

interface CredentialMetadataRow {
  id: string;
  token_prefix: string;
  label: string;
  status: "active" | "revoked";
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export interface EnrollmentMetadata {
  id: string;
  tokenPrefix: string;
  label: string;
  address?: string;
  endpointOrigin?: string;
  status: "active" | "consumed" | "revoked" | "expired";
  createdByPrincipalId: string;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

export interface CredentialMetadata {
  id: string;
  tokenPrefix: string;
  label: string;
  status: "active" | "revoked" | "expired";
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export class RegistryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

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
        WHERE target_kind = 'local' AND status = 'active' AND (
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
    const prepared = await this.prepareRegistration(rawInput);

    const agent = await withTransaction(this.pool, async (client) => {
      await upsertPrincipal(client, { ...owner, kind: "human" });
      return this.insertRegistration(client, prepared, owner.id, "agent.register");
    });
    return agent;
  }

  async createEnrollment(rawInput: unknown, actorPrincipalId: string): Promise<{
    enrollment: EnrollmentMetadata;
    token: string;
  }> {
    const input = enrollmentSchema.parse(rawInput);
    const token = createEnrollmentToken();
    const address = input.address ? normalizeAddress(input.address, this.config.agentAddressDomain) : undefined;
    const endpointOrigin = input.endpointOrigin ? normalizeConfiguredOrigin(input.endpointOrigin) : undefined;
    if (endpointOrigin && new URL(endpointOrigin).protocol === "http:" && !this.config.allowHttpAgentEndpoints) {
      throw new RegistryError("enrollment_endpoint_https_required", 400);
    }
    return withTransaction(this.pool, async (client) => {
      const row = await oneOrUndefined<EnrollmentRow>(
        client,
        `INSERT INTO enrollment_tokens(
           token_hash, token_prefix, label, address, endpoint_origin, created_by_principal_id, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 second'))
         RETURNING id, token_prefix, label, address, endpoint_origin, status, created_by_principal_id,
                   expires_at, created_at, consumed_at, revoked_at`,
        [hashCredential(token), token.slice(0, 13), input.label, address ?? null, endpointOrigin ?? null,
          actorPrincipalId, input.expiresInSeconds],
      );
      if (!row) throw new Error("enrollment_creation_failed");
      await client.query(
        `INSERT INTO audit_logs(principal_id, action, target, outcome, facts)
         VALUES ($1, 'enrollment.create', $2, 'success', $3::jsonb)`,
        [actorPrincipalId, row.id, JSON.stringify({ address, endpointOrigin, expiresAt: row.expires_at.toISOString() })],
      );
      return { enrollment: mapEnrollmentRow(row), token };
    });
  }

  async listEnrollments(): Promise<EnrollmentMetadata[]> {
    const result = await this.pool.query<EnrollmentRow>(
      `SELECT id, token_prefix, label, address, endpoint_origin, status, created_by_principal_id,
              expires_at, created_at, consumed_at, revoked_at
         FROM enrollment_tokens
        ORDER BY created_at DESC
        LIMIT 200`,
    );
    return result.rows.map(mapEnrollmentRow);
  }

  async revokeEnrollment(id: string, actorPrincipalId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE enrollment_tokens
            SET status = 'revoked', revoked_at = now()
          WHERE id = $1 AND status = 'active'`,
        [id],
      );
      if (result.rowCount === 0) return false;
      await client.query(
        `INSERT INTO audit_logs(principal_id, action, target, outcome)
         VALUES ($1, 'enrollment.revoke', $2, 'success')`,
        [actorPrincipalId, id],
      );
      return true;
    });
  }

  async registerWithEnrollment(rawInput: unknown, enrollmentToken: string): Promise<{
    agent: RegisteredAgent;
    machineCredential: string;
  }> {
    if (!enrollmentToken.startsWith("are_")) throw new RegistryError("enrollment_token_invalid", 401);
    const prepared = await this.prepareRegistration(rawInput);
    return withTransaction(this.pool, async (client) => {
      const row = await oneOrUndefined<EnrollmentRow>(
        client,
        `SELECT id, token_prefix, label, address, endpoint_origin, status, created_by_principal_id,
                expires_at, created_at, consumed_at, revoked_at
           FROM enrollment_tokens
          WHERE token_hash = $1
          FOR UPDATE`,
        [hashCredential(enrollmentToken)],
      );
      if (!row || row.status !== "active" || row.expires_at.getTime() <= Date.now()) {
        throw new RegistryError("enrollment_token_invalid", 401);
      }
      if (row.address && row.address !== prepared.address) {
        throw new RegistryError("enrollment_address_mismatch", 403);
      }
      if (row.endpoint_origin && prepared.sourceAgentCard.supportedInterfaces.some(
        (entry) => new URL(entry.url).origin.toLowerCase() !== row.endpoint_origin,
      )) {
        throw new RegistryError("enrollment_endpoint_origin_mismatch", 403);
      }
      const consumed = await client.query(
        `UPDATE enrollment_tokens
            SET status = 'consumed', consumed_at = now()
          WHERE id = $1 AND status = 'active'`,
        [row.id],
      );
      if (consumed.rowCount !== 1) throw new RegistryError("enrollment_token_invalid", 401);
      return this.insertRegistration(client, prepared, row.created_by_principal_id, "agent.enroll");
    });
  }

  async listCredentials(addressValue: string): Promise<CredentialMetadata[] | undefined> {
    const agent = await this.getByAddress(addressValue);
    if (!agent || agent.targetKind !== "local") return undefined;
    const result = await this.pool.query<CredentialMetadataRow>(
      `SELECT id, token_prefix, label, status, created_at, last_used_at, expires_at, revoked_at
         FROM credentials
        WHERE principal_id = $1
        ORDER BY created_at DESC`,
      [`agent:${agent.id}`],
    );
    return result.rows.map(mapCredentialRow);
  }

  async createCredential(addressValue: string, rawInput: unknown, actorPrincipalId: string): Promise<{
    credential: CredentialMetadata;
    token: string;
  } | undefined> {
    const input = credentialSchema.parse(rawInput);
    const agent = await this.getByAddress(addressValue);
    if (!agent || agent.targetKind !== "local") return undefined;
    const token = createMachineCredential();
    return withTransaction(this.pool, async (client) => {
      const row = await oneOrUndefined<CredentialMetadataRow>(
        client,
        `INSERT INTO credentials(principal_id, token_hash, token_prefix, label, expires_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::integer IS NULL THEN NULL ELSE now() + ($5 * interval '1 second') END)
         RETURNING id, token_prefix, label, status, created_at, last_used_at, expires_at, revoked_at`,
        [`agent:${agent.id}`, hashCredential(token), token.slice(0, 12), input.label, input.expiresInSeconds ?? null],
      );
      if (!row) throw new Error("credential_creation_failed");
      await client.query(
        `INSERT INTO audit_logs(principal_id, action, target, outcome, facts)
         VALUES ($1, 'credential.create', $2, 'success', $3::jsonb)`,
        [actorPrincipalId, addressValue, JSON.stringify({ credentialId: row.id })],
      );
      return { credential: mapCredentialRow(row), token };
    });
  }

  async revokeCredential(addressValue: string, credentialId: string, actorPrincipalId: string): Promise<boolean | undefined> {
    const agent = await this.getByAddress(addressValue);
    if (!agent || agent.targetKind !== "local") return undefined;
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE credentials SET status = 'revoked', revoked_at = now()
          WHERE id = $1 AND principal_id = $2 AND status = 'active'`,
        [credentialId, `agent:${agent.id}`],
      );
      if (result.rowCount === 0) return false;
      await client.query(
        `INSERT INTO audit_logs(principal_id, action, target, outcome)
         VALUES ($1, 'credential.revoke', $2, 'success')`,
        [actorPrincipalId, credentialId],
      );
      return true;
    });
  }

  async rotateCredentials(addressValue: string, rawInput: unknown, actorPrincipalId: string): Promise<{
    credential: CredentialMetadata;
    token: string;
  } | undefined> {
    const input = credentialSchema.parse(rawInput);
    const agent = await this.getByAddress(addressValue);
    if (!agent || agent.targetKind !== "local") return undefined;
    const token = createMachineCredential();
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE credentials
            SET status = 'revoked', revoked_at = now()
          WHERE principal_id = $1 AND status = 'active'`,
        [`agent:${agent.id}`],
      );
      const row = await oneOrUndefined<CredentialMetadataRow>(
        client,
        `INSERT INTO credentials(principal_id, token_hash, token_prefix, label, expires_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::integer IS NULL THEN NULL ELSE now() + ($5 * interval '1 second') END)
         RETURNING id, token_prefix, label, status, created_at, last_used_at, expires_at, revoked_at`,
        [`agent:${agent.id}`, hashCredential(token), token.slice(0, 12), input.label, input.expiresInSeconds ?? null],
      );
      if (!row) throw new Error("credential_rotation_failed");
      await client.query(
        `INSERT INTO audit_logs(principal_id, action, target, outcome, facts)
         VALUES ($1, 'credential.rotate', $2, 'success', $3::jsonb)`,
        [actorPrincipalId, addressValue, JSON.stringify({ credentialId: row.id })],
      );
      return { credential: mapCredentialRow(row), token };
    });
  }

  private async prepareRegistration(rawInput: unknown): Promise<PreparedRegistration> {
    const input = registrationSchema.parse(rawInput);
    const address = normalizeAddress(input.address, this.config.agentAddressDomain);
    const sourceAgentCard = AgentCard.fromJSON(input.agentCard);
    assertAgentCard(sourceAgentCard);
    await Promise.all(sourceAgentCard.supportedInterfaces.map((entry) => assertSafeEndpoint(entry.url, {
      allowHttp: this.config.allowHttpAgentEndpoints,
      allowPrivate: this.config.allowPrivateAgentEndpoints,
    })));
    return {
      input,
      address,
      sourceAgentCard,
      ...(input.endpointBearerToken
        ? { endpointAuthCiphertext: encryptSecret(input.endpointBearerToken, this.config.encryptionKey) }
        : {}),
    };
  }

  private async insertRegistration(
    client: PoolClient,
    prepared: PreparedRegistration,
    ownerPrincipalId: string,
    auditAction: "agent.register" | "agent.enroll",
  ): Promise<{ agent: RegisteredAgent; machineCredential: string }> {
    const token = createMachineCredential();
    const row = await oneOrUndefined<AgentRow>(
      client,
      `INSERT INTO agents(
         address, display_name, description, source_agent_card, endpoint_auth_ciphertext, owner_principal_id
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id, address, display_name, description, source_agent_card, endpoint_auth_ciphertext,
                 target_kind, origin_domain, remote_card_expires_at, status, owner_principal_id, updated_at`,
      [prepared.address, prepared.input.displayName, prepared.input.description,
        JSON.stringify(AgentCard.toJSON(prepared.sourceAgentCard)), prepared.endpointAuthCiphertext ?? null, ownerPrincipalId],
    );
    if (!row) throw new Error("agent_registration_failed");
    const principalId = `agent:${row.id}`;
    await upsertPrincipal(client, { id: principalId, kind: "agent", displayName: prepared.input.displayName });
    await client.query(
      `INSERT INTO credentials(principal_id, token_hash, token_prefix, label)
       VALUES ($1, $2, $3, 'initial')`,
      [principalId, hashCredential(token), token.slice(0, 12)],
    );
    await client.query(
      `INSERT INTO audit_logs(principal_id, action, target, outcome, facts)
       VALUES ($1, $2, $3, 'success', $4::jsonb)`,
      [ownerPrincipalId, auditAction, prepared.address, JSON.stringify({ agentId: row.id })],
    );
    return { agent: mapAgentRow(row), machineCredential: token };
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
          JSON.stringify(AgentCard.toJSON(sourceAgentCard)),
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
          JSON.stringify(AgentCard.toJSON(sourceAgentCard)),
          originDomain,
          new Date(Date.now() + this.config.federationRemoteCardCacheMs),
        ],
      );
      if (!row) throw new Error("federated_agent_conflicts_with_local_agent");
      return mapAgentRow(row);
    });
  }
}

interface PreparedRegistration {
  input: RegisterAgentInput;
  address: string;
  sourceAgentCard: AgentCardType;
  endpointAuthCiphertext?: string;
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

function mapEnrollmentRow(row: EnrollmentRow): EnrollmentMetadata {
  const status = row.status === "active" && row.expires_at.getTime() <= Date.now() ? "expired" : row.status;
  return {
    id: row.id,
    tokenPrefix: row.token_prefix,
    label: row.label,
    ...(row.address ? { address: row.address } : {}),
    ...(row.endpoint_origin ? { endpointOrigin: row.endpoint_origin } : {}),
    status,
    createdByPrincipalId: row.created_by_principal_id,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    ...(row.consumed_at ? { consumedAt: row.consumed_at.toISOString() } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
  };
}

function mapCredentialRow(row: CredentialMetadataRow): CredentialMetadata {
  const status = row.status === "active" && row.expires_at && row.expires_at.getTime() <= Date.now()
    ? "expired"
    : row.status;
  return {
    id: row.id,
    tokenPrefix: row.token_prefix,
    label: row.label,
    status,
    createdAt: row.created_at.toISOString(),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at.toISOString() } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
  };
}

function normalizeConfiguredOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw new RegistryError("endpoint_origin_invalid", 400);
  }
  return url.origin.toLowerCase();
}
