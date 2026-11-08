import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMarket, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { createFillRecord } from './test/orders.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** Migration 0063's statements, in order, read from the migration itself. */
function migrationStatements(): string[] {
  const migration = readFileSync(
    new URL('../drizzle/0063_market_stats.sql', import.meta.url),
    'utf8',
  );
  return migration
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

/**
 * Migration 0063 (#121, ADR-0116) changes no row: the statistics start from the first fill, so its
 * first statement refuses a database that holds a fill or a market statistic already, rather than
 * recount it (a recount is an UPDATE: the owner's question, ADR-0107 결정 3). Run as the migrate
 * role (the owner) in a transaction that is rolled back, on the rows a test writes.
 */
describe.skipIf(!hasTestDb())('migration 0063: the market statistics’ guard (integration)', () => {
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

  /** The guard's outcome on the database as it is now: null when it passes, else its message. */
  async function guard(): Promise<string | null> {
    const [first] = migrationStatements();
    expect(first).toMatch(/^-- #121[\s\S]*DO \$\$/);
    await migrate.query('BEGIN');
    try {
      await migrate.query(first!);
      return null;
    } catch (error) {
      return (error as Error).message;
    } finally {
      await migrate.query('ROLLBACK');
    }
  }

  it('passes a database with markets and no fill or statistic, as the deployed one is', async () => {
    await createMarket(t.db);
    await createMarket(t.db, { status: 'draft' });
    expect(await guard()).toBeNull();
  });

  it('refuses a database with a fill, and changes nothing', async () => {
    const market = await createMarket(t.db);
    await createFillRecord(t.db, {
      marketId: market.id,
      incomingOwnerId: (await createUser(t.db)).user.id,
      restingOwnerId: (await createUser(t.db)).user.id,
    });
    expect(await guard()).toMatch(/^0063 starts the market statistics from the first fill/);
    expect((await migrate.query('SELECT count(*)::int AS n FROM fills')).rows).toEqual([{ n: 1 }]);
  });

  it('refuses a market with any statistic that is not its default', async () => {
    for (const stat of [
      { lastPrice: 52 },
      { volumeCoin: 1n },
      { tradeCount: 1 },
      { traderCount: 1 },
    ]) {
      await t.reset();
      await createMarket(t.db, stat);
      expect(
        await guard(),
        JSON.stringify(stat, (_, v: unknown) => String(v)),
      ).toMatch(/no fill and no statistic may exist yet/);
    }
  });
});
