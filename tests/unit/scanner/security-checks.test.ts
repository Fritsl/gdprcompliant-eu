import { describe, expect, it } from 'vitest';
import { SECURITY_CHECKS, SecurityObservationSchema } from '@gc/contracts';
import { loadCatalogue } from '@gc/remedies';
import {
  EXPOSED_PATHS,
  evaluateHsts,
  evaluateReferrerPolicy,
  evaluateSecurityHeaders,
  robotsDisallows,
} from '@gc/scanner';

describe('the security checks map to findings with remedies (S-12)', () => {
  it('every check maps to a finding type that has a concrete config-change remedy', () => {
    const catalogue = loadCatalogue();
    for (const [check, typeId] of Object.entries(SECURITY_CHECKS)) {
      const remedies = catalogue.forFinding(typeId, 'DK');
      expect(remedies.length, `${check} → ${typeId}`).toBeGreaterThan(0);
      const remedy = remedies[0]!.remedy;
      expect(remedy.kind).toBe('self_fix');
      if (remedy.kind === 'self_fix')
        expect(remedy.snippet).toMatch(/nginx|<script|add_header|location/);
    }
  });

  it('an observation cannot fail without evidence, or map a check to the wrong finding', () => {
    const ref = { evidenceId: 'header:abc', hash: 'a'.repeat(64) };
    expect(
      SecurityObservationSchema.safeParse({
        check: 'hsts',
        findingTypeId: 'SEC-03',
        outcome: 'fail',
        summary: 'x',
        evidence: [ref],
      }).success,
    ).toBe(true);
    expect(
      SecurityObservationSchema.safeParse({
        check: 'hsts',
        findingTypeId: 'SEC-03',
        outcome: 'fail',
        summary: 'x',
      }).success,
    ).toBe(false);
    expect(
      SecurityObservationSchema.safeParse({
        check: 'hsts',
        findingTypeId: 'SEC-02',
        outcome: 'pass',
        summary: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('header evaluation (S-12)', () => {
  it('HSTS needs a year', () => {
    expect(evaluateHsts({})).toEqual({ present: false, adequate: false });
    expect(evaluateHsts({ 'strict-transport-security': 'max-age=300' })).toMatchObject({
      present: true,
      maxAge: 300,
      adequate: false,
    });
    expect(
      evaluateHsts({ 'strict-transport-security': 'max-age=63072000; includeSubDomains' }),
    ).toEqual({
      present: true,
      maxAge: 63_072_000,
      includeSubDomains: true,
      adequate: true,
    });
  });

  it('referrer policy: missing or permissive leaks, the strict ones do not', () => {
    expect(evaluateReferrerPolicy({})).toEqual({ leaks: true });
    expect(evaluateReferrerPolicy({ 'referrer-policy': 'unsafe-url' })).toEqual({
      policy: 'unsafe-url',
      leaks: true,
    });
    expect(evaluateReferrerPolicy({ 'referrer-policy': 'no-referrer-when-downgrade' }).leaks).toBe(
      true,
    );
    expect(
      evaluateReferrerPolicy({ 'referrer-policy': 'strict-origin-when-cross-origin' }).leaks,
    ).toBe(false);
    expect(evaluateReferrerPolicy({}, 'same-origin').leaks).toBe(false);
    // The last recognised token wins.
    expect(evaluateReferrerPolicy({ 'referrer-policy': 'unsafe-url, strict-origin' })).toEqual({
      policy: 'strict-origin',
      leaks: false,
    });
    expect(evaluateReferrerPolicy({ 'referrer-policy': 'nonsense' })).toEqual({
      policy: 'nonsense',
      leaks: true,
    });
  });

  it('security headers: CSP, nosniff, and framing by header or policy', () => {
    expect(evaluateSecurityHeaders({}).missing).toEqual([
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
    ]);
    expect(
      evaluateSecurityHeaders({
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
      }).missing,
    ).toEqual([]);
    expect(
      evaluateSecurityHeaders({ 'x-content-type-options': 'sniff-away', 'x-frame-options': 'DENY' })
        .missing,
    ).toEqual(['content-security-policy', 'x-content-type-options']);
  });
});

describe('exposed-path probing stays within the rules (S-12)', () => {
  it('is a fixed, short list of GET-only paths with no query and a shape test each', () => {
    expect(EXPOSED_PATHS).toHaveLength(12);
    for (const p of EXPOSED_PATHS) {
      expect(p.path).toMatch(/^\/[^?#\s]*$/);
      expect(typeof p.matches).toBe('function');
      expect(p.looksLike.length).toBeGreaterThan(3);
    }
    expect(
      EXPOSED_PATHS.find((p) => p.path === '/.env')!.matches('APP_KEY=abc\n', 'text/plain'),
    ).toBe(true);
    expect(
      EXPOSED_PATHS.find((p) => p.path === '/.env')!.matches('<html>home</html>', 'text/html'),
    ).toBe(false);
    expect(
      EXPOSED_PATHS.find((p) => p.path === '/.git/HEAD')!.matches(
        'ref: refs/heads/main\n',
        'text/plain',
      ),
    ).toBe(true);
    expect(
      EXPOSED_PATHS.find((p) => p.path === '/backup.zip')!.matches('PK', 'application/zip'),
    ).toBe(true);
    expect(
      EXPOSED_PATHS.find((p) => p.path === '/backup.zip')!.matches('<html>', 'text/html'),
    ).toBe(false);
  });

  it('honours robots.txt for everyone and for us by name, with the longest rule winning', () => {
    const robots =
      'User-agent: *\nDisallow: /.env.local\nDisallow: /private/\nAllow: /private/public/\n\nUser-agent: GDPRcompliant-scanner\nDisallow: /.git/\n';
    expect(robotsDisallows(robots, '/.git/HEAD')).toBe(true);
    expect(robotsDisallows(robots, '/.env.local')).toBe(false);
    expect(robotsDisallows(robots, '/.env.local', 'otherbot')).toBe(true);
    expect(robotsDisallows(robots, '/private/backup.zip', 'otherbot')).toBe(true);
    expect(robotsDisallows(robots, '/private/public/x', 'otherbot')).toBe(false);
    expect(robotsDisallows('', '/.env')).toBe(false);
    expect(robotsDisallows('User-agent: *\nDisallow:\n', '/.env')).toBe(false);
  });
});
