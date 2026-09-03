// A catalogue entry is a template. Case specifics are substituted by the resolver (R-04)
// from evidence, never invented by a model. The vocabulary is closed so that a template
// cannot ask for something the resolver does not know how to supply.

export const PLACEHOLDER_PATTERN = /\{\{([a-z_]+)\}\}/g;

export const PLACEHOLDER_NAMES = [
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
] as const;
export type Placeholder = (typeof PLACEHOLDER_NAMES)[number];

export const PLACEHOLDERS: ReadonlySet<string> = new Set(PLACEHOLDER_NAMES);

// What the resolver substitutes: a string, or a list rendered one item per line.
export type PlaceholderValues = Partial<Record<Placeholder, string | readonly string[]>>;

export function renderValue(value: string | readonly string[]): string {
  if (typeof value === 'string') return value;
  return value.map((v) => `  ${v}`).join('\n');
}

// Substitute every placeholder that has a value; return what is still unfilled.
export function fill(
  template: string,
  values: PlaceholderValues,
): { text: string; unfilled: string[] } {
  const unfilled = new Set<string>();
  const text = template.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const value = values[name as Placeholder];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      unfilled.add(name);
      return whole;
    }
    return renderValue(value);
  });
  return { text, unfilled: [...unfilled].sort() };
}

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
