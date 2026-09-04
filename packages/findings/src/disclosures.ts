import { DisclosureTableSchema, type DisclosureElement, type DisclosureTable } from '@gc/contracts';
import disclosuresJson from '../content/disclosures.json' with { type: 'json' };

// What a privacy policy has to tell the reader (S-10): the disclosure elements, as
// content. Each names the provision it rests on and the finding raised when it is
// missing, where the catalogue has one; an element without a finding type is still
// checked and reported, and the gap is the remedy catalogue's to fill.

export const DISCLOSURES: DisclosureTable = DisclosureTableSchema.parse(disclosuresJson);

export const DISCLOSURE_ELEMENTS: readonly DisclosureElement[] = DISCLOSURES.elements;

export function disclosureElement(id: string): DisclosureElement | undefined {
  return DISCLOSURE_ELEMENTS.find((e) => e.id === id);
}
