import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditOurselves, loadOurselves, ourselvesDocument, retentionLines } from '@gc/artefacts';
import { declaredEndpoints, loadConfig } from '@gc/config';
import { CASE_EVENT_TYPES } from '@gc/contracts';
import { RETENTION } from '@gc/db';
import { localise } from '@gc/i18n';

// Our own compliance, published (O-01): the record of what we process, who processes it
// for us, the public sources we read, how long we keep everything and how it is deleted,
// generated from the configuration the service runs with. The record and the declared
// endpoints cannot drift apart: this test is the guard, and the page reads both live.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const record = loadOurselves();
const endpoints = declaredEndpoints();
const env = {
  NODE_ENV: 'test',
  APP_BASE_URL: 'https://gdprcompliant.eu',
  DATABASE_URL: 'postgres://gc:gc@db.internal:5432/gc',
  MODEL_BASE_URL: 'https://llm.example.eu/v1',
  MODEL_API_KEY: 'sk-test',
  MODEL_CHAT: 'chat-model',
  MODEL_EMBEDDING: 'embed-model',
};
const config = loadConfig(env, {
  endpoints: [...endpoints, { host: 'llm.example.eu', purpose: 'model', jurisdiction: 'DK' }],
});
const configured = [
  { purpose: 'model' as const, host: new URL(config.model.baseUrl).hostname },
  { purpose: 'database' as const, host: new URL(config.database.url).hostname },
];

describe('the sub-processor list against what is configured', () => {
  it('names every declared source with who runs it, and nothing that is not declared', () => {
    expect(auditOurselves(record, endpoints, configured)).toEqual([]);
    expect(record.sources.hosts.length).toBe(
      endpoints.filter((e) => ['corpus', 'registry', 'store'].includes(e.purpose)).length,
    );
    for (const s of record.sources.hosts) {
      expect(s.entity.length).toBeGreaterThan(3);
      expect(s.country).toMatch(/^(EU|[A-Z]{2})$/);
    }
  });

  it('fails the moment the list and the configuration drift apart', () => {
    const extra = [
      ...endpoints,
      { host: 'new-source.example', purpose: 'registry', jurisdiction: 'DK' },
    ];
    expect(auditOurselves(record, extra, configured)).toEqual([
      'new-source.example (registry) is declared but not published',
    ]);
    const fewer = endpoints.filter((e) => e.host !== 'db.offeneregister.de');
    expect(auditOurselves(record, fewer, configured)).toEqual([
      'db.offeneregister.de is published but not declared as an endpoint',
    ]);
    const moved = endpoints.map((e) =>
      e.host === 'apps.apple.com' ? { ...e, jurisdiction: 'US' } : e,
    );
    expect(auditOurselves(record, moved, configured)[0]).toMatch(
      /apps\.apple\.com is declared in US/,
    );
    const contracted = {
      ...record,
      processors: record.processors.map((p) =>
        p.purpose === 'model'
          ? {
              ...p,
              status: 'contracted' as const,
              entity: 'Example Inference GmbH',
              host: 'inference.example.de',
            }
          : p,
      ),
    };
    expect(auditOurselves(contracted, endpoints, configured)).toEqual([
      'the model is published as inference.example.de but configured as llm.example.eu',
    ]);
    const unnamed = {
      ...record,
      processors: record.processors.map((p) =>
        p.purpose === 'mail' ? { ...p, status: 'contracted' as const } : p,
      ),
    };
    expect(auditOurselves(unnamed, endpoints, [])).toEqual([
      'the mail processor is contracted but names no entity or host',
    ]);
  });

  it('a pending processor is allowed only until production', () => {
    expect(record.processors.some((p) => p.status === 'pending')).toBe(true);
    const inProduction = auditOurselves(record, endpoints, configured, true);
    expect(inProduction.length).toBe(
      record.processors.filter((p) => p.status === 'pending').length,
    );
    for (const line of inProduction) expect(line).toMatch(/still pending in production$/);
    for (const p of record.processors) expect(['EU', 'DK', 'DE']).toContain(p.country);
  });
});

describe('the retention schedule and the deletion path', () => {
  it('lists every table the database declares, with its rule, in every language', () => {
    for (const locale of ['en', 'da', 'de'] as const) {
      const lines = retentionLines(RETENTION, locale);
      expect(lines.map((l) => l.table).sort()).toEqual(Object.keys(RETENTION).sort());
      for (const l of lines) {
        expect(l.rule.length, `${locale} ${l.table}`).toBeGreaterThan(10);
        expect(l.rule).not.toMatch(/\{\w+\}/);
      }
    }
    expect(retentionLines(RETENTION, 'en').find((l) => l.table === 'cases')?.rule).toContain(
      '30 days',
    );
    expect(
      retentionLines(RETENTION, 'en').find((l) => l.table === 'demand_entries')?.rule,
    ).toContain('24 months');
  });

  it('exists before the first customer: the route, the function, the event, the steps', () => {
    expect(existsSync(join(ROOT, 'apps/web/app/[locale]/c/[token]/delete/route.ts'))).toBe(true);
    const migrations = readdirSync(join(ROOT, 'packages/db/migrations')).filter((f) =>
      f.endsWith('.sql'),
    );
    const sql = migrations
      .map((f) => readFileSync(join(ROOT, 'packages/db/migrations', f), 'utf8'))
      .join('\n');
    expect(sql).toMatch(/FUNCTION %I\.delete_case|delete_case\(/);
    expect(CASE_EVENT_TYPES).toContain('deletion_requested');
    expect(readFileSync(join(ROOT, 'apps/web/lib/case.ts'), 'utf8')).toMatch(
      /export function deleteForToken/,
    );
    expect(record.deletion.steps.length).toBeGreaterThanOrEqual(3);
    const steps = record.deletion.steps.map((s) => s['en']).join(' ');
    expect(steps).toMatch(/case number/);
    expect(steps).toMatch(/one transaction/);
    expect(steps).toMatch(/anonymous/);
    expect(steps).toMatch(/thirty days/);
  });
});

describe('the published record', () => {
  it('renders in every language without falling back, and names every source', () => {
    for (const locale of ['en', 'da', 'de'] as const) {
      const doc = ourselvesDocument({
        record,
        endpoints,
        retention: RETENTION,
        locale,
        generatedAt: '2026-09-04',
      });
      for (const e of endpoints.filter((x) => ['corpus', 'registry', 'store'].includes(x.purpose)))
        expect(doc, `${locale} ${e.host}`).toContain(e.host);
      for (const table of Object.keys(RETENTION)) expect(doc).toContain(`| ${table} |`);
      expect(doc).toContain(record.controller.name);
      const texts = [
        ...Object.values(record.headings),
        ...record.processing.flatMap((p) => [p.what, p.basis]),
        ...record.processors.flatMap((p) => [p.label, p.receives]),
        record.sources.note,
        ...record.deletion.steps,
      ];
      for (const text of texts) expect(localise(text, locale).fellBack, locale).toBe(false);
    }
    const de = ourselvesDocument({ record, endpoints, retention: RETENTION, locale: 'de' });
    expect(de).not.toMatch(/[æøå]/);
    expect(de).toContain('noch nicht beauftragt');
  });

  it('is current by construction: the page reads the endpoints and the retention rules at request time', () => {
    const lib = readFileSync(join(ROOT, 'apps/web/lib/ourselves.ts'), 'utf8');
    expect(lib).toMatch(/declaredEndpoints\(\)/);
    expect(lib).toMatch(/RETENTION/);
    expect(readFileSync(join(ROOT, 'apps/web/app/[locale]/ourselves/page.tsx'), 'utf8')).toMatch(
      /force-dynamic/,
    );
    expect(readFileSync(join(ROOT, 'apps/web/app/sitemap.ts'), 'utf8')).toMatch(/\/ourselves/);
    expect(readFileSync(join(ROOT, 'apps/web/app/[locale]/layout.tsx'), 'utf8')).toMatch(
      /shell\.footer\.ourselves/,
    );
    // A source that leaves the declaration leaves the document the same moment.
    const without = endpoints.filter((e) => e.host !== 'play.google.com');
    expect(
      ourselvesDocument({ record, endpoints: without, retention: RETENTION, locale: 'en' }),
    ).not.toContain('play.google.com');
  });
});
