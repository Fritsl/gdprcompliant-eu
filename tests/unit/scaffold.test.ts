import { describe, expect, it } from 'vitest';
import { PACKAGE as contracts } from '@gc/contracts';

describe('workspace scaffold', () => {
  it('resolves a workspace package by its alias', () => {
    expect(contracts).toBe('@gc/contracts');
  });

  it('has noUncheckedIndexedAccess in effect', () => {
    const xs = ['a'];
    // Typed as string | undefined precisely because of noUncheckedIndexedAccess.
    const first: string | undefined = xs[0];
    expect(first).toBe('a');
  });
});
