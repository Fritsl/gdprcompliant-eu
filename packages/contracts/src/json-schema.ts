import { z } from 'zod';
import { MODEL_CALLS, type ModelCallName } from './model.js';

// JSON Schema is generated from the Zod definitions, never written by hand, so the
// schema a model is asked to fill and the schema its answer is validated against are
// one object. Refinements are not expressible in JSON Schema and are checked at parse
// time; everything else round-trips.

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    io: 'output',
    reused: 'inline',
  }) as JsonSchema;
}

export function modelOutputJsonSchema(name: ModelCallName): JsonSchema {
  return toJsonSchema(MODEL_CALLS[name].output);
}

export function modelInputJsonSchema(name: ModelCallName): JsonSchema {
  return toJsonSchema(MODEL_CALLS[name].input);
}
