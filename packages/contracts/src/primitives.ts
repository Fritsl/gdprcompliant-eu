import { z } from 'zod';

// Shared primitives. Every other module builds on these so that a jurisdiction, a locale
// or a hash means exactly one thing across the whole graph.

export const CountryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, upper case')
  .describe('ISO 3166-1 alpha-2 country code');
export type CountryCode = z.infer<typeof CountryCodeSchema>;

// A jurisdiction is a member state, or the Union level itself. Which jurisdictions are
// *supported* is a property of the binding table (I-02), not of this schema: the shape
// must never encode Danish or German law.
export const JurisdictionSchema = z
  .string()
  .regex(/^(EU|[A-Z]{2})$/, 'EU or an ISO 3166-1 alpha-2 country code')
  .describe('Jurisdiction: EU or a member-state country code');
export type Jurisdiction = z.infer<typeof JurisdictionSchema>;

// The jurisdictions the product ships bindings, remedies and guides for at launch. Data,
// reviewed when a jurisdiction is added; the R-02 CI check iterates over it.
export const SUPPORTED_JURISDICTIONS = ['DK', 'DE'] as const;
export type SupportedJurisdiction = (typeof SUPPORTED_JURISDICTIONS)[number];

export const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'BCP 47 language, optionally with region')
  .describe('Locale, e.g. en, da, de');
export type Locale = z.infer<typeof LocaleSchema>;

export const DEFAULT_LOCALE = 'en' as const;
export const SUPPORTED_LOCALES = ['en', 'da', 'de'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// Translatable content (I-01): a record of locale variants. English is the fallback and
// is therefore mandatory; a missing variant in another locale is reported, never silent.
export const LocalisedTextSchema = z
  .record(LocaleSchema, z.string().min(1))
  .refine((r) => typeof r[DEFAULT_LOCALE] === 'string', {
    message: 'English is the fallback locale and must always be present',
  })
  .describe('Text with locale variants; en is required');
export type LocalisedText = z.infer<typeof LocalisedTextSchema>;

export const IsoDateTimeSchema = z.iso
  .datetime({ offset: true })
  .describe('ISO 8601 date-time with zone');
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'lower-case hex SHA-256')
  .describe('SHA-256 of canonical content, lower-case hex');
export type Sha256 = z.infer<typeof Sha256Schema>;

// Opaque row identifiers. The database decides the format; the graph only needs them to
// be non-empty and bounded.
export const IdSchema = z.string().min(1).max(128).describe('Opaque identifier');
export type Id = z.infer<typeof IdSchema>;

export const TenantIdSchema = IdSchema.describe('Tenant identifier');
export type TenantId = z.infer<typeof TenantIdSchema>;

// Case numbers are shareable and read aloud: country, two-digit year, four characters.
export const CaseIdSchema = z
  .string()
  .regex(/^[A-Z]{2}-\d{2}-[A-Z0-9]{4}$/, 'e.g. DK-26-0M4K')
  .describe('Public case number, e.g. DK-26-0M4K');
export type CaseId = z.infer<typeof CaseIdSchema>;

// A finding type's stable identity: an area code and a number, e.g. CNS-02. It carries
// no article and no authority; those are jurisdiction bindings (I-02).
export const FindingTypeIdSchema = z
  .string()
  .regex(/^[A-Z]{2,4}-\d{2}$/, 'e.g. CNS-02')
  .describe('Finding type id, e.g. CNS-02');
export type FindingTypeId = z.infer<typeof FindingTypeIdSchema>;

export const HostnameSchema = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z0-9-]+$/i, 'hostname')
  .describe('Hostname without scheme or path');
export type Hostname = z.infer<typeof HostnameSchema>;

export const UrlSchema = z.url().describe('Absolute URL');
export type Url = z.infer<typeof UrlSchema>;

export const NonEmptyStringSchema = z.string().trim().min(1);

// The scanner's three passes: A is the untouched first load, B is after refusing, C is
// after accepting.
export const ScanPassSchema = z
  .enum(['A', 'B', 'C'])
  .describe('Scan pass: A first load, B refused, C accepted');
export type ScanPass = z.infer<typeof ScanPassSchema>;
