import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerEntries } from './schema/index.js';
import { createMarket, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { WIPE_PUBLIC_TABLES_SQL } from './wipe.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

function migrationSql(tag: string): string {
  return readFileSync(new URL(`../drizzle/${tag}.sql`, import.meta.url), 'utf8');
}

/** A statement's SQL without the `--` comment lines a hand-edited migration opens with. */
function withoutLeadingComments(statement: string): string {
  const lines = statement.split(/\r?\n/);
  while (lines[0]?.startsWith('--')) lines.shift();
  return lines.join('\n').trim();
}

describe('the wipe statement (#125, #149, #174)', () => {
  it.each(['0017_remove_direct_amm', '0048_market_lifecycle'])(
    'is the first statement of migration %s, verbatim',
    (tag) => {
      // deploy/reset-db.sh re-runs WIPE_PUBLIC_TABLES_SQL; it must be the very statement the
      // deploys of #125 and #174 ran once each, and it must run before the migration drops the
      // enum values a row could still hold (0017 the AMM's, 0048 the `voided` status).
      const [first] = migrationSql(tag).split(STATEMENT_BREAKPOINT);
      expect(withoutLeadingComments(first ?? '')).toBe(WIPE_PUBLIC_TABLES_SQL);
    },
  );

  it('is what the reset script runs: deploy/reset-db.sh calls wipe-cli, which runs this constant', () => {
    // The script lives outside this package, so packages/db/turbo.json names it as an input of
    // `test`: a change to it alone must not replay a cached pass.
    const script = readFileSync(new URL('../../../deploy/reset-db.sh', import.meta.url), 'utf8');
    expect(script).toContain('node packages/db/dist/wipe-cli.js --yes');
    const cli = readFileSync(new URL('./wipe-cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('sql.raw(WIPE_PUBLIC_TABLES_SQL)');
  });

  it('names no table: the list is read from pg_tables when it runs', () => {
    expect(WIPE_PUBLIC_TABLES_SQL).toContain('FROM pg_tables');
    expect(WIPE_PUBLIC_TABLES_SQL).toContain("WHERE schemaname = 'public'");
    expect(WIPE_PUBLIC_TABLES_SQL).toContain('RESTART IDENTITY CASCADE');
    expect(WIPE_PUBLIC_TABLES_SQL).not.toMatch(/"(user|markets|ledger_entries)"/);
  });
});

describe.skipIf(!hasTestDb())('the wipe statement (integration, docker test profile)', () => {
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

  async function rowCounts(): Promise<Record<string, number>> {
    const { rows } = await t.db.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const counts: Record<string, number> = {};
    for (const { tablename } of rows) {
      const result = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(tablename)}`,
      );
      counts[tablename] = result.rows[0]?.n ?? -1;
    }
    return counts;
  }

  async function appliedMigrations(): Promise<number> {
    const { rows } = await migrate.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    return rows[0]?.n ?? -1;
  }

  it('empties every public table, accounts included, and restarts their sequences', async () => {
    // With Coin, so the ledger has a row to empty: a new account starts with none (#70).
    await createUser(t.db, { balanceCoin: 100n });
    await createMarket(t.db);
    const before = await rowCounts();
    expect(before.user).toBeGreaterThan(0);
    expect(before.ledger_entries).toBeGreaterThan(0);
    const migrations = await appliedMigrations();
    expect(migrations).toBeGreaterThan(0);

    // As the migrate role, exactly as migration 0017 and deploy/reset-db.sh run it.
    await migrate.query(WIPE_PUBLIC_TABLES_SQL);

    const after = await rowCounts();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [table, count] of Object.entries(after)) expect(count, table).toBe(0);
    // The migration journal lives in another schema and is left alone.
    expect(await appliedMigrations()).toBe(migrations);
    // RESTART IDENTITY: the next account's first ledger entry is row 1 again.
    const { user: u } = await createUser(t.db, { balanceCoin: 100n });
    const entries = await t.db.select().from(ledgerEntries);
    expect(entries).toEqual([
      expect.objectContaining({ id: 1, userId: u.id, type: 'ADMIN_ADJUST' }),
    ]);
  });
});
