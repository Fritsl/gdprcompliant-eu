import { describe, expect, it } from 'vitest';
import { CASE_EVENT_TYPES, CaseEventSchema, type CaseEvent } from '@gc/contracts';
import { TIMELINE_CONTENT, timelineContentGaps, timelineModel, timelinePdf } from '@gc/artefacts';
import { localise } from '@gc/i18n';

// The timeline wording and rendering (C-02): every event type has words, the words
// resolve their placeholders, actors are named, and the PDF carries the dates.

// pdfkit writes each line as hex glyph runs with kerning adjustments between them
// ([<hex> 10 <hex>] TJ). Drop the adjustments, decode the hex (WinAnsi for the standard
// fonts, so latin1), and the text is back.
const pdfText = (pdf: Buffer): string =>
  pdf
    .toString('latin1')
    .replace(/>\s*-?\d+(?:\.\d+)?\s*(?=<|\])/g, '>')
    .replace(/<([0-9a-fA-F]+)>/g, (_, h: string) => Buffer.from(h, 'hex').toString('latin1'));

const base = { id: 'x', tenantId: 't', caseId: 'DK-26-0M4K' };
const ev = (
  seq: number,
  type: CaseEvent['type'],
  payload: object,
  actor: CaseEvent['actor'] = { kind: 'scanner' },
) =>
  CaseEventSchema.parse({
    ...base,
    id: `${base.caseId}:${seq}`,
    seq,
    at: `2026-09-03T${String(9 + seq).padStart(2, '0')}:14:00Z`,
    actor,
    type,
    payload,
  });

const events: CaseEvent[] = [
  ev(1, 'case_opened', { source: 'scanner' }),
  ev(2, 'scan_completed', {
    scanId: 'scan-1',
    checksRun: 23,
    checksPassed: 11,
    findings: 12,
    undetermined: 0,
  }),
  ev(
    3,
    'finding_closed',
    { findingId: 'f-1', verifiedBy: 'rescan' },
    { kind: 'person', userId: 'u1', name: 'Mette' },
  ),
  ev(4, 'colleague_joined', { role: 'IT' }, { kind: 'person', userId: 'u2', name: 'Lars' }),
  ev(
    5,
    'vendor_resolved',
    { vendorId: 'v-1', resolution: 'resolved' },
    { kind: 'agent', name: 'planner', model: 'x-1' },
  ),
  ev(6, 'artefact_published', { artefactId: 'a-1', kind: 'privacy_policy' }),
  ev(7, 'watch_run', { scanId: 'scan-2', changes: 0 }, { kind: 'watcher' }),
  ev(8, 'case_claimed', { method: 'email', email: 'mette@eksempelbutik.dk' }, { kind: 'system' }),
];

describe('timeline wording', () => {
  it('covers every event type in the closed enum, and nothing else', () => {
    expect(timelineContentGaps()).toEqual({ missing: [], unknown: [] });
    expect(Object.keys(TIMELINE_CONTENT.events).length).toBe(CASE_EVENT_TYPES.length);
  });

  it('only asks for placeholders the event payload has', () => {
    for (const option of CaseEventSchema.options) {
      const type = option.shape.type.value;
      const keys = new Set(Object.keys(option.shape.payload.shape));
      const entry = TIMELINE_CONTENT.events[type]!;
      for (const text of [
        entry.text.en,
        entry.detail.en,
        entry.text.da ?? '',
        entry.detail.da ?? '',
      ]) {
        for (const m of text.matchAll(/\{\{([a-zA-Z]+)\}\}/g)) {
          expect(keys.has(m[1]!), `${type} uses {{${m[1]}}}`).toBe(true);
        }
      }
    }
  });
});

describe('timeline model', () => {
  it('dates, attributes and describes each event in the locale, and tracks the stage', () => {
    const model = timelineModel('DK-26-0M4K', [...events].reverse(), { locale: 'en' });
    expect(model.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(model.entries.map((e) => [e.actor, e.text, e.detail])).toEqual([
      ['Scanner', 'Case opened', 'from the scanner'],
      ['Scanner', 'Scan completed', '23 checks · 11 passed · 12 findings · 0 undetermined'],
      ['Mette', 'Finding closed', 'f-1 · verified by rescan'],
      ['Lars', 'Joined the case', 'IT'],
      ['Assistant (x-1)', 'Vendor identified', 'v-1 · resolved'],
      ['Scanner', 'Document published', 'privacy_policy'],
      ['Weekly check', 'Weekly check ran', '0 change(s) · scan-2'],
      ['System', 'Case claimed', 'email · mette@eksempelbutik.dk'],
    ]);
    expect(model.entries.map((e) => e.state)).toEqual([
      'opened',
      'assessed',
      'working',
      'working',
      'working',
      'documented',
      'watched',
      'watched',
    ]);
    expect(model.entries[2]?.closed).toBe(true);
    expect(model.entries[0]?.when).toMatch(/^3 Sept? 2026, 12:14$|^Sept? 3, 2026, 12:14 PM$/);
    expect(model.entries.every((e) => !e.fellBack)).toBe(true);
    expect(JSON.stringify(model)).not.toContain('{{');
  });

  it('renders Danish and German, and marks a fallback when a language is missing', () => {
    const da = timelineModel('DK-26-0M4K', events.slice(0, 2), { locale: 'da' });
    expect(da.entries.map((e) => e.text)).toEqual(['Sag åbnet', 'Scanning gennemført']);
    expect(da.entries[1]?.detail).toBe('23 tjek · 11 bestået · 12 konstateringer · 0 uafklarede');
    const de = timelineModel('DK-26-0M4K', events.slice(0, 1), { locale: 'de' });
    expect(de.entries[0]).toMatchObject({ text: 'Fall eröffnet', fellBack: false });
    // A language the wording lacks falls back to English, and the fallback is marked.
    expect(localise({ en: 'Case opened' }, 'de')).toMatchObject({
      value: 'Case opened',
      fellBack: true,
    });
  });
});

describe('timeline PDF', () => {
  it('is a dated PDF with the case number, every entry and a page footer', async () => {
    const model = timelineModel('DK-26-0M4K', events, { locale: 'en' });
    const pdf = await timelinePdf(model, {
      title: 'Timeline',
      generatedAt: new Date('2026-09-04T08:00:00Z'),
      generatedLabel: 'Generated',
      pageLabel: (p, n) => `Page ${p} of ${n}`,
      compress: false,
    });
    const text = pdfText(pdf);
    expect(text.startsWith('%PDF-1.')).toBe(true);
    expect(pdf.length).toBeGreaterThan(2_000);
    for (const needle of [
      'DK-26-0M4K',
      'Generated 2026-09-04',
      'Case opened',
      'Finding closed',
      'Mette',
      'Page 1 of 1',
    ]) {
      expect(text, needle).toContain(needle);
    }
  });
});
