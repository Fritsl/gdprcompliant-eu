import { z } from 'zod';
import {
  CountryCodeSchema,
  HostnameSchema,
  LocaleSchema,
  SUPPORTED_JURISDICTIONS,
  type Jurisdiction,
  type Locale,
} from './primitives.js';

// Where a target is (I-03). A German site produces a German case whoever ran the scan,
// so the jurisdiction and the case's language come from the target, read off three
// signals in order of confidence: what the site says its language is, its top-level
// domain, and what the business register says about it. A visitor can still change the
// language of their own case; that is recorded on the case, not inferred again.

export const TargetSignalsSchema = z
  .object({
    domain: HostnameSchema,
    // <html lang>, or the Content-Language header: what the site says it speaks.
    documentLang: z.string().optional(),
    contentLanguage: z.string().optional(),
    // The country a business register resolved the entity to (D-03).
    registryCountry: CountryCodeSchema.optional(),
  })
  .describe('What is known about a target before a case exists');
export type TargetSignals = z.infer<typeof TargetSignalsSchema>;

export const TARGET_BASES = ['language', 'tld', 'registry'] as const;
export const TargetBasisSchema = z.enum(TARGET_BASES);
export type TargetBasis = z.infer<typeof TargetBasisSchema>;

export const TargetInferenceSchema = z
  .object({
    jurisdiction: z.string().regex(/^[A-Z]{2}$/),
    locale: LocaleSchema,
    basis: TargetBasisSchema,
    // What the signal was, for the timeline and the log.
    signal: z.string(),
  })
  .describe('The jurisdiction and language a target was found to have, and why');
export type TargetInference = z.infer<typeof TargetInferenceSchema>;

// The language a case opens in for each jurisdiction the product speaks.
export const LOCALE_FOR_JURISDICTION: Readonly<Record<string, Locale>> = {
  DK: 'da',
  DE: 'de',
};

// Languages that point at one supported jurisdiction when the tag names no region.
const JURISDICTION_FOR_LANGUAGE: Readonly<Record<string, string>> = {
  da: 'DK',
  de: 'DE',
};

const TLD_COUNTRY: Readonly<Record<string, string>> = {
  dk: 'DK',
  de: 'DE',
};

export interface TargetUnresolved {
  readonly ok: false;
  readonly reason: 'unsupported_target';
  readonly tried: readonly { basis: TargetBasis; signal: string; outcome: string }[];
  readonly supported: readonly string[];
}

export type TargetResolution = ({ readonly ok: true } & TargetInference) | TargetUnresolved;

function jurisdictionFromLanguage(tag: string, supported: ReadonlySet<string>): string | undefined {
  const m = /^([a-z]{2,3})(?:[-_]([a-z]{2}))?/i.exec(tag.trim());
  if (!m) return undefined;
  const language = m[1]!.toLowerCase();
  const region = m[2]?.toUpperCase();
  if (region) return supported.has(region) ? region : undefined;
  const j = JURISDICTION_FOR_LANGUAGE[language];
  return j && supported.has(j) ? j : undefined;
}

export function inferTarget(
  signals: TargetSignals,
  supported: readonly string[] = SUPPORTED_JURISDICTIONS,
): TargetResolution {
  const set = new Set(supported);
  const tried: { basis: TargetBasis; signal: string; outcome: string }[] = [];
  const found = (basis: TargetBasis, signal: string, jurisdiction: string): TargetResolution => ({
    ok: true,
    jurisdiction,
    locale: LOCALE_FOR_JURISDICTION[jurisdiction] ?? 'en',
    basis,
    signal,
  });

  for (const tag of [signals.documentLang, signals.contentLanguage]) {
    if (!tag) continue;
    const j = jurisdictionFromLanguage(tag, set);
    if (j) return found('language', tag, j);
    tried.push({ basis: 'language', signal: tag, outcome: 'not a supported jurisdiction' });
  }

  const tld = signals.domain.split('.').at(-1)?.toLowerCase() ?? '';
  const byTld = TLD_COUNTRY[tld];
  if (byTld && set.has(byTld)) return found('tld', `.${tld}`, byTld);
  tried.push({ basis: 'tld', signal: `.${tld}`, outcome: byTld ? 'not supported' : 'no country' });

  if (signals.registryCountry) {
    if (set.has(signals.registryCountry)) {
      return found('registry', signals.registryCountry, signals.registryCountry);
    }
    tried.push({ basis: 'registry', signal: signals.registryCountry, outcome: 'not supported' });
  }

  return { ok: false, reason: 'unsupported_target', tried, supported: [...supported] };
}

// The signals a Pass A capture carries about the document.
export function signalsFromDocument(
  domain: string,
  document: { lang?: string; contentLanguage?: string } | undefined,
  registryCountry?: string,
): TargetSignals {
  const signals: Record<string, string> = { domain };
  if (document?.lang) signals['documentLang'] = document.lang;
  if (document?.contentLanguage) signals['contentLanguage'] = document.contentLanguage;
  if (registryCountry) signals['registryCountry'] = registryCountry;
  return TargetSignalsSchema.parse(signals);
}

export const describeUnresolved = (u: TargetUnresolved): string =>
  `${u.tried.map((t) => `${t.basis} ${t.signal}: ${t.outcome}`).join('; ') || 'no signal'} — the product speaks ${u.supported.join(', ')}`;

export type { Jurisdiction };
