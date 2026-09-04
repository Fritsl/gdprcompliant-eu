import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleSetSchema, type RuleSet } from './language.js';

// The rule sets are content: content/<JURISDICTION>.json, one per jurisdiction the
// rules speak in, validated on load. A file named for one jurisdiction that says it is
// another is refused.

export const RULES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../content');

export class RuleSetError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${basename(file)}: ${message}`);
    this.name = 'RuleSetError';
  }
}

export function loadRuleSet(file: string): RuleSet {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RuleSetError(file, `not valid JSON (${(e as Error).message})`);
  }
  const parsed = RuleSetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RuleSetError(
      file,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  if (`${parsed.data.jurisdiction}.json` !== basename(file))
    throw new RuleSetError(
      file,
      `says it is for ${parsed.data.jurisdiction}; name the file after it`,
    );
  return parsed.data;
}

export function loadRuleSets(dir: string = RULES_DIR): RuleSet[] {
  return (
    readdirSync(dir)
      // Only the jurisdiction files; sectors.json and questions.json live alongside.
      .filter((f) => /^[A-Z]{2}.json$/.test(f))
      .sort()
      .map((f) => loadRuleSet(join(dir, f)))
  );
}
