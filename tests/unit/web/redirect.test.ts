import { describe, expect, it } from 'vitest';
// The unit project has no '@/' alias; the module has no server-only imports, so a
// relative path is enough.
import { redirectTo } from '../../../apps/web/lib/redirect';

// Redirects never carry a host (U-02): Next's request.url names the server's own
// hostname, so an absolute location sends a visitor behind a proxy, or on another
// machine, to localhost.

describe('redirectTo', () => {
  it('drops the host and keeps path, query and fragment', () => {
    const url = new URL('http://localhost:3000/en/c/abc?asked=1#f-1');
    const r = redirectTo(url);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/en/c/abc?asked=1#f-1');
  });

  it('takes a path as it is and carries extra headers', () => {
    const r = redirectTo('/en?outcome=limited&retry=60', { 'retry-after': '60' });
    expect(r.headers.get('location')).toBe('/en?outcome=limited&retry=60');
    expect(r.headers.get('retry-after')).toBe('60');
  });
});
