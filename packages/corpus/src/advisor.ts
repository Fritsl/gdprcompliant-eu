import {
  ModelClient,
  advise,
  caseFacts,
  diveQuestion,
  stripFragment,
  tellMeMore,
  type CatalogueQuestion,
} from '@gc/agent';
export { diveable, stripFragment, tellMeMore, DIVE_MAX_CHARS } from '@gc/agent';
import { loadConfig } from '@gc/config';
import type { Actor, Advice, DiveOrigin, Locale } from '@gc/contracts';
import {
  advisorCatalogue,
  caseFactsInput,
  newThreadId,
  recordAdvice,
  recordDive,
  threadOf,
  type Connection,
} from '@gc/db';
import { createModelEmbedder, type Embedder } from './embed.js';
import { retrieve } from './store.js';

// The advisor (V-02) end to end: the facts of the case from the graph, the passages of
// law from the corpus (Union law and the case's own jurisdiction, nothing else), the
// model's answer held to both by the guard, and the answer recorded on the case so the
// report can carry it. The model is the configured one, the self-hosted stack in
// production; without one the advisor is unavailable and says so.

export interface AdvisorStack {
  readonly client: Pick<ModelClient, 'call'>;
  readonly embedder: Embedder;
  readonly model?: string;
}

export function advisorStack(
  env: Record<string, string | undefined> = process.env,
): AdvisorStack | undefined {
  if (!env['MODEL_BASE_URL']) return undefined;
  const config = loadConfig(env);
  const client = new ModelClient(config);
  return { client, embedder: createModelEmbedder(client), model: config.model.chat };
}

export interface DiveInput {
  readonly origin: DiveOrigin;
  // The element's text as the page showed it; stripped and capped here.
  readonly fragment: string;
  // Where the fragment came from, for the fence label: "finding DPA-01", "GDPR Art. 28(3)".
  readonly source: string;
}

export interface AskAdvisorInput {
  readonly caseId: string;
  // The question typed; absent for a dive, whose question is the fragment.
  readonly question?: string;
  // A dive (V-05) seeds turn zero with the fragment; further dives append.
  readonly dive?: DiveInput;
  // Continue this conversation; otherwise a new one starts.
  readonly thread?: string;
  readonly by: Actor;
  readonly stack: AdvisorStack;
  readonly locale?: Locale;
  readonly catalogue?: readonly CatalogueQuestion[];
  readonly k?: number;
  readonly now?: () => Date;
  readonly record?: boolean;
}

export async function askAdvisor(
  connection: Connection,
  tenantId: string,
  input: AskAdvisorInput,
): Promise<Advice> {
  const record = await caseFactsInput(connection, tenantId, input.caseId);
  const locale = input.locale ?? record.locale;
  const facts = caseFacts(record);
  const now = input.now ?? (() => new Date());
  const prior = input.thread
    ? await threadOf(connection, tenantId, input.caseId, input.thread)
    : [];
  const thread = { id: input.thread ?? newThreadId(input.caseId), turn: prior.length };
  if (!input.dive && !input.question) throw new Error('a question or a dive');
  const fragment = input.dive ? stripFragment(input.dive.fragment) : undefined;
  if (input.dive && !fragment) throw new Error('a dive needs a fragment with something in it');
  const question = input.dive ? diveQuestion(locale, input.dive.fragment).prefix : input.question!;
  if (input.dive && fragment && input.record !== false) {
    await recordDive(connection, tenantId, {
      caseId: input.caseId,
      threadId: thread.id,
      turn: thread.turn,
      origin: input.dive.origin,
      fragment,
      by: input.by,
      now: now(),
    });
  }
  // Earlier turns as the model may see them: a dive's fragment is quoted material and
  // stays out of the prose, so a dive turn is shown by its prefix alone.
  const history = prior.map((a) => ({
    question: a.dive
      ? `${tellMeMore(locale)} (${a.dive.origin.kind} ${a.dive.origin.ref})`
      : a.question,
    answer: a.answer,
  }));
  const advice = await advise(input.stack.client, {
    question,
    ...(input.dive && fragment ? { quoted: { text: fragment, source: input.dive.source } } : {}),
    history,
    thread,
    ...(input.dive && fragment ? { dive: { origin: input.dive.origin, fragment } } : {}),
    locale,
    jurisdiction: record.jurisdiction,
    facts,
    retrieve: (q, jurisdiction, k) =>
      retrieve(connection, q, input.stack.embedder, { jurisdiction, k }),
    catalogue: input.catalogue ?? advisorCatalogue(locale),
    ...(input.k !== undefined ? { k: input.k } : {}),
    now,
    ...(input.stack.model ? { model: input.stack.model } : {}),
  });
  if (input.record !== false) {
    await recordAdvice(connection, tenantId, {
      caseId: input.caseId,
      advice,
      by: input.by,
      now: now(),
    });
  }
  return advice;
}
