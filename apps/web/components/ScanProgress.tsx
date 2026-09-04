'use client';

import { useEffect, useState } from 'react';

// The scan, live (U-02). Server-rendered with what the worker has marked so far, then
// kept current from the event stream. Every row is a real stage with the worker's own
// mark on it; there is no percentage because there is nothing honest to compute one
// from.

export interface StageRow {
  readonly stage: string;
  readonly label: string;
  readonly mark: 'todo' | 'on' | 'ok' | 'undet' | 'na' | 'skip' | 'fail';
  readonly detail?: string;
}

export interface ScanState {
  readonly rows: readonly StageRow[];
  readonly done: boolean;
  readonly outcome?: string;
  readonly caseToken?: string;
}

export interface ScanProgressProps {
  readonly initial: ScanState;
  readonly eventsUrl: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly marks: Readonly<Record<string, string>>;
  readonly outcomes: Readonly<Record<string, { heading: string; body: string; cta: string }>>;
  // The case route prefix; the token is appended.
  readonly casePath: string;
  readonly frontHref: string;
}

interface WireView {
  readonly done: boolean;
  readonly progress: {
    readonly stages: readonly { stage: string; mark: string; detail?: string }[];
    readonly outcome?: string;
    readonly caseToken?: string;
  };
}

export function ScanProgress(props: ScanProgressProps) {
  const [state, setState] = useState<ScanState>(props.initial);

  useEffect(() => {
    if (state.done) return;
    const source = new EventSource(props.eventsUrl);
    const apply = (e: MessageEvent) => {
      const view = JSON.parse(e.data) as WireView;
      const byStage = new Map(view.progress.stages.map((s) => [s.stage, s]));
      setState({
        rows: props.initial.rows.map((r) => {
          const s = byStage.get(r.stage);
          return s
            ? { ...r, mark: s.mark as StageRow['mark'], ...(s.detail ? { detail: s.detail } : {}) }
            : { ...r, mark: 'todo' };
        }),
        done: view.done,
        ...(view.progress.outcome ? { outcome: view.progress.outcome } : {}),
        ...(view.progress.caseToken ? { caseToken: view.progress.caseToken } : {}),
      });
    };
    source.addEventListener('progress', apply);
    source.addEventListener('done', (e) => {
      apply(e as MessageEvent);
      source.close();
    });
    source.addEventListener('gone', () => source.close());
    source.onerror = () => source.close();
    return () => source.close();
    // The stream is opened once per scan; the initial rows never change identity.
  }, [props.eventsUrl]);

  const outcome = state.done && state.outcome ? props.outcomes[state.outcome] : undefined;
  return (
    <div>
      <div
        className="scan-steps"
        role="list"
        aria-live="polite"
        data-done={state.done ? '' : undefined}
      >
        {state.rows.map((r) => (
          <div key={r.stage} className={`scan-step ${r.mark}`} role="listitem" data-stage={r.stage}>
            <span className="dot" />
            <span className="t">{r.label}</span>
            <span className="n">
              {r.mark === 'todo' || r.mark === 'on' ? '' : (props.marks[r.mark] ?? r.mark)}
            </span>
          </div>
        ))}
      </div>
      {outcome ? (
        <div
          className={`scan-out${state.outcome === 'no_banner_needed' ? ' good' : ''}`}
          data-outcome={state.outcome}
        >
          <h3>{outcome.heading}</h3>
          <p>{outcome.body}</p>
          {state.caseToken ? (
            <a className="btn" href={`${props.casePath}${state.caseToken}`}>
              {outcome.cta}
            </a>
          ) : (
            <a className="btn" href={props.frontHref}>
              {outcome.cta}
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
}
