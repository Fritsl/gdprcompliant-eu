// @gc/config — typed configuration, validated at boot, and the only door out.
//
//   schema   the environment and endpoint schemas
//   load     loadConfig(): every problem reported together, by variable name
//   egress   createOutboundFetch(): refuses undeclared hosts before any bytes leave

export const PACKAGE = '@gc/config';

export * from './schema.js';
export * from './load.js';
export * from './egress.js';
