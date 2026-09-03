import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timelineModel, timelinePdf } from '@gc/artefacts';
import {
  appendCaseEvent,
  caseTimeline,
  createTestDatabase,
  openCase,
  schema,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { eq } from 'drizzle-orm';

// The timeline (C-02) against the database: ordered under concurrency, immutable for
// everyone including the owner, every event with an actor the database recognises,
// and the record read back and rendered as a dated PDF.

// pdfkit writes each line as hex glyph runs with kerning adjustments between them
// ([<hex> 10 <hex>] TJ). Drop the adjustments, decode the hex (WinAnsi for the standard
// fonts, so latin1), and the text is back.
const pdfText = (pdf: Buffer): string =>
  pdf
    .toString('latin1')
    .replace(/>\s*-?\d+(?:\.\d+)?\s*(?=<|\])/g, '>')
    .replace(/<([0-9a-fA-F]+)>/g, (_, h: string) => Buffer.from(h, 'hex').toString('latin1'));

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-03T09:14:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

async function failsWith(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = '';
  try {
    await work;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    message = [err.message, err.cause?.message ?? ''].join(' ');
  }
  expect(message).toMatch(pattern);
}

describe.skipIf(!url)('the timeline (C-02)', () => {
  let t: TestDatabase;
  let caseId = '';
  let tenantId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('appends in order, even when five writers race for the next number', async () => {
    await withTenant(t, tenantId, (db) =>
      appendCaseEvent(db, {
        tenantId,
        caseId,
        at: at(1),
        actor: { kind: 'scanner' },
        type: 'scan_started',
        payload: { scanId: 'scan-1', kind: 'initial' },
      }),
    );
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        withTenant(t, tenantId, (db) =>
          appendCaseEvent(db, {
            tenantId,
            caseId,
            at: at(2),
            actor: { kind: 'person', userId: `u${n}`, name: `Person ${n}` },
            type: 'note_added',
            payload: { text: `note ${n}` },
          }),
        ),
      ),
    );
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.map((e) => e.type)).toEqual([
      'case_opened',
      'scan_started',
      'note_added',
      'note_added',
      'note_added',
      'note_added',
      'note_added',
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(7);
  });

  it('refuses an update or a delete, for the app role and for the owner alike', async () => {
    await failsWith(
      withTenant(t, tenantId, (db) =>
        db
          .update(schema.caseEvents)
          .set({ type: 'note_added' })
          .where(eq(schema.caseEvents.caseId, caseId)),
      ),
      /append-only/,
    );
    await failsWith(
      withTenant(t, tenantId, (db) =>
        db.delete(schema.caseEvents).where(eq(schema.caseEvents.caseId, caseId)),
      ),
      /append-only/,
    );
    await failsWith(
      t.sql`update case_events set payload = '{}' where case_id = ${caseId}`,
      /append-only/,
    );
    await failsWith(t.sql`delete from case_events where case_id = ${caseId}`, /append-only/);
    expect((await withTenant(t, tenantId, (db) => caseTimeline(db, caseId))).length).toBe(7);
  });

  it('refuses an event without an actor the contract knows, in code and in the database', async () => {
    await expect(
      withTenant(t, tenantId, (db) =>
        appendCaseEvent(db, {
          tenantId,
          caseId,
          at: at(3),
          actor: { kind: 'robot' } as never,
          type: 'note_added',
          payload: { text: 'x' },
        }),
      ),
    ).rejects.toThrow();
    await failsWith(
      t.sql`insert into case_events (id, tenant_id, source_ref, case_id, seq, at, actor, type, payload)
            values ('x', ${tenantId}, 'test', ${caseId}, 99, now(), '{"name":"nobody"}', 'note_added', '{}')`,
      /case_events_actor/,
    );
    await failsWith(
      t.sql`insert into case_events (id, tenant_id, source_ref, case_id, seq, at, actor, type, payload)
            values ('y', ${tenantId}, 'test', ${caseId}, 99, now(), '{"kind":"system"}', 'something_else', '{}')`,
      /case_events_type/,
    );
  });

  it('reads back as the record, and renders as a dated PDF', async () => {
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    const model = timelineModel(caseId, events, { locale: 'da' });
    expect(model.entries[0]).toMatchObject({
      actor: 'Scanner',
      text: 'Sag åbnet',
      detail: 'fra scanner',
    });
    expect(model.entries[2]).toMatchObject({ actor: 'Person 1', text: 'Note', detail: 'note 1' });
    const pdf = await timelinePdf(model, {
      title: 'Tidslinje',
      generatedAt: new Date('2026-09-04T08:00:00Z'),
      generatedLabel: 'Genereret',
      pageLabel: (p, n) => `Side ${p} af ${n}`,
      compress: false,
    });
    const text = pdfText(pdf);
    expect(text.startsWith('%PDF-')).toBe(true);
    for (const needle of [caseId, 'Genereret 2026-09-04', 'note 5', 'Side 1 af 1']) {
      expect(text, needle).toContain(needle);
    }
  });
});
