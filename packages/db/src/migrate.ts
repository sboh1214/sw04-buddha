// CLI entry: `pnpm db:migrate` (tsx src/migrate.ts)
import { loadRootEnv } from './env.js';
import { migrationsFolder, runMigrations } from './migrator.js';

loadRootEnv();

const url = process.env.DATABASE_MIGRATE_URL;
if (!url) {
  console.error('[db:migrate] DATABASE_MIGRATE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

console.log(`[db:migrate] applying migrations from ${migrationsFolder}`);
await runMigrations(url);
console.log('[db:migrate] done');
