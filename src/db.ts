import { readdir, readFile } from "node:fs/promises";
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
  const candidates = [join(sourceDir, "..", "migrations"), join(sourceDir, "..", "..", "migrations")];
  let migrationDir: string | undefined;
  let migrationFiles: string[] = [];
  for (const path of candidates) {
    try {
      migrationFiles = (await readdir(path)).filter((entry) => /^\d+_[a-z0-9_-]+\.sql$/.test(entry)).sort();
      migrationDir = path;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!migrationDir || migrationFiles.length === 0) throw new Error("migration_file_not_found");
  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-router-migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const appliedVersions = new Set(applied.rows.map((row) => row.version));
    for (const file of migrationFiles) {
      const version = file.replace(/\.sql$/, "");
      if (appliedVersions.has(version)) continue;
      await client.query(await readFile(join(migrationDir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
    }
  });
}
