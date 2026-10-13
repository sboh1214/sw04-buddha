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

describe('the wipe statement (#125, #149)', () => {
  it('is the first statement of migration 0017, verbatim', () => {
    // The #149 reset re-runs WIPE_PUBLIC_TABLES_SQL; it must be the very statement the deploy of
    // #125 ran once, and it must run before 0017 drops the enum values a row could still hold.
    const [first] = migrationSql('0017_remove_direct_amm').split(STATEMENT_BREAKPOINT);
    expect(withoutLeadingComments(first ?? '')).toBe(WIPE_PUBLIC_TABLES_SQL);
  });

  it('is what the #149 reset runs: deploy/reset-db.sh calls wipe-cli, which runs this constant', () => {
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
    await createUser(t.db);
    await createMarket(t.db);
    const before = await rowCounts();
    expect(before.user).toBeGreaterThan(0);
    expect(before.ledger_entries).toBeGreaterThan(0);
    const migrations = await appliedMigrations();
    expect(migrations).toBeGreaterThan(0);

    // As the migrate role, exactly as migration 0017 and the #149 reset run it.
    await migrate.query(WIPE_PUBLIC_TABLES_SQL);

    const after = await rowCounts();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [table, count] of Object.entries(after)) expect(count, table).toBe(0);
    // The migration journal lives in another schema and is left alone.
    expect(await appliedMigrations()).toBe(migrations);
    // RESTART IDENTITY: the next account's sign-up bonus is ledger row 1 again.
    const { user: u } = await createUser(t.db);
    const entries = await t.db.select().from(ledgerEntries);
    expect(entries).toEqual([expect.objectContaining({ id: 1, userId: u.id, type: 'BONUS' })]);
  });
});
