import { recordEvalResult } from './record.js';
import { thresholdOf } from './sets.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@gc/config';
import { ModelClient, createModelReview, verifyClaim } from '@gc/agent';
import { documentChunks, loadCorpusDocuments } from '@gc/corpus';
import { POISONED_CLAIMS, STORED, TRUE_CLAIMS, poisonDeps } from './verifier-scenarios.js';

// Verifier eval (A-07, T-05): the labelled set, with the numbers reported so a change
// that moves them is visible. The mechanical stage runs everywhere. The model stage runs
// against the configured endpoint (the self-hosted one; needs MODEL_BASE_URL and its
// friends in the environment) and is skipped, loudly, when there is none.

const chunks = loadCorpusDocuments().flatMap(documentChunks);
const modelConfigured = Boolean(process.env['MODEL_BASE_URL'] && process.env['MODEL_CHAT']);

describe('verifier: mechanical stage', () => {
  it('accepts every true claim and rejects at least 98% of the poisoned set', async () => {
    const deps = poisonDeps(chunks);
    const accepted = [];
    for (const s of TRUE_CLAIMS) {
      const v = await verifyClaim(s.claim, deps);
      if (v.verdict === 'accepted') accepted.push(s.label);
      else console.log(`true claim rejected: ${s.label}: ${v.reason}`);
    }
    let rejected = 0;
    for (const s of POISONED_CLAIMS) {
      const v = await verifyClaim(s.claim, deps);
      if (v.verdict === 'rejected') rejected += 1;
      else console.log(`poisoned claim accepted: ${s.label}`);
    }
    console.log(
      `verifier eval (mechanical): true ${accepted.length}/${TRUE_CLAIMS.length} accepted; poisoned ${rejected}/${POISONED_CLAIMS.length} rejected`,
    );
    recordEvalResult({
      set: 'verifier',
      mode: 'pipeline',
      agreed: accepted.length + rejected,
      total: TRUE_CLAIMS.length + POISONED_CLAIMS.length,
      threshold: thresholdOf('verifier'),
    });
    expect(accepted).toHaveLength(TRUE_CLAIMS.length);
    expect(rejected / POISONED_CLAIMS.length).toBeGreaterThanOrEqual(thresholdOf('verifier'));
  });
});

describe.skipIf(!modelConfigured)('verifier: model second pass', () => {
  it('lets the true claims through and stops the unsupported ones', async () => {
    const config = loadConfig();
    const review = createModelReview(new ModelClient(config));
    const deps = poisonDeps(chunks, { review });
    // Claims that pass every mechanical check but whose evidence does not show what they say.
    const unsupported = [
      {
        ...TRUE_CLAIMS[0]!.claim,
        id: 'u-1',
        statement: 'No cookies are set on the reject-all pass.',
      },
      {
        ...TRUE_CLAIMS[1]!.claim,
        id: 'u-2',
        statement: 'No request leaves the site on the reject-all pass.',
      },
      {
        ...TRUE_CLAIMS[2]!.claim,
        id: 'u-3',
        statement: 'The newsletter consent box is unticked by default.',
      },
      {
        ...TRUE_CLAIMS[6]!.claim,
        id: 'u-4',
        statement: 'The policy names every recipient by name.',
      },
      {
        ...TRUE_CLAIMS[3]!.claim,
        id: 'u-5',
        statement: 'The policy names no contact address at all.',
      },
    ];
    let through = 0;
    for (const s of TRUE_CLAIMS)
      if ((await verifyClaim(s.claim, deps)).verdict === 'accepted') through += 1;
    let stopped = 0;
    for (const c of unsupported)
      if ((await verifyClaim(c, deps)).verdict === 'rejected') stopped += 1;
    console.log(
      `verifier eval (model): true ${through}/${TRUE_CLAIMS.length} through; unsupported ${stopped}/${unsupported.length} stopped; evidence bodies ${STORED.length}`,
    );
    expect(through / TRUE_CLAIMS.length).toBeGreaterThanOrEqual(0.8);
    expect(stopped / unsupported.length).toBeGreaterThanOrEqual(0.8);
  });
});

if (!modelConfigured) {
  console.log(
    'verifier eval: no MODEL_BASE_URL in the environment; the model second pass was not evaluated',
  );
}
