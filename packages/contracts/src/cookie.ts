import { z } from 'zod';
import { IsoDateTimeSchema, NonEmptyStringSchema, Sha256Schema, UrlSchema } from './primitives.js';

// Cookie classification (S-06): what a cookie is for, according to a maintained open
// database, with an explicit unknown. A cookie the database does not know is unknown —
// it is never guessed into a category — and every classification says which database,
// which version, answered.

export const COOKIE_CATEGORIES = [
  'necessary',
  'functional',
  'analytics',
  'marketing',
  'personalisation',
  'security',
  'unknown',
] as const;
export const CookieCategorySchema = z.enum(COOKIE_CATEGORIES);
export type CookieCategory = z.infer<typeof CookieCategorySchema>;

// One row of the database, as we keep it.
export const CookieEntrySchema = z.object({
  id: NonEmptyStringSchema,
  platform: z.string(),
  category: CookieCategorySchema.exclude(['unknown']),
  name: NonEmptyStringSchema,
  // When true, `name` is a prefix: _ga_ matches _ga_ABC123.
  wildcard: z.boolean(),
  domain: z.string().optional(),
  description: z.string().optional(),
  retention: z.string().optional(),
  dataController: z.string().optional(),
  privacyUrl: z.string().optional(),
});
export type CookieEntry = z.infer<typeof CookieEntrySchema>;

// Which database, which version. Written by the refresh job, read on every classification.
export const CookieDatabaseVersionSchema = z.object({
  source: NonEmptyStringSchema,
  url: UrlSchema,
  licence: NonEmptyStringSchema,
  // The hash of the file as fetched: the version that actually answered.
  version: Sha256Schema,
  commit: z.string().optional(),
  fetchedAt: IsoDateTimeSchema,
  entries: z.number().int().min(1),
});
export type CookieDatabaseVersion = z.infer<typeof CookieDatabaseVersionSchema>;

export const CookieClassificationSchema = z
  .object({
    name: NonEmptyStringSchema,
    domain: z.string().optional(),
    category: CookieCategorySchema,
    // matched: one entry, or several that agree. ambiguous: entries that disagree, so
    // the category is unknown and the candidates are listed. unmatched: nothing known.
    resolution: z.enum(['matched', 'ambiguous', 'unmatched']),
    match: CookieEntrySchema.optional(),
    candidates: z.array(CookieEntrySchema).default([]),
    source: z.object({
      name: NonEmptyStringSchema,
      version: Sha256Schema,
      fetchedAt: IsoDateTimeSchema,
    }),
  })
  .superRefine((c, ctx) => {
    if (c.resolution === 'matched' && (c.match === undefined || c.category === 'unknown')) {
      ctx.addIssue({
        code: 'custom',
        path: ['match'],
        message: 'a match names its entry and a category',
      });
    }
    if (c.resolution !== 'matched' && c.category !== 'unknown') {
      ctx.addIssue({
        code: 'custom',
        path: ['category'],
        message: 'without a match the category is unknown, never a guess',
      });
    }
  })
  .describe('What a cookie is for, according to the database, or unknown');
export type CookieClassification = z.infer<typeof CookieClassificationSchema>;
