// CLI entry: `pnpm --filter @buddha/db run db:wipe --yes` (tsx src/wipe-cli.ts), and on the
// deployed host `node packages/db/dist/wipe-cli.js --yes` inside the migrate container, which
// deploy/reset-db.sh runs (docs/RESET.md). Empties every table in schema `public`, accounts
// included, with WIPE_PUBLIC_TABLES_SQL: the statement migrations 0017 and 0048 ran once each
// (#125, #174). Run
// db:migrate and db:seed afterwards to refill the database.
import { sql } from 'drizzle-orm';
import { closeDb, createDb } from './client.js';
import { loadRootEnv } from './env.js';
import { WIPE_PUBLIC_TABLES_SQL } from './wipe.js';

loadRootEnv();

if (!process.argv.slice(2).includes('--yes')) {
  console.error(
    '[db:wipe] this empties every table in schema public, accounts included; pass --yes to run it',
  );
  process.exit(1);
}

// The migrate role: TRUNCATE is the table owner's privilege, which buddha_app does not hold.
const url = process.env.DATABASE_MIGRATE_URL;
if (!url) {
  console.error('[db:wipe] DATABASE_MIGRATE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

// Host and database only: the URL also carries the password.
const target = new URL(url);
console.log(`[db:wipe] emptying every table in schema public of ${target.host}${target.pathname}`);
const db = createDb(url, { max: 1, applicationName: 'buddha-wipe' });
try {
  await db.execute(sql.raw(WIPE_PUBLIC_TABLES_SQL));
} finally {
  await closeDb(db);
}
console.log('[db:wipe] done; run db:migrate and db:seed next');
