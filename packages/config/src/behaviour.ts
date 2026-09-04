import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LocalisedTextSchema } from '@gc/contracts';

// The scanner's published behaviour (D-11), as content: the name it gives, the header
// it sends, the limits it keeps, what it never does, and who may ask for a deep scan
// of whom. The scanner reads its constants from this file and the page at /scanner is
// rendered from it, so the two cannot drift; a test holds the code to every number
// and name here. It lives in the configuration package because the web app renders
// it and must not depend on the scanner.

const L = LocalisedTextSchema;
export const BehaviourSchema = z.object({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  agent: z.object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/),
    version: z.string().regex(/^\d+(\.\d+)*$/),
    url: z.url(),
    contact: z.string().email(),
  }),
  identity: z.object({
    header: z.string().regex(/^X-[A-Za-z0-9-]+$/),
    robotsGroup: z.string().regex(/^[a-z][a-z0-9-]*$/),
  }),
  limits: z.object({
    minIntervalMs: z.number().int().min(0),
    perHostPerMinute: z.number().int().positive(),
    perDomainPerMinute: z.number().int().positive(),
    pagesPerScan: z.number().int().positive(),
    passesPerScan: z.number().int().positive(),
  }),
  never: z
    .array(z.enum(['authenticate', 'submit', 'consent_gate', 'download', 'private_address']))
    .min(5),
  page: z.object({
    title: L,
    lead: L,
    sections: z.array(z.object({ id: z.string().regex(/^[a-z_]+$/), heading: L, body: L })).min(1),
  }),
});
export type Behaviour = z.infer<typeof BehaviourSchema>;
export type BehaviourLimits = Behaviour['limits'];

export const BEHAVIOUR_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../content/behaviour.json',
);

let cached: Behaviour | undefined;
export function loadBehaviour(file: string = BEHAVIOUR_FILE): Behaviour {
  if (file === BEHAVIOUR_FILE && cached) return cached;
  const parsed = BehaviourSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (file === BEHAVIOUR_FILE) cached = parsed;
  return parsed;
}

// The user agent a crawler-type read announces: name, version and the page that says
// what the scanner does, in the form robots.txt authors expect.
export function scannerUserAgent(b: Behaviour = loadBehaviour()): string {
  return `${b.agent.name}/${b.agent.version} (+${b.agent.url})`;
}

// The headers every request carries, visitor passes included: the page that explains
// us, and a way to reach us.
export function identityHeaders(b: Behaviour = loadBehaviour()): Record<string, string> {
  return { [b.identity.header]: b.agent.url, From: b.agent.contact };
}

// The values the page shows, from the same content the code reads.
export function behaviourValues(b: Behaviour = loadBehaviour()): Record<string, string> {
  return {
    header: b.identity.header,
    userAgent: scannerUserAgent(b),
    contact: b.agent.contact,
    robotsGroup: b.identity.robotsGroup,
    minIntervalMs: String(b.limits.minIntervalMs),
    perHostPerMinute: String(b.limits.perHostPerMinute),
    perDomainPerMinute: String(b.limits.perDomainPerMinute),
    pagesPerScan: String(b.limits.pagesPerScan),
    passesPerScan: String(b.limits.passesPerScan),
  };
}

export const fillBehaviour = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');
