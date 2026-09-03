import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

// One way to open the database. The connection string is always explicit: nothing in
// this package reads an environment variable, so a test cannot reach a developer's
// database by accident (F-02). Config (@gc/config) decides what the app connects to.

export type Db = PostgresJsDatabase<typeof schema>;

export interface Connection {
  readonly db: Db;
  readonly sql: Sql;
  readonly close: () => Promise<void>;
}

export interface ConnectOptions {
  // Schemas searched, first to last. Tests put their own schema first.
  readonly searchPath?: readonly string[];
  readonly max?: number;
}

export function connect(url: string, options: ConnectOptions = {}): Connection {
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('connect() needs an explicit postgres:// connection string');
  }
  const sql = postgres(url, {
    max: options.max ?? 4,
    onnotice: () => undefined,
    ...(options.searchPath ? { connection: { search_path: options.searchPath.join(',') } } : {}),
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

export { schema };
