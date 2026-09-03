// A catalogue entry is a template. Case specifics are substituted by the resolver (R-04)
// from evidence, never invented by a model. The vocabulary is closed so that a template
// cannot ask for something the resolver does not know how to supply.

export const PLACEHOLDER_PATTERN = /\{\{([a-z_]+)\}\}/g;

export const PLACEHOLDERS: ReadonlySet<string> = new Set([
  // The customer's site
  'domain',
  'path',
  'paths',
  'page',
  // Hosts and vendors observed
  'host',
  'hosts',
  'essential_hosts',
  'tool',
  'tool_host',
  'tracker',
  'font_families',
  'font_hosts',
  // Forms
  'form_path',
  'post_url_http',
  'post_url_https',
  'fields',
  'control_id',
  'label',
  // People and time
  'recipients',
  'owner',
  'day',
]);

export function placeholdersIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER_PATTERN)) if (m[1] !== undefined) out.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) placeholdersIn(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) placeholdersIn(v, out);
  }
  return out;
}
