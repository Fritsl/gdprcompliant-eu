import { createHash } from 'node:crypto';

// Canonical JSON: keys sorted at every level, no whitespace. The same function, in plain
// JavaScript, lives in scripts/remedy-lock.mjs; the two must agree byte for byte, and the
// lock test proves they do.
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

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
