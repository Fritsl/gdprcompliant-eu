import { createHash } from 'node:crypto';

// Content addressing. Evidence rows are immutable and named by the hash of their body
// (F-03); the remedy catalogue lock hashes entries the same way (R-01). One definition,
// so two packages can never disagree about what a hash covers.

// Canonical JSON: keys sorted at every level, undefined dropped, no whitespace.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

// The hash of a structured value, over its canonical form.
export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
