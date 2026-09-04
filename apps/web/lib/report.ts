import 'server-only';
import { reportModel, reportPdf } from '@gc/artefacts';
import { assembleReport } from '@gc/corpus';
import { caseByToken, connect } from '@gc/db';
import { loadCatalogue } from '@gc/remedies';
import type { Locale } from '@gc/contracts';
import { appBaseUrl, searchPath } from '@/lib/case';

// The status report (V-01), from the case as it stands the moment it is asked for. One
// click, always available, including mid-progress; no event is written for reading, so
// asking twice at the same moment gives the same document.

const catalogue = loadCatalogue();

export interface ReportFile {
  readonly caseId: string;
  readonly pdf: Buffer;
}

export async function reportForToken(
  token: string,
  locale: Locale,
): Promise<ReportFile | undefined> {
  const url = process.env['DATABASE_URL'];
  if (!url) return undefined;
  const connection = connect(url, { max: 1, ...searchPath(process.env) });
  try {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const input = await assembleReport(connection, found.tenantId, found.caseId, {
      catalogue,
      locale,
      caseUrl: `${appBaseUrl()}/${locale}/c/${token}`,
      now: new Date(),
    });
    const pdf = await reportPdf(reportModel(input, { locale }));
    return { caseId: found.caseId, pdf };
  } finally {
    await connection.close();
  }
}
