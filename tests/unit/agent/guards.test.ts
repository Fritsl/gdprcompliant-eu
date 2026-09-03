import { describe, expect, it } from 'vitest';
import { sha256, type Evidence, type UntrustedContent } from '@gc/contracts';
import { OUTPUT_GUARDS, collectUntrusted, guardOutput, withinSite } from '@gc/agent';

// Output guards (A-10): an answer stays inside what the call was given. The adversarial
// suite proves the guards refuse the planted instructions; this proves they let an honest
// answer through, and that scraped material is found wherever it sits in an input.

const evidence: Evidence = {
  id: 'ev-1',
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  kind: 'cookie',
  capturedAt: '2026-09-04T09:14:00Z',
  source: { host: 'shop.test' },
  body: '_ga on .shop.test, 2 years',
  hash: sha256('_ga on .shop.test, 2 years'),
};

describe('guards let an honest answer through', () => {
  it('classify_cookies: observed cookies only', () => {
    const input = { cookies: [{ name: '_ga', host: 'shop.test' }] };
    expect(
      guardOutput('classify_cookies', input, {
        cookies: [{ name: '_ga', host: 'shop.test', category: 'analytics', confidence: 0.9 }],
      }),
    ).toEqual([]);
    expect(
      guardOutput('classify_cookies', input, {
        cookies: [{ name: '_gid', host: 'shop.test', category: 'analytics', confidence: 0.9 }],
      }),
    ).toEqual(['cookies[0]: _gid on shop.test was not observed']);
  });

  it('answer_question: grounded rows and the law come from what was offered', () => {
    const input = {
      question: 'q',
      locale: 'en' as const,
      grounding: [{ label: 'Cookies', value: '3 before consent' }],
      passages: [
        {
          key: 'ePrivacy:5:3',
          ref: 'Art. 5(3)',
          text: 'the storing of  information, or the gaining of access',
        },
      ],
      untrusted: [],
    };
    const ok = {
      answer: 'Three cookies are set before consent.',
      grounded: [{ label: 'Cookies', value: '3 before consent' }],
      law: { key: 'ePrivacy:5:3', quote: 'the storing of information' },
      followups: [],
    };
    expect(guardOutput('answer_question', input, ok)).toEqual([]);
    expect(
      guardOutput('answer_question', input, {
        ...ok,
        law: { key: 'ePrivacy:5:3', quote: 'storing is fine' },
      }),
    ).toEqual(['law.quote is not in ePrivacy:5:3 as offered']);
  });

  it('analyse_policy_clauses: a present clause is quoted from the document', () => {
    const document: UntrustedContent = {
      trust: 'untrusted',
      source: { description: 'policy', fetchedAt: '2026-09-04T09:14:00Z' },
      mediaType: 'text/plain',
      hash: sha256('We keep order data for five years.'),
      text: 'We keep order data for five years.',
    };
    const input = {
      document,
      elements: ['retention period'],
      jurisdiction: 'DK' as const,
      locale: 'en' as const,
    };
    expect(
      guardOutput('analyse_policy_clauses', input, {
        clauses: [{ element: 'retention period', status: 'present', quote: 'five years' }],
      }),
    ).toEqual([]);
    expect(
      guardOutput('analyse_policy_clauses', input, {
        clauses: [{ element: 'retention period', status: 'absent' }],
      }),
    ).toEqual([]);
  });

  it('review_claim has no guard of its own; the verifier is the guard', () => {
    expect(OUTPUT_GUARDS.review_claim).toBeUndefined();
  });

  it('withinSite accepts the domain and its subdomains only', () => {
    expect(withinSite('shop.test', 'shop.test')).toBe(true);
    expect(withinSite('cdn.shop.test', 'shop.test')).toBe(true);
    expect(withinSite('notshop.test', 'shop.test')).toBe(false);
    expect(withinSite('shop.test.evil.example', 'shop.test')).toBe(false);
  });
});

describe('scraped material is found wherever it sits', () => {
  it('collects untrusted content and evidence from nested input, once each', () => {
    const doc: UntrustedContent = {
      trust: 'untrusted',
      source: { description: 'page', fetchedAt: '2026-09-04T09:14:00Z' },
      mediaType: 'text/html',
      hash: sha256('<p>hi</p>'),
      text: '<p>hi</p>',
    };
    const found = collectUntrusted({
      a: { b: [doc, { c: doc }] },
      finding: { evidence: [{ evidenceId: 'ev-1', hash: evidence.hash }] },
      evidence: [evidence, evidence],
    });
    expect(found.untrusted).toEqual([doc]);
    expect(found.evidence).toEqual([evidence]);
  });
});
