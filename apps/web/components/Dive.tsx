import type { Locale } from '@gc/contracts';
import { diveable, stripFragment } from '@gc/corpus';
import { Text } from '@/components/Text';
import { t } from '@/lib/i18n';

// A dive point (V-05): one control that opens a conversation already scoped to the
// element it sits on, or appends to the conversation the element came from. Nothing to
// expand, or an element that already offers a specific next action, gets none.

export function Dive({
  base,
  locale,
  kind,
  refId,
  fragment,
  thread,
  hasAction,
}: {
  base: string;
  locale: Locale;
  kind: 'finding' | 'step' | 'article' | 'phrase' | 'cell' | 'answer';
  refId: string;
  fragment: string;
  thread?: string;
  hasAction?: boolean;
}) {
  if (!diveable(fragment, hasAction ? { hasAction } : {})) return null;
  return (
    <form
      method="post"
      action={`${base}/advisor/dive`}
      className="dive no-print"
      data-dive={kind}
      data-dive-ref={refId}
    >
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="ref" value={refId} />
      <input type="hidden" name="fragment" value={stripFragment(fragment)} />
      {thread ? <input type="hidden" name="thread" value={thread} /> : null}
      <button type="submit" className="link" data-dive-button="">
        <Text of={t(locale, 'dive.more')} />
      </button>
    </form>
  );
}
