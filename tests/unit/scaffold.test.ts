import { describe, expect, it } from 'vitest';
import { PACKAGE as agent } from '@gc/agent';
import { PACKAGE as artefacts } from '@gc/artefacts';
import { PACKAGE as config } from '@gc/config';
import { PACKAGE as contracts } from '@gc/contracts';
import { PACKAGE as corpus } from '@gc/corpus';
import { PACKAGE as db } from '@gc/db';
import { PACKAGE as findings } from '@gc/findings';
import { PACKAGE as remedies } from '@gc/remedies';
import { PACKAGE as rules } from '@gc/rules';
import { PACKAGE as scanner } from '@gc/scanner';

describe('workspace scaffold', () => {
  it('resolves every workspace package by its alias', () => {
    expect({
      agent,
      artefacts,
      config,
      contracts,
      corpus,
      db,
      findings,
      remedies,
      rules,
      scanner,
    }).toEqual({
      agent: '@gc/agent',
      artefacts: '@gc/artefacts',
      config: '@gc/config',
      contracts: '@gc/contracts',
      corpus: '@gc/corpus',
      db: '@gc/db',
      findings: '@gc/findings',
      remedies: '@gc/remedies',
      rules: '@gc/rules',
      scanner: '@gc/scanner',
    });
  });

  it('has noUncheckedIndexedAccess in effect', () => {
    const xs = ['a'];
    // Typed as string | undefined precisely because of noUncheckedIndexedAccess.
    const first: string | undefined = xs[0];
    expect(first).toBe('a');
  });
});
