import type { Translation } from '@/lib/i18n';

// Renders a translation. A string that fell back to English is marked in the markup —
// lang says what language it actually is, data-fallback lets a reviewer and the i18n
// coverage tooling see it — so the fallback is visible, never silent.

export function Text({
  of,
  as: Tag = 'span',
}: {
  of: Translation;
  as?: 'span' | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'li' | 'strong';
}) {
  if (!of.fellBack) return <Tag>{of.text}</Tag>;
  return (
    <Tag lang={of.lang} data-fallback="">
      {of.text}
    </Tag>
  );
}
