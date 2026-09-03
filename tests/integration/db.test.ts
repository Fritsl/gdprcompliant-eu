import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  TEST_DATABASE_ENV,
  connect,
  createTestDatabase,
  migrate,
  schema,
  testDatabaseUrl,
  type TestDatabase,
} from '@gc/db';

// The database harness (F-02): pgvector present, migrations idempotent, and a schema of
// its own for every test file that is gone afterwards. Needs GC_TEST_DATABASE_URL; with
// nothing set the suite says so and fails, never reaching for a developer database.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

describe.skipIf(!url)('the database harness (F-02)', () => {
  let a: TestDatabase;
  let b: TestDatabase;

  beforeAll(async () => {
    a = await createTestDatabase(url);
    b = await createTestDatabase(url);
  });

  afterAll(async () => {
    await a?.drop();
    await b?.drop();
  });

  it('has the vector extension', async () => {
    const rows = await a.sql`select extversion from pg_extension where extname = 'vector'`;
    expect(rows).toHaveLength(1);
    const dist = await a.sql`select '[1,2,3]'::vector <-> '[1,2,4]'::vector as d`;
    expect(Number(dist[0]?.['d'])).toBeCloseTo(1, 5);
  });

  it('migrations are idempotent: running again applies nothing', async () => {
    const again = await migrate(a, a.schema);
    expect(again.applied).toBe(0);
    expect(again.total).toBeGreaterThanOrEqual(1);
    expect(MIGRATIONS_DIR).toMatch(/packages[\\/]db[\\/]migrations/);
  });

  it('each test file gets its own schema, and they do not see each other', async () => {
    expect(a.schema).not.toBe(b.schema);
    await a.db.insert(schema.appMeta).values({ key: 'owner', value: 'a' });
    const inA = await a.db.select().from(schema.appMeta);
    const inB = await b.db.select().from(schema.appMeta);
    expect(inA.map((r) => r.value)).toEqual(['a']);
    expect(inB).toEqual([]);
    const where =
      await a.sql`select table_schema from information_schema.tables where table_name = 'app_meta' order by 1`;
    expect(where.map((r) => r['table_schema'])).toEqual(
      expect.arrayContaining([a.schema, b.schema]),
    );
    expect(where.map((r) => r['table_schema'])).not.toContain('public');
  });

  it('a dropped schema is gone', async () => {
    const c = await createTestDatabase(url);
    const name = c.schema;
    await c.sql`select 1`;
    await c.drop();
    const left = await a.sql`select 1 from information_schema.schemata where schema_name = ${name}`;
    expect(left).toHaveLength(0);
  });
});

describe('no test touches a developer database by default (F-02)', () => {
  it('the connection string must be explicit, and must name a test database', () => {
    expect(() => testDatabaseUrl({})).toThrow(new RegExp(`${TEST_DATABASE_ENV} is not set`));
    expect(() =>
      testDatabaseUrl({ [TEST_DATABASE_ENV]: 'postgres://gc:gc@localhost:5432/gdprcompliant' }),
    ).toThrow(/must name a test database/);
    expect(
      testDatabaseUrl({ [TEST_DATABASE_ENV]: 'postgres://gc:gc@localhost:5432/gc_test' }),
    ).toBe('postgres://gc:gc@localhost:5432/gc_test');
    expect(() => connect('mysql://x')).toThrow(/explicit postgres/);
  });
});
