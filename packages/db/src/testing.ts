import { randomBytes } from 'node:crypto';
import { connect, type Connection } from './client.js';
import { migrate } from './migrate.js';

// A disposable schema per test file, so integration tests run in parallel against one
// database and leave nothing behind. The connection string must be explicit: the test
// database, never DATABASE_URL, never a default.

export const TEST_DATABASE_ENV = 'GC_TEST_DATABASE_URL';

export interface TestDatabase extends Connection {
  readonly schema: string;
  // Drops the schema and everything in it, then closes the connection.
  readonly drop: () => Promise<void>;
}

export function testDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env[TEST_DATABASE_ENV];
  if (!url) {
    throw new Error(
      `${TEST_DATABASE_ENV} is not set. Integration tests never touch a developer database: point it at the test database, e.g. postgres://gc:gc@localhost:5432/gc_test (pnpm db:up creates it).`,
    );
  }
  if (!/gc_test|_test\b/.test(new URL(url).pathname)) {
    throw new Error(
      `${TEST_DATABASE_ENV} must name a test database (its name ends in _test), not ${url}`,
    );
  }
  return url;
}

export async function createTestDatabase(url: string = testDatabaseUrl()): Promise<TestDatabase> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = connect(url, { max: 1 });
  await admin.sql`create schema ${admin.sql(schema)}`;
  await admin.close();

  // The extension's types live in public; the schema's own objects come first.
  const connection = connect(url, { searchPath: [schema, 'public'] });
  await migrate(connection, schema);

  return {
    ...connection,
    schema,
    drop: async () => {
      await connection.sql`drop schema ${connection.sql(schema)} cascade`;
      await connection.close();
    },
  };
}
