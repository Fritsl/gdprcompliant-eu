import { asc, eq, sql } from 'drizzle-orm';
import { CaseEventSchema, type CaseEvent } from '@gc/contracts';
import type { Db } from './client.js';
import { caseEvents } from './schema.js';

// The timeline (C-02): append-only, ordered by a per-case sequence, every event naming
// its actor. This file is the only writer. The table refuses UPDATE and DELETE by
// trigger, for the owner as much as for the app role, so nothing here (or anywhere)
// can rewrite an event once it is in.

export interface AppendEvent {
  readonly tenantId: string;
  readonly caseId: string;
  readonly at: Date;
  readonly actor: CaseEvent['actor'];
  readonly type: CaseEvent['type'];
  readonly payload: CaseEvent['payload'];
}

// Two writers racing for the same sequence number collide on the unique index; the
// loser waits a few milliseconds, reads the new head and tries again, so the order is
// the order of commits.
export async function appendCaseEvent(db: Db, input: AppendEvent): Promise<CaseEvent> {
  // One appender per case at a time, for the length of the transaction: the head is read
  // and the row written under the same lock, so the retry below is a belt for the braces.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${input.caseId}))`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * attempt));
    const [head] = await db
      .select({ seq: sql<number>`coalesce(max(${caseEvents.seq}), 0)::int` })
      .from(caseEvents)
      .where(eq(caseEvents.caseId, input.caseId));
    const seq = (head?.seq ?? 0) + 1;
    const event = CaseEventSchema.parse({
      id: `${input.caseId}:${seq}`,
      tenantId: input.tenantId,
      caseId: input.caseId,
      seq,
      at: input.at.toISOString(),
      actor: input.actor,
      type: input.type,
      payload: input.payload,
    });
    try {
      const inserted = await db
        .insert(caseEvents)
        .values({
          id: event.id,
          tenantId: input.tenantId,
          sourceRef: `case:${input.caseId}`,
          caseId: input.caseId,
          seq,
          at: input.at,
          actor: event.actor,
          type: event.type,
          payload: event.payload,
        })
        .onConflictDoNothing({ target: [caseEvents.caseId, caseEvents.seq] })
        .returning({ id: caseEvents.id });
      if (inserted.length === 1) return event;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`could not append to ${input.caseId} after twenty-five attempts`, {
    cause: lastError,
  });
}

// Positional form, for the writers in cases.ts.
export const appendEvent = (
  db: Db,
  tenantId: string,
  caseId: string,
  at: Date,
  actor: CaseEvent['actor'],
  type: CaseEvent['type'],
  payload: CaseEvent['payload'],
): Promise<CaseEvent> => appendCaseEvent(db, { tenantId, caseId, at, actor, type, payload });

// The record, in order, as the contract types it. Runs as whoever the caller is: a
// tenant sees its own cases, nobody else's.
export async function caseTimeline(db: Db, caseId: string): Promise<CaseEvent[]> {
  const rows = await db
    .select()
    .from(caseEvents)
    .where(eq(caseEvents.caseId, caseId))
    .orderBy(asc(caseEvents.seq));
  return rows.map((r) =>
    CaseEventSchema.parse({
      id: r.id,
      tenantId: r.tenantId,
      caseId: r.caseId,
      seq: r.seq,
      at: r.at.toISOString(),
      actor: r.actor,
      type: r.type,
      payload: r.payload,
    }),
  );
}
