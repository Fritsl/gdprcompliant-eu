import type { Advice, Locale } from '@gc/contracts';
import { advisorStack, askAdvisor } from '@gc/corpus';
import { adviceOf, caseByToken } from '@gc/db';
import { holder, withConnection } from '@/lib/case';

// The advisor (V-02) for one case: what has been asked and answered, and one more
// question posted by the holder, answered from the case and the law and recorded on the
// timeline so the report carries it.

export interface AdvisorView {
  readonly caseId: string;
  readonly advice: readonly Advice[];
  readonly available: boolean;
}

export const QUESTION_MIN = 5;
export const QUESTION_MAX = 500;

export async function loadAdvisor(token: string): Promise<AdvisorView | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const advice = await adviceOf(connection, found.tenantId, found.caseId);
    return { caseId: found.caseId, advice, available: advisorStack() !== undefined };
  });
}

export type AskOutcome = 'answered' | 'refused' | 'unavailable' | 'invalid' | 'not_found';

export async function adviseForOwner(
  token: string,
  question: string,
  locale: Locale,
): Promise<AskOutcome> {
  const asked = question.trim();
  if (asked.length < QUESTION_MIN || asked.length > QUESTION_MAX) return 'invalid';
  const stack = advisorStack();
  if (!stack) return 'unavailable';
  const outcome = await withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return 'not_found' as const;
    const advice = await askAdvisor(connection, found.tenantId, {
      caseId: found.caseId,
      question: asked,
      by: holder(found.caseId),
      stack,
      locale,
    });
    return advice.refused ? ('refused' as const) : ('answered' as const);
  });
  return outcome ?? 'not_found';
}
