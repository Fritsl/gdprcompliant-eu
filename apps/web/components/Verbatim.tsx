import type { Citation, Jurisdiction, Locale } from '@gc/contracts';
import { excerptOf, verbatim } from '@gc/contracts';
import { corpusChunks, quotation } from '@gc/corpus';
import { Text } from '@/components/Text';
import { t } from '@/lib/i18n';

// A paragraph of law, word for word (V-03). The text is fetched here by its citation,
// from the corpus and from nowhere else: the component takes no text, so nothing that
// writes prose can put words in the law's mouth. What is about to be shown is checked
// against the entry character for character; a shortened, dotted or annotated
// quotation stops the page. A span quoted from the paragraph is marked inside the
// whole, never shown instead of it. Every quotation says which instrument, article and
// paragraph it is, the date the text speaks from, and the corpus version it came from.

export function Verbatim({
  cite,
  jurisdiction,
  corpusVersion,
  mark,
  locale,
}: {
  cite: Citation;
  jurisdiction: Jurisdiction;
  corpusVersion?: string;
  mark?: string;
  locale: Locale;
}) {
  const r = quotation(corpusChunks(), cite, jurisdiction, corpusVersion ? { corpusVersion } : {});
  if (!r.ok) throw new Error(`law does not resolve: ${r.detail}`);
  const q = r.quotation;
  const check = verbatim(q.text, q);
  if (!check.ok) throw new Error(`law is not verbatim: ${check.detail}`);
  let body: React.ReactNode = q.text;
  if (mark !== undefined) {
    const e = excerptOf(q, mark);
    if (!e.ok) throw new Error(`quoted span is not verbatim: ${e.detail}`);
    body = (
      <>
        {q.text.slice(0, e.start)}
        <mark>{q.text.slice(e.start, e.end)}</mark>
        {q.text.slice(e.end)}
      </>
    );
  }
  return (
    <blockquote
      className="verbatim"
      cite={q.source.url}
      data-verbatim={q.key}
      data-corpus-version={q.corpusVersion}
      data-text-as-of={q.textAsOf}
    >
      <p>{body}</p>
      <footer>
        <strong>{q.ref}</strong>
        {' · '}
        <Text of={t(locale, 'law.asOf')} /> {q.textAsOf}
        {' · '}
        <Text of={t(locale, 'law.version')} /> {q.corpusVersion}
        {' · '}
        <a href={q.source.url} rel="noopener">
          <Text of={t(locale, 'law.source')} />
        </a>
      </footer>
    </blockquote>
  );
}
