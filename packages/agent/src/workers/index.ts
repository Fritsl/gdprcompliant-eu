import type { Workers } from '../dispatcher.js';
import { createClaimVerifier, type ClaimVerifierDeps } from './claim-verifier.js';
import { createContractReader, type ContractReaderDeps } from './contract-reader.js';
import { createCrawler, type CrawlerDeps } from './crawler.js';
import { createDrafter, type DrafterDeps } from './drafter.js';
import { createRegistryAdapter, type RegistryAdapterDeps } from './registry-adapter.js';
import { createResearcher, type ResearcherDeps } from './researcher.js';

// The workers (A-05): one narrow specialist per task type, each built from the
// smallest set of tools that does its job, handed in as functions so the caller (and
// the test) decides what each may reach. A worker returns claims and evidence, never
// a finding and never a verdict; assembly and judgement happen elsewhere.

export * from './shared.js';
export * from './crawler.js';
export * from './contract-reader.js';
export * from './registry-adapter.js';
export * from './researcher.js';
export * from './drafter.js';
export * from './claim-verifier.js';

export interface WorkerDeps {
  readonly crawler?: CrawlerDeps;
  readonly contractReader?: ContractReaderDeps;
  readonly registryAdapter?: RegistryAdapterDeps;
  readonly researcher?: ResearcherDeps;
  readonly drafter?: DrafterDeps;
  readonly claimVerifier?: ClaimVerifierDeps;
}

// The set the dispatcher runs. A worker whose tools were not given is absent, and the
// dispatcher skips its tasks with the reason on the record.
export function createWorkers(deps: WorkerDeps): Workers {
  return {
    ...(deps.crawler ? { crawl: createCrawler(deps.crawler) } : {}),
    ...(deps.contractReader ? { read_contract: createContractReader(deps.contractReader) } : {}),
    ...(deps.registryAdapter
      ? { registry_lookup: createRegistryAdapter(deps.registryAdapter) }
      : {}),
    ...(deps.researcher ? { research: createResearcher(deps.researcher) } : {}),
    ...(deps.drafter ? { draft: createDrafter(deps.drafter) } : {}),
    ...(deps.claimVerifier ? { verify_claims: createClaimVerifier(deps.claimVerifier) } : {}),
  };
}
