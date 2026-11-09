import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settleMarketPositions } from './market-settlement.js';
import { positions, positionSettlements } from './schema/index.js';
import { createMarket, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { mintTestPairs } from './test/ledger.js';

describe('migration 0064 shape', () => {
  it('adds records without rewriting or backfilling existing rows', () => {
    const migration = readFileSync(
      new URL('../drizzle/0064_position_settlements.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('CREATE TABLE "position_settlements"');
    expect(migration).not.toMatch(/^\s*(?:UPDATE|DELETE FROM|TRUNCATE|INSERT INTO)\s/im);
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain("coalesce(NEW.judgement_version::text, 'legacy')");
  });
});

describe.skipIf(!hasTestDb())('permanent settlement records (0064, integration)', () => {
  let t: TestDb;
  let owner: Client;
  beforeAll(async () => {
    t = await connectTestDb();
    owner = new Client({ connectionString: testDbUrls()!.migrateUrl });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.end();
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  async function fixture() {
    const market = await createMarket(t.db, { status: 'settling', resolvedResult: 'YES' });
    const yes = (await createUser(t.db, { balanceCoin: 500n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 500n })).user.id;
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: yes, noHolderId: no, qty: 1 });
    const losing = {
      marketId: market.id,
      userId: no,
      outcome: 'NO' as const,
      result: 'YES' as const,
      judgementVersion: null,
      ruleVersion: null,
      qty: 1,
      costBasisCoin: 50n,
      realizedPnlBeforeCoin: 0n,
      payoutPerContractCoin: 0,
      payoutCoin: 0n,
      settlementPnlCoin: -50n,
      ledgerEntryId: null,
      settledAt: new Date(),
    };
    return { market, yes, no, losing };
  }

  it('requires retirement in the same commit even for a zero payout', async () => {
    const { market, losing } = await fixture();
    await expect(t.db.insert(positionSettlements).values(losing)).rejects.toThrow();
    expect(await t.db.select().from(positionSettlements)).toEqual([]);
    expect(await t.db.select().from(positions).where(eq(positions.marketId, market.id))).toEqual(
      expect.arrayContaining([expect.objectContaining({ qty: 1, settled: false })]),
    );
  });

  it('refuses a falsified holding snapshot, calculation, result and payout link', async () => {
    const { losing } = await fixture();
    for (const change of [
      { qty: 2 },
      { costBasisCoin: 49n },
      { realizedPnlBeforeCoin: 1n },
      { settlementPnlCoin: 0n },
      { payoutPerContractCoin: 50 },
      { result: 'VOID' as const },
      { payoutCoin: 1n },
      { ledgerEntryId: 12345 },
    ]) {
      await expect(
        t.db.insert(positionSettlements).values({ ...losing, ...change }),
      ).rejects.toThrow();
    }
    expect(await t.db.select().from(positionSettlements)).toEqual([]);
  });

  it('is immutable for the app and the owner, and admits no second judgement payment', async () => {
    const { market, no } = await fixture();
    await t.db.transaction((tx) => settleMarketPositions(tx, market.id));
    const where = and(
      eq(positionSettlements.marketId, market.id),
      eq(positionSettlements.userId, no),
    );
    const [record] = await t.db.select().from(positionSettlements).where(where);
    await expect(t.db.update(positionSettlements).set({ qty: 2 }).where(where)).rejects.toThrow();
    await expect(t.db.delete(positionSettlements).where(where)).rejects.toThrow();
    await expect(
      owner.query('UPDATE position_settlements SET qty = qty WHERE market_id = $1', [market.id]),
    ).rejects.toThrow('permanent');
    await expect(
      owner.query('DELETE FROM position_settlements WHERE market_id = $1', [market.id]),
    ).rejects.toThrow('permanent');
    await expect(t.db.insert(positionSettlements).values(record!)).rejects.toThrow();
    expect((await t.db.select().from(positionSettlements).where(where))[0]).toEqual(record);
  });
});
