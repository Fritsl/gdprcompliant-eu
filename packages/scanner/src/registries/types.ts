import type { OutboundFetch } from '@gc/config';
import type { CountryCode } from '@gc/contracts';

// Business registry adapters (D-03): one interface, one file per country. An adapter
// answers with what the register says about an entity, as the register says it, and
// says `unknown` for what the register does not carry; it never infers a headcount, a
// sector or a parent. Every adapter documents the register's terms and the pace it is
// allowed, and keeps that pace itself.

export interface RegistryQuery {
  readonly name?: string | undefined;
  readonly registryId?: string | undefined;
  readonly domain?: string | undefined;
}

export interface RegistryTerms {
  // Where the register states its terms of use.
  readonly url: string;
  // The licence or agreement the data comes under, in a sentence.
  readonly licence: string;
  // Attribution the terms ask for, verbatim, when they do.
  readonly attribution?: string;
  // The slowest pace the adapter keeps between calls, in milliseconds.
  readonly minIntervalMs: number;
  // Whether calls need credentials the deployment must hold.
  readonly credentials: boolean;
}

export interface RegistryEntity {
  readonly registry: string;
  readonly registryId: string;
  readonly legalName: string;
  readonly country: CountryCode;
  readonly status: 'active' | 'ceased' | 'unknown';
  readonly address?: string;
  readonly sector?: { readonly code: string; readonly label: string };
  // A band as the register gives it, or unknown. Never a guess.
  readonly headcountBand: string | 'unknown';
  readonly group: {
    readonly parent?: { readonly registryId?: string; readonly name: string };
    readonly ultimateParent?: { readonly registryId?: string; readonly name: string };
  };
  readonly source: { readonly url: string; readonly host: string; readonly fetchedAt: string };
  // The record as the register returned it, for the evidence row.
  readonly record: Record<string, unknown>;
}

export interface LookupContext {
  readonly fetch: OutboundFetch;
  readonly now?: () => Date;
  // Credentials the register needs, when it does; absent in a deployment without them.
  readonly credentials?: Readonly<Record<string, string>>;
}

export interface RegistryAdapter {
  readonly id: string;
  readonly country: CountryCode;
  readonly name: string;
  readonly host: string;
  readonly terms: RegistryTerms;
  // Which of the query's fields the register can search on.
  readonly searches: readonly ('name' | 'registryId' | 'domain')[];
  lookup(query: RegistryQuery, ctx: LookupContext): Promise<RegistryEntity | undefined>;
}

export class RegistryUnavailable extends Error {
  constructor(
    public readonly registry: string,
    message: string,
  ) {
    super(`${registry}: ${message}`);
    this.name = 'RegistryUnavailable';
  }
}

// The pace keeper every adapter shares: no two calls to one register closer than its
// terms allow, whatever the caller does.
export function paced(
  minIntervalMs: number,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
) {
  // Each call takes the next free slot when it arrives, so concurrent callers queue.
  let next = 0;
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + minIntervalMs;
    if (at > now) await sleep(at - now);
    return work();
  };
}
