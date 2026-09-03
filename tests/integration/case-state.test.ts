import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendCaseEvent,
  createTestDatabase,
  openCase,
  schema,
  syncCaseStage,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { eq } from 'drizzle-orm';

// The stage column follows the facts (C-03): re-derived from the timeline, written
// forward only, and left alone when the facts fall short of what it says.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

describe.skipIf(!url)('the stage follows the facts (C-03)', () => {
  let t: TestDatabase;
  let caseId = '';
  let tenantId = '';
  const stage = async () =>
    (
      await withTenant(t, tenantId, (db) =>
        db
          .select({ stage: schema.cases.stage })
          .from(schema.cases)
          .where(eq(schema.cases.id, caseId)),
      )
    )[0]?.stage;
  const append = (type: Parameters<typeof appendCaseEvent>[1]['type'], payload: object) =>
    withTenant(t, tenantId, (db) =>
      appendCaseEvent(db, {
        tenantId,
        caseId,
        at: new Date(),
        actor: { kind: 'scanner' },
        type,
        payload: payload as never,
      }),
    );

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('starts opened, and stays opened until a scan has completed', async () => {
    expect(await stage()).toBe('opened');
    const sync = await syncCaseStage(t, tenantId, caseId);
    expect(sync).toMatchObject({ before: 'opened', after: 'opened' });
    expect(sync.steps[0]?.missing).toEqual(['no scan has completed']);
  });

  it('advances one step per fact, and writes the stage', async () => {
    await append('scan_completed', {
      scanId: 's1',
      checksRun: 23,
      checksPassed: 11,
      findings: 12,
      undetermined: 0,
    });
    expect(await syncCaseStage(t, tenantId, caseId)).toMatchObject({
      before: 'opened',
      after: 'assessed',
    });
    expect(await stage()).toBe('assessed');
    await append('finding_closed', { findingId: 'f1', verifiedBy: 'rescan' });
    expect(await syncCaseStage(t, tenantId, caseId)).toMatchObject({
      before: 'assessed',
      after: 'working',
    });
    expect(await stage()).toBe('working');
  });

  it('cannot reach documented on events alone: the artefacts have to exist', async () => {
    for (const kind of ['processing_register', 'privacy_policy', 'processing_agreement']) {
      await append('artefact_published', { artefactId: `a-${kind}`, kind });
    }
    const sync = await syncCaseStage(t, tenantId, caseId);
    expect(sync.after).toBe('working');
    expect(sync.steps[0]?.missing).toHaveLength(3);
    const withArtefacts = await syncCaseStage(t, tenantId, caseId, [
      { kind: 'processing_register', published: true },
      { kind: 'privacy_policy', published: true },
      { kind: 'processing_agreement', published: true },
    ]);
    expect(withArtefacts).toMatchObject({ before: 'working', after: 'documented' });
    expect(await stage()).toBe('documented');
  });

  it('never moves backwards silently: a re-sync without the artefacts keeps the stage and reports it', async () => {
    const sync = await syncCaseStage(t, tenantId, caseId);
    expect(sync).toMatchObject({ before: 'documented', after: 'documented' });
    expect(sync.steps[0]?.regression).toMatchObject({ from: 'documented', derived: 'working' });
    expect(await stage()).toBe('documented');
  });
});
