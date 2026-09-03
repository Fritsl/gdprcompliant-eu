// Shared by the server layout (the pre-paint script) and the client toggle. No directive,
// so both sides get the plain value.

export const THEME_KEY = 'gc-theme';
export type Theme = 'system' | 'light' | 'dark';
