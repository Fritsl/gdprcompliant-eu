import { DIVE_ORIGINS, type Advice, type DiveOrigin, type Locale } from '@gc/contracts';
import { advisorStack, askAdvisor, diveable, stripFragment } from '@gc/corpus';
import { adviceOf, caseByToken, threadOf } from '@gc/db';
import { holder, withConnection } from '@/lib/case';

// The advisor (V-02) for one case: what has been asked and answered, and one more
// question posted by the holder, answered from the case and the law and recorded on the
// timeline so the report carries it.

export interface AdvisorView {
  readonly caseId: string;
  readonly advice: readonly Advice[];
  readonly available: boolean;
  // The conversation shown, when one is; otherwise every answer on the case.
  readonly thread?: string;
}

export const QUESTION_MIN = 5;
export const QUESTION_MAX = 500;

export async function loadAdvisor(
  token: string,
  thread?: string,
): Promise<AdvisorView | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const advice = thread
      ? await threadOf(connection, found.tenantId, found.caseId, thread)
      : await adviceOf(connection, found.tenantId, found.caseId);
    return {
      caseId: found.caseId,
      advice,
      available: advisorStack() !== undefined,
      ...(thread ? { thread } : {}),
    };
  });
}

export type AskOutcome = 'answered' | 'refused' | 'unavailable' | 'invalid' | 'not_found';

export interface AskResult {
  readonly outcome: AskOutcome;
  readonly thread?: string;
}

export async function adviseForOwner(
  token: string,
  question: string,
  locale: Locale,
  thread?: string,
): Promise<AskResult> {
  const asked = question.trim();
  if (asked.length < QUESTION_MIN || asked.length > QUESTION_MAX) return { outcome: 'invalid' };
  const stack = advisorStack();
  if (!stack) return { outcome: 'unavailable' };
  const result = await withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return { outcome: 'not_found' as const };
    const advice = await askAdvisor(connection, found.tenantId, {
      caseId: found.caseId,
      question: asked,
      by: holder(found.caseId),
      stack,
      locale,
      ...(thread ? { thread } : {}),
    });
    return {
      outcome: advice.refused ? ('refused' as const) : ('answered' as const),
      ...(advice.thread ? { thread: advice.thread.id } : {}),
    };
  });
  return result ?? { outcome: 'not_found' };
}

// A dive (V-05): the element's text seeds turn zero of a conversation scoped to it, or
// appends to the conversation it came from.
export interface DiveRequest {
  readonly kind: string;
  readonly ref: string;
  readonly fragment: string;
  readonly thread?: string;
}

export async function diveForOwner(
  token: string,
  request: DiveRequest,
  locale: Locale,
): Promise<AskResult> {
  const kind = DIVE_ORIGINS.find((k) => k === request.kind);
  const fragment = stripFragment(request.fragment);
  if (!kind || !request.ref.trim() || !diveable(fragment)) return { outcome: 'invalid' };
  const origin: DiveOrigin = { kind, ref: request.ref.trim() };
  const stack = advisorStack();
  if (!stack) return { outcome: 'unavailable' };
  const result = await withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return { outcome: 'not_found' as const };
    const advice = await askAdvisor(connection, found.tenantId, {
      caseId: found.caseId,
      dive: { origin, fragment, source: `${origin.kind} ${origin.ref}` },
      by: holder(found.caseId),
      stack,
      locale,
      ...(request.thread ? { thread: request.thread } : {}),
    });
    return {
      outcome: advice.refused ? ('refused' as const) : ('answered' as const),
      ...(advice.thread ? { thread: advice.thread.id } : {}),
    };
  });
  return result ?? { outcome: 'not_found' };
}
