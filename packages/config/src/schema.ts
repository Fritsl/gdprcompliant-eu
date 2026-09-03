import { z } from 'zod';
import { HostnameSchema, JurisdictionSchema, UrlSchema, isEea } from '@gc/contracts';

// Configuration is validated once, at boot, against these schemas. A value that is
// missing or malformed is a boot failure with a readable message, never a surprise at
// first use. Secrets are ordinary strings here; `redact()` knows which keys they are.

// Every host the system may ever contact on its own behalf, with why and where. The
// scanner's browser is the one exception and is governed separately: it visits the
// customer's site and whatever that site loads, because that is the object of study.
export const ENDPOINT_PURPOSES = [
  'model',
  'embedding',
  'registry',
  'corpus',
  'mail',
  'database',
  'webhook',
] as const;
export const EndpointPurposeSchema = z.enum(ENDPOINT_PURPOSES);
export type EndpointPurpose = z.infer<typeof EndpointPurposeSchema>;

export const EndpointSchema = z
  .object({
    host: HostnameSchema,
    purpose: EndpointPurposeSchema,
    // Where the operator of this host processes what we send. The system is EU-only:
    // anything outside the EEA is refused at boot, not at first request.
    jurisdiction: JurisdictionSchema.refine(isEea, {
      message: 'outside the EEA — the system does not send data there',
    }),
    note: z.string().optional(),
  })
  .describe('A declared outbound host');
export type Endpoint = z.infer<typeof EndpointSchema>;

export const SECRET_KEYS = ['DATABASE_URL', 'MODEL_API_KEY'] as const;

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_BASE_URL: UrlSchema.describe('public origin of the web app, e.g. https://gdprcompliant.eu'),
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .describe('postgres:// connection string, with the password'),
  // Self-hosted models sit behind an OpenAI-compatible endpoint, so the whole model stack
  // is one base URL. Per-tenant isolation is a deployment concern, not an application one.
  MODEL_BASE_URL: UrlSchema.describe('OpenAI-compatible base URL, e.g. https://llm.example.eu/v1'),
  MODEL_API_KEY: z
    .string()
    .min(1)
    .optional()
    .describe('bearer token for the model endpoint, if it needs one'),
  MODEL_CHAT: z.string().min(1).describe('chat model name as the endpoint knows it'),
  MODEL_EMBEDDING: z.string().min(1).describe('embedding model name as the endpoint knows it'),
  SCAN_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .default(2)
    .describe('browsers in flight'),
  // Deployment-specific hosts, as a JSON array of endpoints. The checked-in list covers
  // the shared services; the model endpoint is per deployment and goes here.
  ENDPOINTS_EXTRA: z.string().optional().describe('JSON array of {host, purpose, jurisdiction}'),
});
export type Env = z.infer<typeof EnvSchema>;

export const ConfigSchema = z.object({
  env: EnvSchema.shape.NODE_ENV,
  app: z.object({ baseUrl: UrlSchema }),
  database: z.object({ url: z.string() }),
  model: z.object({
    baseUrl: UrlSchema,
    apiKey: z.string().optional(),
    chat: z.string(),
    embedding: z.string(),
  }),
  scanner: z.object({
    concurrency: z.number().int(),
    // The browser may contact the target site and what it loads, nothing else.
    egress: z.literal('target-only'),
  }),
  endpoints: z.array(EndpointSchema).min(1),
});
export type Config = z.infer<typeof ConfigSchema>;
