// CLI entry: `pnpm db:seed` (tsx src/seed.ts)
import { sql } from 'drizzle-orm';
import { closeDb, createDb } from './client.js';
import { loadRootEnv } from './env.js';

loadRootEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[db:seed] DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

const db = createDb(url, { max: 1, applicationName: 'buddha-seed' });
try {
  // Connectivity check only. M1+ seeds the admin account (SEED_ADMIN_*) and demo markets
  // (PLAN Appendix B; never sports/elections).
  await db.execute(sql`select 1`);
  console.log('[db:seed] M0: schema is empty, nothing to seed');
} finally {
  await closeDb(db);
}
