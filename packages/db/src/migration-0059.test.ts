import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAccount, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** Migration 0059's statements, in order, read from the migration itself. */
function migrationStatements(): string[] {
  const migration = readFileSync(
    new URL('../drizzle/0059_account_types.sql', import.meta.url),
    'utf8',
  );
  const statements = migration
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
  expect(statements[0]).toContain('CREATE TYPE "public"."account_type"');
  return statements;
}

/** How many rows each table an account owns holds, in one read. */
const COUNTS = `SELECT (SELECT count(*) FROM "user")::int AS users,
  (SELECT count(*) FROM profiles)::int AS profiles,
  (SELECT count(*) FROM balances)::int AS balances,
  (SELECT count(*) FROM ledger_entries)::int AS entries`;

/**
 * Migration 0059 is additive (ADR-0107 결정 3: the deployed database is emptied by #116, not
 * here): every account already there becomes '일반 사용자' — an admin and a closed account too —
 * and no profile, balance or ledger entry changes, which a migration run against the empty test
 * database never shows. Recreated as it stood before 0059 — no type, no column, none of its
 * functions or triggers — in a transaction that is rolled back, as the migrate role (the owner),
 * and then the whole file is run on the accounts there.
 */
describe.skipIf(!hasTestDb())(
  'migration 0059: account types of existing accounts (integration)',
  () => {
    let t: TestDb;
    let migrate: Client;
    beforeAll(async () => {
      t = await connectTestDb();
      migrate = new Client({ connectionString: testDbUrls()!.migrateUrl });
      await migrate.connect();
    });
    afterAll(async () => {
      await migrate?.end();
      await t?.close(); // undefined when beforeAll timed out waiting for the file lock
    });
    beforeEach(async () => {
      await t.reset();
    });

    it('makes every account there 일반 사용자 and changes nothing else', async () => {
      const statements = migrationStatements();
      await createUser(t.db, { balanceCoin: 500n });
      await createUser(t.db, { role: 'admin' });
      const { user: closing } = await createUser(t.db);
      await closeAccount(t.db, closing.id);
      await migrate.query('BEGIN');
      try {
        // The schema before 0059. The trigger function keeps its new body until the file replaces
        // it; nothing inserts a user in between.
        await migrate.query('DROP FUNCTION refuse_operating_account_rows() CASCADE');
        await migrate.query('DROP FUNCTION user_keep_account_type() CASCADE');
        await migrate.query('DROP FUNCTION is_human_account(text)');
        await migrate.query('DROP TYPE account_type CASCADE');
        const { rows: columns } = await migrate.query(
          `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'user' AND column_name = 'account_type'`,
        );
        expect(columns).toEqual([]);
        const { rows: before } = await migrate.query(COUNTS);

        for (const statement of statements) await migrate.query(statement);

        const { rows: types } = await migrate.query<{ type: string; n: number }>(
          'SELECT account_type::text AS type, count(*)::int AS n FROM "user" GROUP BY 1',
        );
        expect(types).toEqual([{ type: 'member', n: 3 }]);
        expect((await migrate.query(COUNTS)).rows).toEqual(before);
      } finally {
        await migrate.query('ROLLBACK');
      }
    });
  },
);
