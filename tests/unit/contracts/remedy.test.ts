import { describe, expect, it } from 'vitest';
import {
  ActionSchema,
  DemandLedgerEntrySchema,
  REMEDY_KINDS,
  RemedySchema,
  RenderedRemedySchema,
  VerificationSchema,
} from '@gc/contracts';

const action = {
  kind: 'agent_prompt',
  label: 'Paste into your coding assistant',
  body: 'On eksempelbutik.dk these hosts load before consent: connect.facebook.net',
};

const rendered = {
  id: 'rem-cns-02',
  version: 1,
  findingTypeId: 'CNS-02',
  jurisdictions: 'all',
  locale: 'en',
  kind: 'self_fix',
  title: 'Move the tags behind the consent state',
  effort: { label: 'About 20 minutes', minutes: 20 },
  detail: 'Wrap each non-essential tag in a consent check and re-publish.',
  verification: { method: 'rescan' },
  action,
};

const localised = {
  ...rendered,
  locale: undefined,
  title: { en: 'Move the tags behind the consent state', da: 'Flyt tags bag samtykket' },
  effort: { label: { en: 'About 20 minutes' }, minutes: 20 },
  detail: { en: 'Wrap each non-essential tag in a consent check and re-publish.' },
  action: { ...action, label: { en: action.label }, body: { en: action.body } },
};

describe('Remedy kinds (R-01)', () => {
  it('are exactly the five', () => {
    expect([...REMEDY_KINDS]).toEqual([
      'self_fix',
      'generated_artefact',
      'our_product',
      'partner_alternative',
      'no_solution',
    ]);
  });

  it('an unknown kind is rejected', () => {
    expect(RenderedRemedySchema.safeParse({ ...rendered, kind: 'consultant' }).success).toBe(false);
  });

  it('a rendered remedy parses in one locale', () => {
    expect(RenderedRemedySchema.safeParse(rendered).success).toBe(true);
    expect(RenderedRemedySchema.safeParse({ ...rendered, locale: undefined }).success).toBe(false);
  });

  it('a catalogue entry carries locale variants with English mandatory', () => {
    expect(RemedySchema.safeParse(localised).success).toBe(true);
    expect(RemedySchema.safeParse({ ...localised, title: { da: 'kun dansk' } }).success).toBe(
      false,
    );
  });

  it('a self_fix must be actionable in one click', () => {
    const { action: _drop, ...noAction } = rendered;
    expect(_drop).toBeDefined();
    expect(RenderedRemedySchema.safeParse(noAction).success).toBe(false);
  });

  it('a no_solution records the gap it writes to the demand ledger (R-02)', () => {
    const noSolution = {
      ...rendered,
      kind: 'no_solution',
      verification: {
        method: 'none',
        reason: 'No public way to attribute an anonymised CDN host.',
      },
      action: undefined,
    };
    expect(RenderedRemedySchema.safeParse(noSolution).success).toBe(false);
    expect(
      RenderedRemedySchema.safeParse({
        ...noSolution,
        demandGap: 'Attributing anonymised CDN hosts',
      }).success,
    ).toBe(true);
  });

  it('a generated_artefact names the artefact, our_product names the product, partner_alternative lists options', () => {
    expect(
      RenderedRemedySchema.safeParse({
        ...rendered,
        kind: 'generated_artefact',
        artefact: 'processing_agreement',
        cta: 'Preview the draft',
        verification: { method: 'artefact_published', artefact: 'processing_agreement' },
        action: undefined,
      }).success,
    ).toBe(true);
    expect(
      RenderedRemedySchema.safeParse({
        ...rendered,
        kind: 'generated_artefact',
        cta: 'Preview',
        action: undefined,
      }).success,
    ).toBe(false);

    expect(
      RenderedRemedySchema.safeParse({
        ...rendered,
        kind: 'our_product',
        product: { id: 'gdprchat', url: 'https://gdprchat.eu' },
        cta: 'See what it would cost',
        verification: { method: 'attestation', statement: 'The four people have moved.' },
        action: undefined,
      }).success,
    ).toBe(true);

    expect(
      RenderedRemedySchema.safeParse({
        ...rendered,
        kind: 'partner_alternative',
        options: [],
        action: undefined,
      }).success,
    ).toBe(false);
    expect(
      RenderedRemedySchema.safeParse({
        ...rendered,
        kind: 'partner_alternative',
        options: [{ name: 'Mailbox provider', jurisdiction: 'DE' }],
        action: undefined,
      }).success,
    ).toBe(true);
  });

  it('every remedy declares a verification method', () => {
    const { verification: _drop, ...noVerify } = rendered;
    expect(_drop).toBeDefined();
    expect(RenderedRemedySchema.safeParse(noVerify).success).toBe(false);
    expect(VerificationSchema.safeParse({ method: 'none' }).success).toBe(false);
    expect(VerificationSchema.safeParse({ method: 'answer', questionId: 'Q3' }).success).toBe(true);
  });

  it('jurisdiction scope is all or a non-empty list', () => {
    expect(RenderedRemedySchema.safeParse({ ...rendered, jurisdictions: [] }).success).toBe(false);
    expect(
      RenderedRemedySchema.safeParse({ ...rendered, jurisdictions: ['DK', 'DE'] }).success,
    ).toBe(true);
  });
});

describe('Action', () => {
  it('is one of the closed set of one-click shapes', () => {
    expect(ActionSchema.safeParse(action).success).toBe(true);
    expect(
      ActionSchema.safeParse({
        kind: 'message',
        label: 'Send',
        to: 'Agency',
        subject: 'What is x?',
        body: 'Hi',
      }).success,
    ).toBe(true);
    expect(ActionSchema.safeParse({ kind: 'message', label: 'Send', body: 'Hi' }).success).toBe(
      false,
    );
    expect(ActionSchema.safeParse({ kind: 'phone_call', label: 'Call' }).success).toBe(false);
  });
});

describe('DemandLedgerEntry (R-05)', () => {
  it('parses', () => {
    expect(
      DemandLedgerEntrySchema.safeParse({ gap: 'x', seen: 1847, sectors: 'all', answer: 'none' })
        .success,
    ).toBe(true);
    expect(
      DemandLedgerEntrySchema.safeParse({ gap: 'x', seen: -1, sectors: ['retail'], answer: 'ours' })
        .success,
    ).toBe(false);
  });
});
