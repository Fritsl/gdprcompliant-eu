import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Node globals, declared explicitly rather than pulling in another dependency.
const node = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'artifacts/**',
      // The prototype is vanilla ES5-style on purpose and has its own harness.
      'apps/prototype/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: node } },
  {
    // I-02: a finding has a stable identity; the article, the authority and the guide
    // text are jurisdiction-scoped bindings. An article number hard-coded in a detector
    // is how the product quietly becomes Danish-only. Scoped to the packages that will
    // hold detector and rule logic — task text and tests may of course name articles.
    files: [
      'packages/findings/**/*.ts',
      'packages/scanner/**/*.ts',
      'packages/rules/src/engine/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: String.raw`Literal[value=/\bArt(icle)?\.?\s*\d+/i]`,
          message: 'No article numbers in detector code — use a jurisdiction binding (I-02).',
        },
      ],
    },
  },
);
