import { describe, expect, it } from 'vitest';
import { EvidenceSchema, type PassCapture, type StorageWrite } from '@gc/contracts';
import { captureToEvidence } from '@gc/scanner';

// A capture becomes evidence rows (T-08). Seen on www.dr.dk on 2026-09-08: a sandboxed
// frame writes to storage under the opaque origin "null", which is not a hostname, and
// the whole scan died on the contract. The write is evidence like any other; it is kept,
// attributed to the page, and labelled.

const SITE = 'https://shop.test/';
const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-08T09:00:00Z',
};

const write = (origin: string, key: string): StorageWrite => ({
  origin,
  area: 'local',
  key,
  value: '1',
  atMs: 120,
});

const capture = (storage: StorageWrite[]): PassCapture =>
  ({
    pass: 'A',
    url: SITE,
    finalUrl: SITE,
    status: 200,
    startedAt: identity.capturedAt,
    frames: [SITE],
    requests: [],
    cookies: [],
    storage,
    quiet: {
      minDwellMs: 800,
      quietMs: 400,
      maxWaitMs: 8_000,
      dwellMs: 1_000,
      lastRequestAtMs: 500,
      settled: true,
    },
  }) satisfies PassCapture;

describe('storage writes as evidence', () => {
  it('attributes a write from a frame with an opaque origin to the page, and says so', () => {
    const rows = captureToEvidence(
      capture([write('https://shop.test', 'cart'), write('null', '_cmp_seen')]),
      undefined,
      identity,
    );
    for (const r of rows) expect(EvidenceSchema.safeParse(r).success, r.caption).toBe(true);
    const storage = rows.filter((r) => r.kind === 'storage');
    expect(storage.map((r) => r.source.host)).toEqual(['shop.test', 'shop.test']);
    expect(storage[0]?.caption).toBe('localStorage cart on https://shop.test during pass A');
    expect(storage[1]?.caption).toBe(
      'localStorage _cmp_seen in a frame without an origin on shop.test during pass A',
    );
    // The body is the observation itself, origin "null" included, so the hash is honest.
    expect(storage[1]?.body).toContain('"origin":"null"');
  });
});
