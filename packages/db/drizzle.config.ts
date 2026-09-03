import { defineConfig } from 'drizzle-kit';

// Migrations are explicit SQL, generated from src/schema.ts and committed. Generation
// needs no database; applying does (pnpm db:migrate).
export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/db/src/schema.ts',
  out: './packages/db/migrations',
  strict: true,
  verbose: true,
});
