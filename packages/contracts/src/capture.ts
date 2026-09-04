import { z } from 'zod';
import { IsoDateTimeSchema, ScanPassSchema, Sha256Schema } from './primitives.js';

// What one browser pass observed (S-02, S-04): every request with where it came from,
// every cookie as the browser holds it, every write to web storage, and a screenshot.
// The differ (S-05) reads three of these; detectors read one. Nothing in here is a
// judgement — it is what happened, in a shape the evidence store can hash.

// Playwright's resource types.
export const RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
] as const;
export const ResourceTypeSchema = z.enum(RESOURCE_TYPES);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const INITIATOR_TYPES = ['parser', 'script', 'preload', 'preflight', 'other'] as const;

export const CapturedRequestSchema = z
  .object({
    url: z.string().min(1),
    host: z.string().min(1),
    method: z.string().min(1),
    resourceType: ResourceTypeSchema,
    // The frame that made the request: the page itself, or an iframe.
    frameUrl: z.string(),
    // Who caused it, and the chain back to the document: the script that inserted the
    // tag, the script that loaded that script, and so on.
    // Chromium's attribution: a script that inserted an element or called fetch is a
    // 'script' initiator with its URL; anything the HTML parser requested — including what a
    // parser-blocking script did while the parser waited — is 'parser', with the document
    // as url and the 1-based line of the tag that caused it.
    initiator: z.object({
      type: z.enum(INITIATOR_TYPES),
      url: z.string().optional(),
      line: z.number().int().min(1).optional(),
    }),
    chain: z.array(z.string()).default([]),
    redirectedFrom: z.string().optional(),
    // Milliseconds since the navigation started.
    startedAtMs: z.number().min(0),
    durationMs: z.number().min(0).optional(),
    status: z.number().int().optional(),
    failed: z.string().optional(),
    sizeBytes: z.number().int().min(0).optional(),
  })
  .describe('One request the browser made during a pass');
export type CapturedRequest = z.infer<typeof CapturedRequestSchema>;

export const CapturedCookieSchema = z
  .object({
    name: z.string().min(1),
    value: z.string(),
    domain: z.string().min(1),
    path: z.string().min(1),
    // Unix seconds; -1 for a session cookie.
    expires: z.number(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(['Strict', 'Lax', 'None']),
  })
  .describe('A cookie as the browser holds it after the pass');
export type CapturedCookie = z.infer<typeof CapturedCookieSchema>;

export const StorageWriteSchema = z
  .object({
    origin: z.string().min(1),
    area: z.enum(['local', 'session']),
    key: z.string(),
    value: z.string(),
    // Milliseconds since navigation, or -1 when only the final state was seen.
    atMs: z.number(),
  })
  .describe('A write to localStorage or sessionStorage');
export type StorageWrite = z.infer<typeof StorageWriteSchema>;

// The network-quiet heuristic, as configured and as it played out. See
// docs/decisions/network-quiet.md.
export const NetworkQuietSchema = z.object({
  minDwellMs: z.number().int().min(0),
  quietMs: z.number().int().min(0),
  maxWaitMs: z.number().int().min(0),
  dwellMs: z.number().min(0),
  lastRequestAtMs: z.number().min(0),
  // true when the page went quiet; false when maxWaitMs cut the wait short.
  settled: z.boolean(),
});
export type NetworkQuiet = z.infer<typeof NetworkQuietSchema>;

export const PassCaptureSchema = z
  .object({
    pass: ScanPassSchema,
    url: z.string().min(1),
    finalUrl: z.string().min(1),
    status: z.number().int().optional(),
    // What the document says about itself: its declared language, the Content-Language
    // header, its title (I-03).
    document: z
      .object({
        lang: z.string().optional(),
        contentLanguage: z.string().optional(),
        title: z.string().optional(),
      })
      .optional(),
    startedAt: IsoDateTimeSchema,
    frames: z.array(z.string()).default([]),
    requests: z.array(CapturedRequestSchema),
    cookies: z.array(CapturedCookieSchema),
    storage: z.array(StorageWriteSchema),
    screenshotHash: Sha256Schema.optional(),
    quiet: NetworkQuietSchema,
  })
  .describe('Everything one pass observed');
export type PassCapture = z.infer<typeof PassCaptureSchema>;
