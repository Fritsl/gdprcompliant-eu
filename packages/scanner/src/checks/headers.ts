// Pure evaluations of what response headers say. Kept free of I/O so they are unit-testable.

export type Headers = Record<string, string>;

export const lower = (headers: Record<string, string | undefined>): Headers =>
  Object.fromEntries(
    Object.entries(headers)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([k, v]) => [k.toLowerCase(), v]),
  );

export interface HstsVerdict {
  present: boolean;
  maxAge?: number;
  includeSubDomains?: boolean;
  // A year is the floor most guidance uses; a short max-age is a header that will lapse.
  adequate: boolean;
}

export function evaluateHsts(headers: Headers): HstsVerdict {
  const value = headers['strict-transport-security'];
  if (!value) return { present: false, adequate: false };
  const maxAge = Number(/max-age\s*=\s*(\d+)/i.exec(value)?.[1] ?? NaN);
  const includeSubDomains = /includesubdomains/i.test(value);
  return {
    present: true,
    ...(Number.isFinite(maxAge) ? { maxAge } : {}),
    includeSubDomains,
    adequate: Number.isFinite(maxAge) && maxAge >= 31_536_000,
  };
}

// Referrer policies that keep the path and query at home when leaving the origin.
const SAFE_REFERRER = new Set([
  'no-referrer',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'origin',
  'origin-when-cross-origin',
]);

export interface ReferrerVerdict {
  policy?: string;
  // true when the effective policy would send the full URL to another origin.
  leaks: boolean;
}

export function evaluateReferrerPolicy(headers: Headers, metaPolicy?: string): ReferrerVerdict {
  const raw = headers['referrer-policy'] ?? metaPolicy;
  if (!raw) return { leaks: true };
  // A comma-separated list: the last recognised token wins.
  const tokens = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const policy = [...tokens]
    .reverse()
    .find((t) => SAFE_REFERRER.has(t) || t === 'unsafe-url' || t === 'no-referrer-when-downgrade');
  if (!policy) return { policy: raw, leaks: true };
  return { policy, leaks: !SAFE_REFERRER.has(policy) };
}

export interface HeaderVerdict {
  missing: string[];
  present: Record<string, string>;
}

// The headers a stranger can check for, and that a config change supplies.
export const EXPECTED_HEADERS: readonly {
  name: string;
  satisfiedBy?: (headers: Headers) => boolean;
}[] = [
  { name: 'content-security-policy' },
  {
    name: 'x-content-type-options',
    satisfiedBy: (h) => /nosniff/i.test(h['x-content-type-options'] ?? ''),
  },
  {
    name: 'x-frame-options',
    satisfiedBy: (h) =>
      h['x-frame-options'] !== undefined ||
      /frame-ancestors/i.test(h['content-security-policy'] ?? ''),
  },
];

export function evaluateSecurityHeaders(headers: Headers): HeaderVerdict {
  const missing: string[] = [];
  const present: Record<string, string> = {};
  for (const h of EXPECTED_HEADERS) {
    const ok = h.satisfiedBy ? h.satisfiedBy(headers) : headers[h.name] !== undefined;
    if (ok) present[h.name] = headers[h.name] ?? '(via content-security-policy)';
    else missing.push(h.name);
  }
  return { missing, present };
}
