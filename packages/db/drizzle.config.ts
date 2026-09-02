import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit does not read .env files by itself. Load the repo-root .env
// (packages/db/../../.env) so `drizzle-kit migrate|push|studio` see DATABASE_MIGRATE_URL.
// Existing process.env values always win over the file.
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  // Column names are derived from camelCase property names (amountP -> amount_p).
  // Must match the `casing` passed to drizzle() in src/client.ts.
  casing: 'snake_case',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'drizzle',
  },
  // DDL always runs as the migration role, never as buddha_app (PLAN 6.4).
  // The fallback keeps `drizzle-kit generate` (which never connects) working without a .env.
  dbCredentials: {
    url:
      process.env.DATABASE_MIGRATE_URL ?? 'postgres://buddha_migrate:buddha@localhost:5432/buddha',
  },
  // `strict`/`verbose` only affect `drizzle-kit push` (dev-only shortcut): print every
  // statement and ask for confirmation before applying.
  strict: true,
  verbose: true,
});
