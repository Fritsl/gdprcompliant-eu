'use client';

import { useEffect, useState } from 'react';
import { THEME_KEY, type Theme } from '@/lib/theme';

// Light, dark, or follow the system. The choice lives in this browser only; the inline
// script in the layout applies it before first paint so there is no flash. Labels come
// in as props: this component holds no strings of its own.

export function ThemeToggle({ label, options }: { label: string; options: Record<Theme, string> }) {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') setTheme(stored);
    } catch {
      // storage unavailable: stay on system
    }
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    try {
      if (next === 'system') window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage unavailable: the attribute still applies for this page
    }
  };

  return (
    <fieldset className="theme-toggle">
      <legend>{label}</legend>
      {(Object.keys(options) as Theme[]).map((value) => (
        <label key={value}>
          <input
            type="radio"
            name="theme"
            value={value}
            checked={theme === value}
            onChange={() => apply(value)}
          />
          {options[value]}
        </label>
      ))}
    </fieldset>
  );
}
