import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg, { type Pool, type PoolClient, type QueryResultRow } from "pg";

const { Pool: PgPool } = pg;

export function createPool(databaseUrl: string): Pool {
  return new PgPool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function oneOrUndefined<T extends QueryResultRow>(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  text: string,
  values: readonly unknown[] = [],
): Promise<T | undefined> {
  const result = await client.query<T>(text, [...values]);
  if (result.rowCount === 0) return undefined;
  if (result.rowCount !== 1) throw new Error(`expected_one_row_received_${result.rowCount}`);
  return result.rows[0];
}

export async function migrate(pool: Pool): Promise<void> {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(sourceDir, "..", "migrations", "001_initial.sql"),
    join(sourceDir, "..", "..", "migrations", "001_initial.sql"),
  ];
  let sql: string | undefined;
  for (const path of candidates) {
    try {
      sql = await readFile(path, "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!sql) throw new Error("migration_file_not_found");
  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-router-migrations'))");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
      ["001_initial"],
    );
  });
}
