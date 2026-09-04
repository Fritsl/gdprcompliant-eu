import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Text } from '@/components/Text';
import { ThemeToggle } from '@/components/ThemeToggle';
import { asLocale, localeCodes, locales, t } from '@/lib/i18n';
import { THEME_KEY } from '@/lib/theme';
import '../design-system.css';
import '../shell.css';

// Every page lives under a locale segment. The list of segments is content
// (packages/i18n/content/locales.json); an unknown one is a 404, not a fallback.

export const dynamicParams = false;

export function generateStaticParams() {
  return localeCodes.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const locale = asLocale((await params).locale);
  if (!locale) return {};
  return {
    title: t(locale, 'shell.name').text,
    description: t(locale, 'shell.tagline').text,
  };
}

// Applies the stored theme before first paint. Runs once, reads one key, touches one
// attribute; nothing else happens on the client until the toggle is used.
const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();`;

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const locale = asLocale((await params).locale);
  if (!locale) notFound();

  const name = t(locale, 'shell.name');
  return (
    <html lang={locale}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a className="skip" href="#content">
          <Text of={t(locale, 'shell.skip')} />
        </a>
        <header className="shell-header">
          <Link className="shell-brand" href={`/${locale}`}>
            <Text of={name} />
          </Link>
          <nav className="shell-locales" aria-label={t(locale, 'shell.language').text}>
            {locales.map((l) => (
              <Link
                key={l.code}
                href={`/${l.code}`}
                lang={l.code}
                hrefLang={l.code}
                aria-current={l.code === locale ? 'page' : undefined}
              >
                {l.name}
              </Link>
            ))}
          </nav>
          <ThemeToggle
            label={t(locale, 'shell.theme.label').text}
            options={{
              system: t(locale, 'shell.theme.system').text,
              light: t(locale, 'shell.theme.light').text,
              dark: t(locale, 'shell.theme.dark').text,
            }}
          />
        </header>
        <main id="content" className="shell-main">
          {children}
        </main>
        <footer className="shell-footer">
          <Text of={t(locale, 'shell.footer.operator')} as="p" />
          <Text of={t(locale, 'shell.footer.notCertification')} as="p" />
          <p>
            <a href={`/${locale}/ourselves`} data-ourselves="">
              <Text of={t(locale, 'shell.footer.ourselves')} />
            </a>
            {' · '}
            <a href={`/${locale}/scanner`} data-scanner-behaviour="">
              <Text of={t(locale, 'shell.footer.scanner')} />
            </a>
          </p>
        </footer>
      </body>
    </html>
  );
}
