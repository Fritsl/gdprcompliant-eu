// @gc/remedies — the remedy catalogue: content, validation, versioning, lookup.
//
//   catalogue     load and validate content/remedies/*.json; lookup by finding and jurisdiction
//   lock          version and hash record that makes every change auditable
//   localise      one locale out of an entry, with fallbacks reported
//   placeholders  the closed vocabulary a template may ask the resolver for
//   resolver      the cheapest remedy that genuinely closes a finding, and why

export const PACKAGE = '@gc/remedies';

export * from './canonical.js';
export * from './catalogue.js';
export * from './lock.js';
export * from './localise.js';
export * from './placeholders.js';
export * from './resolver.js';
