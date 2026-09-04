import { layoutSupplyChain, supplyChainPdf, supplyChainSvg, type MapModel } from '@gc/artefacts';
import { caseByToken, supplyChainMapInput, type MapEvidenceRow } from '@gc/db';
import type { Locale } from '@gc/contracts';
import { withConnection } from '@/lib/case';

// The supply-chain map (D-08) for one case: the model, the SVG, and the evidence rows
// the nodes link to, all from the graph as it stands. The PDF and the PNG are drawn
// from the same model by their routes.

export interface SupplyChainView {
  readonly caseId: string;
  readonly model: MapModel;
  readonly svg: string;
  readonly evidence: readonly MapEvidenceRow[];
}

export async function supplyChainForToken(
  token: string,
  locale: Locale,
  now: () => Date = () => new Date(),
): Promise<SupplyChainView | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const input = await supplyChainMapInput(connection, found.tenantId, found.caseId);
    const model = layoutSupplyChain({
      company: {
        domain: input.company.domain,
        ...(input.company.legalName ? { name: input.company.legalName } : {}),
        country: input.company.country,
      },
      processors: input.processors,
      subProcessors: input.subProcessors,
      locale,
      generatedAt: now(),
      evidenceHref: (id) => `#evidence-${id}`,
    });
    return {
      caseId: found.caseId,
      model,
      svg: supplyChainSvg(model),
      evidence: input.evidence,
    };
  });
}

export const supplyChainPdfFor = (view: SupplyChainView): Promise<Buffer> =>
  supplyChainPdf(view.model);
