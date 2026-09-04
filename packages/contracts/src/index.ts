// @gc/contracts — the only definition of every shape that crosses a boundary.
//
//   primitives   jurisdictions, locales, ids, hashes, translatable text
//   citation     mechanical citations and the corpus key
//   corpus       corpus chunks, versions, and what resolving a citation returns
//   evidence     immutable observations, evidence pointers, untrusted content
//   claim        what workers return; the verifier's verdict
//   finding      finding types, jurisdiction bindings, persisted findings
//   remedy       the five remedy kinds, actions, verification, the demand ledger
//   case         cases, companies, actors, the closed timeline-event enum
//   vendor       recipients in the supply chain
//   duty         obligations derived by the rule engine
//   planner      the closed task catalogue, plans, results
//   model        every model call's input and output schema
//   json-schema  JSON Schema generated from the above for structured output

export const PACKAGE = '@gc/contracts';

export * from './primitives.js';
export * from './citation.js';
export * from './corpus.js';
export * from './target.js';
export * from './consent.js';
export * from './diff.js';
export * from './evidence.js';
export * from './claim.js';
export * from './finding.js';
export * from './remedy.js';
export * from './case.js';
export * from './vendor.js';
export * from './duty.js';
export * from './planner.js';
export * from './model.js';
export * from './json-schema.js';
export * from './fixture.js';
export * from './hash.js';
export * from './capture.js';
export * from './cookie.js';
export * from './security.js';
export * from './policy.js';
export * from './forms.js';
export * from './replay.js';
export * from './dns.js';
export * from './ct.js';
export * from './recipients.js';
export * from './transfers.js';
export * from './graph.js';
export * from './guide.js';
