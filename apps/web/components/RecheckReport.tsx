'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

// What the re-check found (U-04): followed on the job's event stream until it has an
// outcome, then said as it is. When it lands, the page re-renders in place so the
// finding's badge follows.

export type RecheckLabels = Readonly<
  Record<'running' | 'closed' | 'open' | 'regressed' | 'unverifiable' | 'unreachable', string>
>;

interface Report {
  readonly state: string;
  readonly progress?:
    | { readonly outcome?: keyof RecheckLabels | undefined; readonly detail?: string | undefined }
    | undefined;
}

const settledReport = (r: Report | undefined): boolean =>
  r?.progress?.outcome !== undefined || r?.state === 'failed' || r?.state === 'cancelled';

export function RecheckReport({
  url,
  labels,
  initial,
  referral,
}: {
  url: string;
  labels: RecheckLabels;
  initial?: Report;
  // The ask (L-04): shown with the confirmation that the fix closed the finding.
  referral?: { prompt: string; link: string } | undefined;
}) {
  const router = useRouter();
  const [report, setReport] = useState<Report | undefined>(initial);
  const settled = settledReport(report);

  useEffect(() => {
    if (settled) return;
    const source = new EventSource(url);
    const apply = (e: MessageEvent) => {
      const next = JSON.parse(e.data) as Report;
      setReport(next);
      if (settledReport(next)) {
        source.close();
        router.refresh();
      }
    };
    source.addEventListener('progress', apply);
    source.addEventListener('done', apply);
    source.addEventListener('gone', () => {
      source.close();
      setReport({ state: 'failed' });
    });
    return () => source.close();
  }, [url, settled, router]);

  const outcome = report?.progress?.outcome;
  const failed = report?.state === 'failed' || report?.state === 'cancelled';
  const key: keyof RecheckLabels = outcome ?? (failed ? 'unreachable' : 'running');
  return (
    <p role="status" className="step-meta" data-recheck={key}>
      {labels[key]}
      {key === 'closed' && referral ? (
        <span className="referral" data-referral="">
          {' '}
          {referral.prompt} <a href={referral.link}>{referral.link}</a>
        </span>
      ) : null}
      {report?.progress?.detail && (key === 'unverifiable' || key === 'unreachable') ? (
        <> · {report.progress.detail}</>
      ) : null}
    </p>
  );
}
