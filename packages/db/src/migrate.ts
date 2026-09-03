import { fileURLToPath } from 'node:url';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import type { Connection } from './client.js';

// Apply the committed migrations. Idempotent: every migration is recorded in a journal
// table, and running again applies nothing. The journal lives in the same schema as the
// objects, so an isolated test schema carries its own.

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface MigrateResult {
  // Migrations recorded after the run, and how many this run added.
  readonly applied: number;
  readonly total: number;
}

export async function migrate(connection: Connection, schema = 'public'): Promise<MigrateResult> {
  const { db, sql } = connection;
  const before = await journalCount(sql, schema);
  await drizzleMigrate(db, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsSchema: schema,
    migrationsTable: '__drizzle_migrations',
  });
  const total = await journalCount(sql, schema);
  return { applied: total - before, total };
}

async function journalCount(sql: Connection['sql'], schema: string): Promise<number> {
  const exists = await sql`
    select 1 from information_schema.tables
    where table_schema = ${schema} and table_name = '__drizzle_migrations'`;
  if (exists.length === 0) return 0;
  const rows = await sql`select count(*)::int as n from ${sql(schema)}.__drizzle_migrations`;
  return Number(rows[0]?.['n'] ?? 0);
}
