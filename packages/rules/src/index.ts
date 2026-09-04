// @gc/rules — the obligations engine (A-02): rules as data, a fact sheet from the graph,
// three-valued evaluation that is total and deterministic, and every rule's citations
// and examples checked in CI.
//
//   language   the rule language: conditions over named facts, rules, rule sets
//   facts      the fact sheet derived from the register and the company
//   engine     evaluate a jurisdiction's sets over a sheet; run every example
//   content    content/<JURISDICTION>.json, validated on load

export const PACKAGE = '@gc/rules';

export * from './language.js';
export * from './facts.js';
export * from './engine.js';
export * from './content.js';
