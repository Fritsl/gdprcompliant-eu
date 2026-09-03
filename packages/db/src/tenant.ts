import { sql } from 'drizzle-orm';
import type { Connection, Db } from './client.js';

// The per-request tenant context (F-05). Every query the app runs on a tenant's behalf
// runs inside withTenant(): a transaction that sets the tenant for its own duration and
// switches to the app role, which row-level security applies to. Outside it, as the app
// role, every table is empty; as the owner, nothing stops you — which is why the app
// never queries as the owner.

export const APP_ROLE = 'gc_app';
export const TENANT_SETTING = 'app.tenant_id';

export async function withTenant<T>(
  connection: Connection,
  tenantId: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(tenantId)) throw new Error(`not a tenant id: ${tenantId}`);
  return connection.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${TENANT_SETTING}, ${tenantId}, true)`);
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    return work(tx as unknown as Db);
  });
}

// As the app role with no tenant set: what an unauthenticated code path would see.
export async function withoutTenant<T>(
  connection: Connection,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return connection.db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    return work(tx as unknown as Db);
  });
}
