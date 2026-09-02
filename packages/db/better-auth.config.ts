// Config for the better-auth CLI only (`pnpm --filter @buddha/db run db:auth-schema`).
// It never connects: the CLI just introspects the options to emit src/schema/auth.ts.
// Keep the plugin / user.additionalFields list in sync with apps/api/src/auth/auth.ts,
// because only those affect the generated tables (providers and hooks do not).
// After regenerating: re-apply `{ withTimezone: true, mode: 'date' }` on every timestamp and
// delete the relations block (see src/schema/auth.ts header).
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';

export const auth = betterAuth({
  database: drizzleAdapter(drizzle.mock({ casing: 'snake_case' }), { provider: 'pg' }),
  emailAndPassword: { enabled: true },
});
