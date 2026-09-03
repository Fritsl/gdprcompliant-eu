import type { ReactNode } from 'react';

// The root layout only passes through. The html element, its lang and the theme script
// belong to the locale layout, because the locale is a route segment from the first
// request and nothing renders outside one.

export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
