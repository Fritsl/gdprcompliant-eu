import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';

// Crawlers get the public pages and the sitemap. Anything reached by a token (a case, a
// colleague's link, a summary link), the scan endpoint and the deletion receipt are
// kept out: they are not pages for anyone but their holder.

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/*/c/', '/*/m/', '/*/s/', '/*/scan', '/*/demand', '/*/deleted'],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
