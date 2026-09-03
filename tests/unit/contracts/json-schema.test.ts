import { describe, expect, it } from 'vitest';
import {
  CaseEventSchema,
  CaseSchema,
  ClaimSchema,
  DutySchema,
  EvidenceSchema,
  FindingSchema,
  JurisdictionBindingSchema,
  MODEL_CALL_NAMES,
  PlannerTaskSchema,
  RemedySchema,
  RenderedRemedySchema,
  VendorSchema,
  VerifierVerdictSchema,
  modelInputJsonSchema,
  modelOutputJsonSchema,
  toJsonSchema,
} from '@gc/contracts';

// Walk a JSON Schema and call fn on every object-typed node.
function eachObjectNode(
  node: unknown,
  fn: (n: Record<string, unknown>, path: string) => void,
  path = '$',
): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => eachObjectNode(n, fn, `${path}[${i}]`));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n['type'] === 'object' && typeof n['properties'] === 'object') fn(n, path);
  for (const [k, v] of Object.entries(n)) eachObjectNode(v, fn, `${path}.${k}`);
}

describe('JSON Schema generation', () => {
  it('every model output converts to a closed draft-2020-12 object', () => {
    for (const name of MODEL_CALL_NAMES) {
      const schema = modelOutputJsonSchema(name);
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema['type']).toBe('object');
      eachObjectNode(schema, (n, path) => {
        expect(n['additionalProperties'], `${name} ${path} is not closed`).toBe(false);
      });
      expect(JSON.stringify(schema)).not.toContain('"$ref"');
    }
  });

  it('every model input converts', () => {
    for (const name of MODEL_CALL_NAMES) {
      expect(() => modelInputJsonSchema(name)).not.toThrow();
    }
  });

  it('is deterministic', () => {
    for (const name of MODEL_CALL_NAMES) {
      expect(JSON.stringify(modelOutputJsonSchema(name))).toBe(
        JSON.stringify(modelOutputJsonSchema(name)),
      );
    }
  });

  it('the domain schemas convert without unrepresentable types', () => {
    const domain = {
      FindingSchema,
      JurisdictionBindingSchema,
      EvidenceSchema,
      ClaimSchema,
      VerifierVerdictSchema,
      RemedySchema,
      RenderedRemedySchema,
      CaseSchema,
      CaseEventSchema,
      VendorSchema,
      DutySchema,
      PlannerTaskSchema,
    };
    for (const [name, schema] of Object.entries(domain)) {
      expect(() => toJsonSchema(schema), name).not.toThrow();
    }
  });

  it('carries descriptions through, so the prompt side sees the same words', () => {
    const finding = toJsonSchema(FindingSchema);
    const props = finding['properties'] as Record<string, Record<string, unknown>>;
    expect(props['typeId']?.['description']).toMatch(/CNS-02/);
    expect(props['remedy']).toBeDefined();
    expect(finding['required']).toEqual(
      expect.arrayContaining(['remedy', 'evidence', 'binding', 'severity']),
    );
  });
});
