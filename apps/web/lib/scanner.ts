import { behaviourValues, fillBehaviour, loadBehaviour, type Behaviour } from '@gc/config';
import type { Locale } from '@gc/contracts';
import { localise } from '@gc/i18n';

// The scanner's published behaviour (D-11), as the page shows it: the content the
// scanner reads its own limits and identity from, with the numbers and names filled in
// from that same content. Nothing on the page is typed twice.

export interface ScannerBehaviourView {
  readonly version: string;
  readonly title: string;
  readonly lead: string;
  readonly userAgent: string;
  readonly header: string;
  readonly contact: string;
  readonly limits: Behaviour['limits'];
  readonly sections: readonly {
    readonly id: string;
    readonly heading: string;
    readonly body: string;
  }[];
}

export function scannerBehaviourView(locale: Locale): ScannerBehaviourView {
  const b = loadBehaviour();
  const values = behaviourValues(b);
  const pick = (x: Parameters<typeof localise>[0]) => localise(x, locale).value;
  return {
    version: b.version,
    title: pick(b.page.title),
    lead: pick(b.page.lead),
    userAgent: values['userAgent']!,
    header: values['header']!,
    contact: values['contact']!,
    limits: b.limits,
    sections: b.page.sections.map((s) => ({
      id: s.id,
      heading: pick(s.heading),
      body: fillBehaviour(pick(s.body), values),
    })),
  };
}
