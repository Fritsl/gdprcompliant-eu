import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CASE_EVENT_TYPES,
  CASE_STAGES,
  LocalisedTextSchema,
  type CaseEvent,
  type CaseStage,
  type Locale,
} from '@gc/contracts';
import { localise } from '@gc/i18n';
import { disclaimerText } from './disclaimer.js';

// The timeline as a record a person reads (C-02): every event dated, attributed and
// described in the case's language. The wording is content, one entry per event type,
// and a type without an entry fails the completeness test rather than rendering blank.

const EntrySchema = z.object({ text: LocalisedTextSchema, detail: LocalisedTextSchema });
const ContentSchema = z.object({
  actors: z.object({
    scanner: LocalisedTextSchema,
    watcher: LocalisedTextSchema,
    system: LocalisedTextSchema,
    agent: LocalisedTextSchema,
  }),
  events: z.record(z.string(), EntrySchema),
});

// From the module path, not new URL(..., import.meta.url): a bundler treats the latter
// as an asset, and the content is read at runtime.
export const TIMELINE_CONTENT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
  'timeline.json',
);

export const TIMELINE_CONTENT = ContentSchema.parse(
  JSON.parse(readFileSync(TIMELINE_CONTENT_FILE, 'utf8')),
);

// Every event type has wording, and there is no wording for a type that does not exist.
export function timelineContentGaps(): { missing: string[]; unknown: string[] } {
  const known = new Set<string>(CASE_EVENT_TYPES);
  const have = new Set(Object.keys(TIMELINE_CONTENT.events));
  return {
    missing: [...known].filter((t) => !have.has(t)),
    unknown: [...have].filter((t) => !known.has(t)),
  };
}

export interface TimelineEntry {
  readonly seq: number;
  readonly at: string;
  // The date and time as a person in the case's locale reads it.
  readonly when: string;
  readonly actor: string;
  readonly actorKind: CaseEvent['actor']['kind'];
  readonly type: CaseEvent['type'];
  readonly text: string;
  readonly detail: string;
  // A finding closed: the entry the prototype ticks.
  readonly closed: boolean;
  // The case's stage after this event.
  readonly state: CaseStage;
  readonly fellBack: boolean;
}

export interface TimelineModel {
  readonly caseId: string;
  readonly locale: Locale;
  readonly entries: readonly TimelineEntry[];
  readonly disclaimer: string;
}

export interface TimelineOptions {
  readonly locale: Locale;
  readonly timeZone?: string;
}

const fill = (template: string, values: Record<string, unknown>): string =>
  template
    .replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key: string) => {
      const v = values[key];
      return v === undefined || v === null ? '' : String(v);
    })
    .replace(/\s+·\s*$/, '')
    .replace(/^\s*·\s+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

function stageAfter(previous: CaseStage, type: CaseEvent['type']): CaseStage {
  const rank = (s: CaseStage) => CASE_STAGES.indexOf(s);
  const next: CaseStage | undefined = {
    scan_completed: 'assessed',
    finding_closed: 'working',
    colleague_joined: 'working',
    question_answered: 'working',
    artefact_published: 'documented',
    watch_run: 'watched',
  }[type as string] as CaseStage | undefined;
  return next && rank(next) > rank(previous) ? next : previous;
}

function actorLabel(
  actor: CaseEvent['actor'],
  locale: Locale,
): { label: string; fellBack: boolean } {
  if (actor.kind === 'person') return { label: actor.name, fellBack: false };
  if (actor.kind === 'agent') {
    const l = localise(TIMELINE_CONTENT.actors.agent, locale);
    return { label: `${l.value}${actor.model ? ` (${actor.model})` : ''}`, fellBack: l.fellBack };
  }
  const l = localise(TIMELINE_CONTENT.actors[actor.kind], locale);
  return { label: l.value, fellBack: l.fellBack };
}

export function timelineModel(
  caseId: string,
  events: readonly CaseEvent[],
  options: TimelineOptions,
): TimelineModel {
  const { locale } = options;
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: options.timeZone ?? 'Europe/Copenhagen',
  });
  let state: CaseStage = 'opened';
  const entries = [...events]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => {
      const content = TIMELINE_CONTENT.events[e.type];
      if (!content) throw new Error(`no timeline wording for ${e.type}`);
      const text = localise(content.text, locale);
      const detail = localise(content.detail, locale);
      const actor = actorLabel(e.actor, locale);
      state = stageAfter(state, e.type);
      return {
        seq: e.seq,
        at: e.at,
        when: format.format(new Date(e.at)),
        actor: actor.label,
        actorKind: e.actor.kind,
        type: e.type,
        text: fill(text.value, e.payload),
        detail: fill(detail.value, e.payload),
        closed: e.type === 'finding_closed',
        state,
        fellBack: text.fellBack || detail.fellBack || actor.fellBack,
      };
    });
  return { caseId, locale, entries, disclaimer: disclaimerText(locale) };
}
