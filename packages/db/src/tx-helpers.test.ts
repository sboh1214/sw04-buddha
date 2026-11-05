import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { waitForLockWaiter } from './test/wait.js';
import { lockMarket, lockMarkets } from './tx-helpers.js';

/** The node-postgres SQLSTATE of a refusal, wrapped by drizzle or bare. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

describe.skipIf(!hasTestDb())('lockMarkets (#118, docker test profile)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });

  /** Each id's lock key, as `lockMarket` takes it. */
  const keysOf = async (ids: string[]) => {
    const { rows } = await t.db.execute<{ id: string; key: number }>(sql`
      SELECT m.id, hashtext(m.id::uuid::text) AS key
      FROM unnest(${`{${ids.join(',')}}`}::text[]) AS m(id)`);
    return new Map(rows.map((row) => [row.id, Number(row.key)]));
  };

  /** Whether some other transaction holds the market's lock right now (an autocommit probe). */
  const heldElsewhere = async (marketId: string) => {
    const { rows } = await t.db.execute<{ free: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${marketId}::uuid::text)) AS free`,
    );
    return !rows[0]!.free;
  };

  it('takes the keys in ascending key order, not id order (a shared 32-bit key cannot cross)', async () => {
    // Two markets whose id order and key order disagree: sorting the ids would take `high` first.
    let low = '';
    let high = '';
    while (!low) {
      const [a, b] = [randomUUID(), randomUUID()].sort();
      const keys = await keysOf([a!, b!]);
      if (keys.get(a!)! > keys.get(b!)!) [high, low] = [a!, b!];
    }
    expect(high < low).toBe(true);
    // Another transaction holds `high`'s key; the processing locks both, listed in id order and
    // with a repeat, so it takes `low` first and parks on `high` holding `low`. In id order it
    // would park on `high` holding nothing, and `low` would be free.
    const holder = await t.db.$client.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))', [high]);
      const processing = t.db.transaction(async (tx) => {
        await lockMarkets(tx, [high, low, high]);
        await lockMarket(tx, low);
      });
      await waitForLockWaiter(holder, 'the processing waits on the held key');
      expect(await heldElsewhere(low)).toBe(true);
      await holder.query('COMMIT');
      await processing;
    } finally {
      holder.release();
    }
    expect(await heldElsewhere(low)).toBe(false);
    expect(await heldElsewhere(high)).toBe(false);
  });

  it('does nothing for no market, and refuses a non-uuid (22P02)', async () => {
    await t.db.transaction((tx) => lockMarkets(tx, []));
    await expect(t.db.transaction((tx) => lockMarkets(tx, ['nope']))).rejects.toSatisfy(
      (error) => sqlState(error) === '22P02',
    );
  });
});
