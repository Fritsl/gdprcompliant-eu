// Types for the plain-JavaScript RLS lint, so the unit test can import it.

export const MIGRATIONS_DIR: string;
export function tablesInSnapshot(dir?: string): string[];
export function migrationsSql(dir?: string): string;
export function rlsCoverage(
  tables: string[],
  sql: string,
): Record<string, { enabled: boolean; forced: boolean; policies: number }>;
export function rlsProblems(
  coverage: Record<string, { enabled: boolean; forced: boolean; policies: number }>,
): string[];
