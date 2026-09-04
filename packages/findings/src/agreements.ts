import { AgreementTableSchema, type AgreementElement } from '@gc/contracts';
import table from '../content/agreement-elements.json' with { type: 'json' };

// What a processing agreement must stipulate (D-06): the contract elements, the
// sub-processor conditions, the breach notice and the transfer safeguard, as content.
// The reader asks about these by id; the provision each rests on is here and nowhere
// in the reader.

export const AGREEMENT_TABLE = AgreementTableSchema.parse(table);
export const AGREEMENT_ELEMENTS: readonly AgreementElement[] = AGREEMENT_TABLE.elements;

export function agreementElement(id: string): AgreementElement | undefined {
  return AGREEMENT_ELEMENTS.find((e) => e.id === id);
}
