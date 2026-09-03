// Types for the plain-JavaScript schema documenter, so the test can import it.

export const META_DIR: string;
export const TARGET: string;
export function latestSnapshot(dir?: string): { file: string; snapshot: unknown };
export function render(input: { file: string; snapshot: unknown }): string;
