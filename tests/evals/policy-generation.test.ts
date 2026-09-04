import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLICY_SECTIONS, tracesOf, withoutTraces } from '@gc/artefacts';
import { canonicalJson, sha256 } from '@gc/contracts';
import {
  CONTACT_QUESTIONS,
  confirmRegisterRow,
  createTestDatabase,
  documentGaps,
  draftDocument,
  generateDocument,
  graphOf,
  openCase,
  recordAnswer,
  registerRows,
  schema,
  seedRegister,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { loadBindingTables, loadCookieDatabase } from '@gc/findings';
import { bannedClaims, loadClaimVocabulary } from '@gc/i18n';

// Policy generation (G-02): a privacy policy and a cookie declaration written from the
// graph. Every statement traces to a graph row or an answer; a register with gaps gets
// a refusal that names them; the document comes out in the case's language and with
// the jurisdiction's authority; and the cookie declaration lists what the site set,
// refusing while a cookie is unknown.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-04T09:14:00Z');
const vocab = loadClaimVocabulary();
const cookieDb = loadCookieDatabase();
const mette = { kind: 'person' as const, userId: 'u-mette', name: 'Mette' };

describe.skipIf(!url)('policy generation (G-02)', () => {
  let t: TestDatabase;
  const cases: Record<'DK' | 'DE', { tenantId: string; caseId: string }> = {
    DK: { tenantId: '', caseId: '' },
    DE: { tenantId: '', caseId: '' },
  };

  // A case with an evidence row, a seeded register (forms and a recipient), and cookies.
  async function seed(jurisdiction: 'DK' | 'DE') {
    const locale = jurisdiction === 'DK' ? 'da' : 'de';
    const opened = await openCase(t, {
      company: {
        domain: jurisdiction === 'DK' ? 'eksempelbutik.dk' : 'beispielshop.de',
        legalName: jurisdiction === 'DK' ? 'Eksempelbutik ApS' : 'Beispielshop GmbH',
        country: jurisdiction,
        locale,
      },
      jurisdiction,
      locale,
      now: () => T0,
    });
    const { tenantId, caseId } = opened;
    const domain = jurisdiction === 'DK' ? 'eksempelbutik.dk' : 'beispielshop.de';
    const evidenceRef = await withTenant(t, tenantId, async (db) => {
      const body = `form on /tilmeld at ${domain}`;
      const hash = sha256(body);
      const id = `form:${hash.slice(0, 16)}`;
      await db.insert(schema.evidence).values({
        id,
        tenantId,
        sourceRef: 'scanner:scan-1',
        caseId,
        kind: 'form',
        capturedAt: T0,
        body,
        hash,
        caption: 'sign-up form',
      });
      for (const c of [
        { name: '_ga', domain: `.${domain}`, expires: T0.getTime() / 1000 + 400 * 86_400 },
        { name: 'kunja_pref', domain, expires: -1 },
      ]) {
        const cbody = canonicalJson({
          ...c,
          path: '/',
          value: 'x',
          httpOnly: false,
          secure: true,
          sameSite: 'Lax',
        });
        const chash = sha256(cbody);
        await db.insert(schema.evidence).values({
          id: `cookie:${chash.slice(0, 16)}`,
          tenantId,
          sourceRef: 'scanner:scan-1',
          caseId,
          kind: 'cookie',
          capturedAt: T0,
          body: cbody,
          hash: chash,
          caption: `cookie ${c.name}`,
        });
      }
      return { evidenceId: id, hash };
    });
    await seedRegister(t, tenantId, caseId, {
      scanId: 'scan-1',
      now: T0,
      forms: {
        site: 'tilmeld.test',
        startedAt: T0.toISOString(),
        pages: ['http://tilmeld.test/'],
        forms: [
          {
            page: 'http://tilmeld.test/tilmeld.html',
            index: 0,
            action: '/tilmeld',
            method: 'post',
            submitLabel: 'Tilmeld',
            fields: [
              { name: 'email', type: 'email', required: true, category: 'contact' },
              { name: 'navn', type: 'text', required: false, category: 'contact' },
            ],
            controls: [
              {
                name: 'nyhedsbrev',
                kind: 'checkbox',
                label: 'Ja tak til nyhedsbrevet',
                checkedInMarkup: false,
                checkedAfterScripts: false,
                hidden: false,
                required: false,
                purposes: ['marketing'],
              },
            ],
            sensitivity: 'contact',
            notice: { found: false },
            evidence: evidenceRef,
          },
          {
            page: 'http://tilmeld.test/kassen.html',
            index: 0,
            action: '/kassen',
            method: 'post',
            submitLabel: 'Betal',
            fields: [
              { name: 'email', type: 'email', required: true, category: 'contact' },
              { name: 'kort', type: 'text', required: true, category: 'financial' },
            ],
            controls: [],
            sensitivity: 'financial',
            notice: { found: false },
            evidence: evidenceRef,
          },
        ],
        observations: [],
        submitted: false,
      },
    });
    return { tenantId, caseId, evidenceRef };
  }

  beforeAll(async () => {
    t = await createTestDatabase(url);
    cases.DK = await seed('DK');
    cases.DE = await seed('DE');
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('refuses while the register has gaps, and names every one of them', async () => {
    const { tenantId, caseId } = cases.DK;
    const gaps = await documentGaps(t, tenantId, caseId, 'privacy_policy', { now: T0 });
    const codes = gaps.map((g) => g.code);
    expect(codes).toContain('no_confirmed_activity');
    expect(codes.filter((c) => c === 'draft_activity')).toHaveLength(2);
    expect(codes).toContain('no_contact');
    expect(gaps.every((g) => g.text.length > 10)).toBe(true);
    expect(gaps.some((g) => g.text.includes('Nyhedsbrev'))).toBe(true);
    const refused = await generateDocument(t, tenantId, {
      caseId,
      kind: 'privacy_policy',
      by: mette,
      now: T0,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.gaps.map((g) => g.code)).toEqual(codes);
    expect(await withTenant(t, tenantId, (db) => db.select().from(schema.artefacts))).toEqual([]);
  });

  it('once the rows are confirmed and the contact answered, every statement traces to a graph row or an answer', async () => {
    const { tenantId, caseId } = cases.DK;
    for (const row of await registerRows(t, tenantId, caseId)) {
      await confirmRegisterRow(t, tenantId, {
        caseId,
        activityId: row.activityId,
        answerId: `Q-${row.name}`,
        by: 'Mette',
        at: new Date(T0.getTime() + 60_000),
        corrections: {
          retention:
            row.name === 'orders' ? '5 år efter ordren, bogføringsloven' : '2 år efter afmelding',
        },
      });
    }
    // Still a gap: the contact.
    const before = await documentGaps(t, tenantId, caseId, 'privacy_policy', { now: T0 });
    expect(before.map((g) => g.code)).toEqual(['no_contact']);
    await recordAnswer(t, tenantId, {
      caseId,
      questionId: CONTACT_QUESTIONS.address,
      answer: 'Testvej 1, 2100 København Ø',
      by: mette,
      at: T0,
    });
    await recordAnswer(t, tenantId, {
      caseId,
      questionId: CONTACT_QUESTIONS.email,
      answer: 'privatliv@eksempelbutik.dk',
      by: mette,
      at: T0,
    });
    expect(await documentGaps(t, tenantId, caseId, 'privacy_policy', { now: T0 })).toEqual([]);

    const draft = await draftDocument(t, tenantId, caseId, 'privacy_policy', { now: T0 });
    expect(draft.locale).toBe('da');
    expect(draft.document.ok).toBe(true);
    if (!draft.document.ok) return;
    const g = await withTenant(t, tenantId, (db) => graphOf(db, caseId));
    const nodeIds = new Set(g.nodes.map((n) => n.id));
    const answerIds = new Set(
      (
        await withTenant(t, tenantId, (db) =>
          db.select({ id: schema.answers.id }).from(schema.answers),
        )
      ).map((a) => a.id),
    );
    const known = (ref: string) =>
      nodeIds.has(ref) ||
      answerIds.has(ref) ||
      ref === 'case:company' ||
      ref === 'binding:authority';
    expect(draft.document.statements.length).toBeGreaterThan(10);
    for (const s of draft.document.statements) {
      expect(s.trace.length, s.text).toBeGreaterThan(0);
      for (const ref of s.trace) expect(known(ref), `${s.section}: ${ref}`).toBe(true);
    }
    // The markdown carries the same traces, one per paragraph, and nothing else.
    const traces = tracesOf(draft.document.markdown);
    expect(traces).toHaveLength(draft.document.statements.length);
    const shown = withoutTraces(draft.document.markdown);
    expect(shown).not.toContain('<!--');
    // Every Article 13 element has its section, in order.
    const headings = [...shown.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings.length).toBeGreaterThanOrEqual(POLICY_SECTIONS.length - 2);
    expect(shown).toContain('Eksempelbutik ApS er dataansvarlig');
    expect(shown).toContain('Testvej 1');
    expect(shown).toContain('Nyhedsbrev');
    expect(shown).toContain('Samtykke, artikel 6, stk. 1, litra a');
    expect(shown).toContain('5 år efter ordren');
    expect(shown).toContain(loadBindingTables().get('DK')!.authority.name);
    expect(bannedClaims(shown.split('\n---\n')[0]!, 'da', vocab)).toEqual([]);

    // Stored as a draft version the sign-off gate guards.
    const stored = await generateDocument(t, tenantId, {
      caseId,
      kind: 'privacy_policy',
      by: mette,
      now: T0,
    });
    expect(stored.ok).toBe(true);
    const rows = await withTenant(t, tenantId, (db) => db.select().from(schema.artefacts));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'privacy_policy',
      status: 'draft',
      locale: 'da',
      version: 1,
    });
    expect(rows[0]!.content).toBe(draft.document.markdown);
  });

  it('a German case reads in German with the German authority, structured the same', async () => {
    const { tenantId, caseId } = cases.DE;
    for (const row of await registerRows(t, tenantId, caseId)) {
      await confirmRegisterRow(t, tenantId, {
        caseId,
        activityId: row.activityId,
        answerId: `Q-${row.name}`,
        by: 'Anna',
        at: new Date(T0.getTime() + 60_000),
        corrections: { retention: '2 Jahre nach Abmeldung' },
      });
    }
    await recordAnswer(t, tenantId, {
      caseId,
      questionId: CONTACT_QUESTIONS.address,
      answer: 'Musterstraße 1, 10115 Berlin',
      by: mette,
      at: T0,
    });
    await recordAnswer(t, tenantId, {
      caseId,
      questionId: CONTACT_QUESTIONS.email,
      answer: 'datenschutz@beispielshop.de',
      by: mette,
      at: T0,
    });
    const draft = await draftDocument(t, tenantId, caseId, 'privacy_policy', { now: T0 });
    expect(draft.locale).toBe('de');
    expect(draft.document.ok).toBe(true);
    if (!draft.document.ok) return;
    const shown = withoutTraces(draft.document.markdown);
    expect(shown).toContain('# Datenschutzerklärung');
    expect(shown).toContain('Beispielshop GmbH ist der Verantwortliche');
    expect(shown).toContain('Einwilligung, Artikel 6 Absatz 1 Buchstabe a');
    expect(shown).toContain(loadBindingTables().get('DE')!.authority.name);
    expect(shown).not.toContain('Datatilsynet');
    expect(bannedClaims(shown.split('\n---\n')[0]!, 'de', vocab)).toEqual([]);
    // The same structure as the Danish document: one heading per element written.
    const daDraft = await draftDocument(t, cases.DK.tenantId, cases.DK.caseId, 'privacy_policy', {
      now: T0,
    });
    expect(daDraft.document.ok).toBe(true);
    if (!daDraft.document.ok) return;
    const sectionsDe = [...shown.matchAll(/^## /gm)].length;
    const sectionsDa = [...withoutTraces(daDraft.document.markdown).matchAll(/^## /gm)].length;
    expect(sectionsDe).toBe(sectionsDa);
  });

  it('the cookie declaration lists what the site set, and refuses while a cookie is unknown', async () => {
    const { tenantId, caseId } = cases.DK;
    const gaps = await documentGaps(t, tenantId, caseId, 'cookie_declaration', {
      now: T0,
      cookieDatabase: cookieDb,
    });
    expect(gaps.map((g) => g.code)).toEqual(['unknown_cookie']);
    expect(gaps[0]!.cookie).toBe('kunja_pref');
    // A database that knows the session cookie: nothing left to answer.
    const known = {
      ...cookieDb,
      version: cookieDb.version,
      lookup: (name: string, domain?: string) =>
        name === 'kunja_pref'
          ? [
              {
                id: 'php',
                platform: 'Kunja',
                category: 'necessary' as const,
                name: 'kunja_pref',
                wildcard: false,
                description: 'Keeps the session',
                retention: 'session',
              },
            ]
          : cookieDb.lookup(name, domain),
    } as typeof cookieDb;
    expect(
      await documentGaps(t, tenantId, caseId, 'cookie_declaration', {
        now: T0,
        cookieDatabase: known,
      }),
    ).toEqual([]);
    const draft = await draftDocument(t, tenantId, caseId, 'cookie_declaration', {
      now: T0,
      cookieDatabase: known,
    });
    expect(draft.document.ok).toBe(true);
    if (!draft.document.ok) return;
    const shown = withoutTraces(draft.document.markdown);
    expect(shown).toContain('# Cookiedeklaration');
    expect(shown).toContain('## Statistik');
    expect(shown).toContain('## Nødvendige');
    expect(shown).toMatch(/\| _ga \| .* \| 400 dage \|/);
    expect(shown).toMatch(/\| kunja_pref \| Kunja \| Keeps the session \| Session \|/);
    for (const s of draft.document.statements)
      expect(s.trace.every((r) => r.startsWith('cookie:'))).toBe(true);
    expect(bannedClaims(shown.split('\n---\n')[0]!, 'da', vocab)).toEqual([]);
  });
});
