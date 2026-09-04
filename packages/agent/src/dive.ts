import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LocalisedTextSchema, type Locale } from '@gc/contracts';

// Dive points (V-05). Any element on a page opens a conversation already scoped to it,
// the way GDPRchat's "Dive deeper" does: the element's text, stripped of markdown and
// capped, goes after a localised "Tell me more about this:" as the first turn. The
// fragment is a pointer, not an essay, which is what the cap is for; and it is quoted
// material, often from the customer's own site or a contract, so it travels fenced and
// labelled as data (see advise()). The gating is the quiet part: nothing to expand,
// or an element that already offers a specific next action, gets no dive point.

const DiveContentSchema = z.object({
  version: z.string(),
  maxChars: z.number().int().positive(),
  tellMeMore: LocalisedTextSchema,
});

export const DIVE_CONTENT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
  'dive.json',
);
export const DIVE_CONTENT = DiveContentSchema.parse(
  JSON.parse(readFileSync(DIVE_CONTENT_FILE, 'utf8')),
);
export const DIVE_MAX_CHARS = DIVE_CONTENT.maxChars;

export const tellMeMore = (locale: Locale): string =>
  DIVE_CONTENT.tellMeMore[locale] ?? DIVE_CONTENT.tellMeMore['en']!;

// Markdown out, whitespace folded, capped: the same treatment GDPRchat gives a card.
export function stripFragment(text: string, max = DIVE_MAX_CHARS): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? plain.slice(0, max).trimEnd() : plain;
}

export interface DiveGate {
  // The element already offers a specific next action: one way forward per thing.
  readonly hasAction?: boolean;
}

// Whether an element gets a dive point at all.
export function diveable(fragment: string, gate: DiveGate = {}): boolean {
  if (gate.hasAction) return false;
  const plain = stripFragment(fragment);
  // A bare number, a date, a percentage: nothing to expand.
  if (/^[\d\s.,:%/–-]*$/.test(plain)) return false;
  // A status pill or a label: one or two short words.
  if (plain.length < 12) return false;
  // A lead-in that ends in a colon would quote a dangling stub.
  if (plain.endsWith(':')) return false;
  return true;
}

// The first turn: the localised prefix and the fragment, as the page shows it and the
// record keeps it. In the prompt the fragment is fenced; only the prefix is outside.
export function diveQuestion(locale: Locale, fragment: string): { prefix: string; text: string } {
  const prefix = tellMeMore(locale);
  const plain = stripFragment(fragment);
  return { prefix, text: `${prefix} ${plain}` };
}
