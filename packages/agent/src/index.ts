// @gc/agent — planner, workers, verifier, and the one door to a model.
//
//   model-client   ModelClient: validated in, validated out, retry once, fail loudly
//   catalogue      the closed task vocabulary, each with payload, output, cost (A-04)
//   dispatcher     plans within budget, runs in dependency order, stops rather than overspend

export const PACKAGE = '@gc/agent';

export * from './model-client.js';
export * from './catalogue.js';
export * from './dispatcher.js';
export * from './verifier.js';
export * from './untrusted.js';
export * from './guards.js';
export * from './policy-clauses.js';
