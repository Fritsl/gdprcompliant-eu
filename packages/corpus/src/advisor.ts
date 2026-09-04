import { ModelClient, advise, caseFacts, type CatalogueQuestion } from '@gc/agent';
import { loadConfig } from '@gc/config';
import type { Actor, Advice, Locale } from '@gc/contracts';
import { advisorCatalogue, caseFactsInput, recordAdvice, type Connection } from '@gc/db';
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

export interface AskAdvisorInput {
  readonly caseId: string;
  readonly question: string;
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
  const advice = await advise(input.stack.client, {
    question: input.question,
    locale,
    jurisdiction: record.jurisdiction,
    facts,
    retrieve: (q, jurisdiction, k) =>
      retrieve(connection, q, input.stack.embedder, { jurisdiction, k }),
    catalogue: input.catalogue ?? advisorCatalogue(locale),
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.stack.model ? { model: input.stack.model } : {}),
  });
  if (input.record !== false) {
    await recordAdvice(connection, tenantId, {
      caseId: input.caseId,
      advice,
      by: input.by,
      ...(input.now ? { now: input.now() } : {}),
    });
  }
  return advice;
}
