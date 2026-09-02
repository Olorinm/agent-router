import { domainToASCII } from "node:url";
import type { Pool } from "pg";

export type FederationDomainStatus = "allowed" | "blocked";

export interface FederationDomainPolicy {
  domain: string;
  status: FederationDomainStatus;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface PolicyRow {
  domain: string;
  status: FederationDomainStatus;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

export class FederationPolicyStore {
  constructor(private readonly pool: Pool) {}

  async isAllowed(domainValue: string): Promise<boolean> {
    const domain = normalizeFederationDomain(domainValue);
    const result = await this.pool.query<{ allowed: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM federation_domains WHERE domain = $1 AND status = 'allowed') AS allowed",
      [domain],
    );
    return result.rows[0]?.allowed === true;
  }

  async list(): Promise<FederationDomainPolicy[]> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT domain, status, updated_by, created_at, updated_at
         FROM federation_domains
        ORDER BY domain`,
    );
    return result.rows.map(mapPolicy);
  }

  async set(domainValue: string, status: FederationDomainStatus, actorPrincipalId: string): Promise<FederationDomainPolicy> {
    const domain = normalizeFederationDomain(domainValue);
    const result = await this.pool.query<PolicyRow>(
      `INSERT INTO federation_domains(domain, status, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (domain) DO UPDATE SET
         status = EXCLUDED.status,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING domain, status, updated_by, created_at, updated_at`,
      [domain, status, actorPrincipalId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("federation_policy_write_failed");
    return mapPolicy(row);
  }

  async delete(domainValue: string): Promise<boolean> {
    const domain = normalizeFederationDomain(domainValue);
    const result = await this.pool.query("DELETE FROM federation_domains WHERE domain = $1", [domain]);
    return result.rowCount === 1;
  }
}

export function normalizeFederationDomain(value: string): string {
  const input = value.trim().toLowerCase().replace(/\.$/, "");
  const domain = domainToASCII(input);
  if (
    !domain ||
    domain.length > 253 ||
    domain.includes(":") ||
    !domain.includes(".") ||
    !domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("federation_domain_invalid");
  }
  return domain;
}

function mapPolicy(row: PolicyRow): FederationDomainPolicy {
  return {
    domain: row.domain,
    status: row.status,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
