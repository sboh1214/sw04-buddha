// Config for the better-auth CLI only (`pnpm --filter @buddha/db run db:auth-schema`).
// It never connects: the CLI just introspects the options to emit src/schema/auth.ts.
// Keep the plugin / user.additionalFields list in sync with apps/api/src/auth/auth.ts,
// because only those affect the generated tables (providers and hooks do not).
// After regenerating: re-apply `{ withTimezone: true, mode: 'date', precision: 3 }` on every
// timestamp, delete the relations block, and add back account's unique (providerId, accountId),
// which the generator does not emit (ADR-0094; see src/schema/auth.ts header).
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';

export const auth = betterAuth({
  database: drizzleAdapter(drizzle.mock({ casing: 'snake_case' }), { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  // The mock holds no tables, so better-auth's schema check (1.7.3+) would log every table as
  // missing on each generate. The API's own instance keeps the check (ADR-0094).
  advanced: { database: { validateSchema: false } },
});
