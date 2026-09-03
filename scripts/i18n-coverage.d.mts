// Types for the plain-JavaScript coverage check, so the unit test can import it.

export interface LocaleEntry {
  code: string;
  name: string;
  required: boolean;
}

export interface LocalesFile {
  default: string;
  locales: LocaleEntry[];
}

export interface Missing {
  file: string;
  path: string;
}

export interface LocaleCoverage extends LocaleEntry {
  translated: number;
  total: number;
  missing: Missing[];
}

export interface Coverage {
  files: number;
  strings: number;
  locales: LocaleCoverage[];
}

export const ROOT: string;
export const LOCALES_FILE: string;
export function isLocalisedText(value: unknown): boolean;
export function findLocalisedText(
  value: unknown,
  path?: string,
): { path: string; text: Record<string, string> }[];
export function contentFiles(root?: string): string[];
export function readLocales(file?: string): LocalesFile;
export function coverage(options?: { root?: string; locales?: LocalesFile }): Coverage;
export function failures(cov: Coverage): LocaleCoverage[];
export function report(cov: Coverage): string;
export function main(argv?: string[]): number;
