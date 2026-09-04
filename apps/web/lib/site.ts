// The public origin of the site. Absolute addresses (canonical links, hreflang, the
// sitemap, the links in mail) are built from it; the build sets it for the pages that
// are generated ahead of a request.

export const DEFAULT_SITE_URL = 'http://localhost:3000';

export const siteUrl = (env: Record<string, string | undefined> = process.env): string =>
  (env['APP_BASE_URL'] ?? DEFAULT_SITE_URL).replace(/\/+$/, '');
