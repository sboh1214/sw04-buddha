import { readFileSync } from 'node:fs';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settleMarketPositions } from './market-settlement.js';
import { fillRealizations, markets, positions } from './schema/index.js';
import { positionOf } from './test/contracts.js';
import { createMarket, createMarketMakerAccount, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { mintTestPairs } from './test/ledger.js';
import { createFillRecord, openOrderIntake, placeTestOrder } from './test/orders.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** The bound on `count(fills)` above which the backfill leaves everything out, as written. */
const SIZE_BOUND = '20000';

const MIGRATION = readFileSync(
  new URL('../drizzle/0076_fill_realizations.sql', import.meta.url),
  'utf8',
);

/**
 * What docs/OPERATIONS.md gives operators to run after the deploy (ADR-0143 결정 10): the
 * backfill raises nothing and logs nothing, so these read what it left out. (a) counts the trade
 * fills a member sold and those of them with no record; (b) lists the latter per position.
 */
const UNRECORDED_SALES_SQL = `SELECT count(*) AS human_sells, count(*) FILTER (WHERE fr.fill_id IS NULL) AS without_record
FROM fills f LEFT JOIN fill_realizations fr ON fr.fill_id = f.id
WHERE f.kind = 'trade'
  AND CASE WHEN f.side = 'sell' THEN f.incoming_account_type ELSE f.resting_account_type END = 'member';
`;
const UNRECORDED_POSITIONS_SQL = `SELECT CASE WHEN f.side = 'sell' THEN f.incoming_owner_id ELSE f.resting_owner_id END AS user_id,
       f.market_id, f.outcome, count(*) AS sells_without_record
FROM fills f LEFT JOIN fill_realizations fr ON fr.fill_id = f.id
WHERE f.kind = 'trade' AND fr.fill_id IS NULL
  AND CASE WHEN f.side = 'sell' THEN f.incoming_account_type ELSE f.resting_account_type END = 'member'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
`;

/** Migration 0076's statements, in order, read from the migration itself. */
function migrationStatements(): string[] {
  return MIGRATION.split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

/** A statement without its `--` comment lines: what it runs. */
const codeOf = (statement: string) =>
  statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

/**
 * The query the backfill's loop reads — the events and, joined to them, the books each position
 * is held against — cut out of the DO block between `FOR ev IN` and `LOOP`.
 */
function backfillEventsQuery(): string {
  const found = /\n {2}FOR ev IN\n([\s\S]+?)\n {2}LOOP\n/.exec(
    codeOf(migrationStatements().at(-1)!),
  );
  if (!found) throw new Error('the backfill has no `FOR ev IN … LOOP`');
  return found[1]!;
}

/**
 * Migration 0076 (#124, ADR-0143) adds and fills, and changes no row that was there: a new table,
 * its guards, an index, and rows of the new table alone. Read statement by statement — a word
 * search for UPDATE or DELETE would trip on `BEFORE UPDATE OR DELETE ON`, `REVOKE UPDATE, DELETE`
 * and `TG_OP` of the same file.
 */
describe('migration 0076 shape (static)', () => {
  const statements = migrationStatements();

  it('is a table, its key, an index, two guards, a REVOKE and the backfill last', () => {
    const leading = statements.map(
      (statement) => /^[A-Z]+(?: (?:TABLE|INDEX|FUNCTION|TRIGGER))?/.exec(codeOf(statement))?.[0],
    );
    expect(leading).toEqual([
      'CREATE TABLE',
      'ALTER TABLE',
      'CREATE INDEX',
      'CREATE FUNCTION',
      'CREATE TRIGGER',
      'CREATE FUNCTION',
      'CREATE TRIGGER',
      'REVOKE',
      'DO',
    ]);
    expect(codeOf(statements[0]!)).toMatch(/^CREATE TABLE "fill_realizations" \(/);
    expect(codeOf(statements[2]!)).toBe(
      'CREATE INDEX "position_settlements_user_id_settled_at_idx" ON "position_settlements" ' +
        'USING btree ("user_id","settled_at" desc,"market_id" desc);',
    );
    expect(codeOf(statements[7]!)).toBe(
      'REVOKE UPDATE, DELETE ON TABLE "fill_realizations" FROM buddha_app;',
    );
    // Nothing is granted back: the default privileges leave INSERT and SELECT.
    expect(MIGRATION).not.toMatch(/\bGRANT\b/i);
  });

  it('holds no statement that changes or removes an existing row or object', () => {
    const forbidden: [string, RegExp][] = [
      [
        'UPDATE … SET',
        /\bUPDATE\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?\w+"?(?:\s+(?:AS\s+)?"?\w+"?)?\s+SET\b/i,
      ],
      ['DO UPDATE', /\bDO\s+UPDATE\b/i],
      ['DELETE FROM', /\bDELETE\s+FROM\b/i],
      ['MERGE', /\bMERGE\s+INTO\b/i],
      ['TRUNCATE', /\bTRUNCATE\b/i],
      ['DROP', /\bDROP\b/i],
      // Dynamic SQL could hide any of the above; `EXECUTE FUNCTION` is a trigger's own clause.
      ['EXECUTE', /\bEXECUTE\b(?!\s+FUNCTION\b)/i],
    ];
    const hits = statements.flatMap((statement, index) => [
      ...forbidden
        .filter(([, pattern]) => pattern.test(statement))
        .map(([name]) => `statement ${String(index)}: ${name}`),
      ...[...statement.matchAll(/\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?(\w+)"?/gi)]
        .filter((match) => match[1] !== 'fill_realizations')
        .map((match) => `statement ${String(index)}: ALTER TABLE ${match[1]!}`),
      ...[...statement.matchAll(/\bINSERT\s+INTO\s+(?:"?public"?\.)?"?(\w+)"?/gi)]
        .filter((match) => match[1] !== 'fill_realizations')
        .map((match) => `statement ${String(index)}: INSERT INTO ${match[1]!}`),
    ]);
    expect(hits).toEqual([]);
    // The patterns do catch what they are for, and pass what this file legitimately says.
    const caught = (text: string) => forbidden.some(([, pattern]) => pattern.test(text));
    for (const text of [
      'UPDATE fills SET qty = 1',
      'update "positions" p set qty = 0',
      'UPDATE ONLY orders AS o SET status = $1',
      'UPDATE public.fills SET qty = 1',
      'update "public"."positions" AS p set qty = 0',
      'INSERT INTO x VALUES (1) ON CONFLICT (id) DO UPDATE SET y = 1',
      'DELETE FROM position_settlements',
      'TRUNCATE fills',
      'DROP TRIGGER fills_keep_record ON fills',
      "EXECUTE 'DELETE ' || 'FROM fills'",
      'EXECUTE format($f$UPDATE %I SET x = 1$f$, t)',
    ]) {
      expect(caught(text), text).toBe(true);
    }
    for (const text of [
      'BEFORE UPDATE OR DELETE ON "fill_realizations"',
      'REVOKE UPDATE, DELETE ON TABLE "fill_realizations" FROM buddha_app;',
      'FOR EACH ROW EXECUTE FUNCTION fill_realizations_check();',
      'LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$',
      "RAISE EXCEPTION 'takes no %', TG_OP",
      'ON CONFLICT (fill_id) DO NOTHING;',
    ]) {
      expect(caught(text), text).toBe(false);
    }
  });

  it('backfills in one DO block that reads by fill id, keeps recorded fills and raises nothing', () => {
    const backfill = codeOf(statements.at(-1)!);
    expect(backfill).toMatch(/^DO \$\$/);
    expect(backfill).toMatch(/END;\n\$\$;$/);
    // Members' sides only, by the account type the fill copied — no join to the accounts.
    expect(backfill).toContain("WHERE e.account_type = 'member'");
    expect(backfill).not.toMatch(/"user"|\bprofiles\b/);
    // Per position in fill id order (an intake's fills share an instant, never an id).
    expect(backfill).toContain('ORDER BY e.owner_id, f.market_id, e.contract, f.id');
    expect(backfill).not.toMatch(/created_at/);
    // The half-up rounding of packages/shared accounting.ts `applySell`.
    expect(backfill).toContain('freed := (basis * ev.qty::bigint + held / 2) / held;');
    // The books it is held against, in the events' own query: one snapshot, no explicit lock.
    expect(backfill).toMatch(/LEFT JOIN positions p\b/);
    expect(backfill).toMatch(/LEFT JOIN position_settlements s\b/);
    expect(backfill).not.toMatch(/\bLOCK\s+TABLE\b|\bFOR\s+(?:UPDATE|SHARE)\b/i);
    // One loop over one query, which is plain SQL: it names no variable of the block, so the
    // snapshot test below can open it as a cursor of its own.
    expect(backfill.match(/\bFOR\s+\w+\s+IN\b/g)).toEqual(['FOR ev IN']);
    const events = backfillEventsQuery();
    expect(events).toMatch(/^\s*SELECT e\.owner_id\b/);
    expect(events).toMatch(/ORDER BY e\.owner_id, f\.market_id, e\.contract, f\.id$/);
    expect(events).not.toMatch(/\bev\.|\b(?:held|basis|gained|freed|sound|sold_\w+|want_\w+)\b/);
    // Re-runnable as it stands, and never a reason for a deploy to stop.
    expect(backfill).toContain('ON CONFLICT (fill_id) DO NOTHING;');
    expect(backfill).not.toMatch(/\bRAISE\b/i);
    expect(backfill).not.toMatch(/\bcurrent_setting\b|\bset_config\b/i);
  });

  it('is checked afterwards by the two queries docs/OPERATIONS.md carries, word for word', () => {
    const doc = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');
    const start = doc.indexOf('## 체결별 손익 기록 (#124, ADR-0143)');
    expect(start).toBeGreaterThan(0);
    const rest = doc.slice(start + 3);
    const end = rest.indexOf('\n## ');
    const section = end === -1 ? rest : rest.slice(0, end);
    const queries = [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(queries).toEqual([UNRECORDED_SALES_SQL, UNRECORDED_POSITIONS_SQL]);
    // And it names the bound the backfill is written with (20000 reads '20,000건').
    expect(section).toContain(`${SIZE_BOUND.replace(/\B(?=(?:\d{3})+$)/g, ',')}건`);
    // The migration's own comment sends the reader there.
    expect(statements.at(-1)).toContain('docs/OPERATIONS.md');
  });

  it('bounds the backfill by the number of fills, with one literal', () => {
    // The size test below lowers the bound by replacing this text, so it must name one place.
    expect(MIGRATION.split(SIZE_BOUND)).toHaveLength(2);
    expect(codeOf(statements.at(-1)!)).toContain(
      `IF (SELECT count(*) FROM fills) > ${SIZE_BOUND} THEN\n    RETURN;\n  END IF;`,
    );
  });
});

/** The constraint a refused write names: a CHECK, the key, or the trigger that raised it. */
function sqlConstraint(error: unknown): string | undefined {
  const e = error as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.cause?.constraint ?? e?.constraint;
}

/** What a `fill_realizations` row holds, as the raw client reads it (bigints as strings). */
interface RealizationRow {
  fill_id: string;
  proceeds_coin: string;
  cost_released_coin: string;
  realized_pnl_coin: string;
}

const REALIZATIONS = `SELECT fill_id, proceeds_coin, cost_released_coin, realized_pnl_coin
  FROM fill_realizations ORDER BY fill_id`;

/** The tables the backfill reads or sits beside: no row of them may change. */
const UNTOUCHED = {
  fills: 'SELECT * FROM fills ORDER BY id',
  positions: 'SELECT * FROM positions ORDER BY user_id, market_id, outcome',
  position_settlements: 'SELECT * FROM position_settlements ORDER BY market_id, user_id, outcome',
  orders: 'SELECT * FROM orders ORDER BY id',
  ledger_entries: 'SELECT * FROM ledger_entries ORDER BY id',
} as const;

/**
 * The backfill of migration 0076 against what the intake itself recorded (#124, ADR-0143): the
 * fixtures are traded through the real intake, whose `fill_realizations` rows are the oracle;
 * then — as the migrate role, in a transaction that is rolled back — the table, its two guard
 * functions and the new index are removed, the whole file is run on the fills there, and the
 * rows it wrote must be the oracle's, with every other table as it was. Removing the table
 * alone would leave the index and the functions for the file's CREATEs to collide with.
 */
describe.skipIf(!hasTestDb())('migration 0076: fill realizations (integration)', () => {
  let t: TestDb;
  let migrate: Client;
  let adminId: string;

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
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
  });

  const member = async (coin = 1_000n) => (await createUser(t.db, { balanceCoin: coin })).user.id;
  const openMarket = async () => (await createMarket(t.db, { createdBy: adminId })).id;

  /** An order through the real intake that must be taken. */
  async function order(input: Parameters<typeof placeTestOrder>[1]) {
    const result = await placeTestOrder(t.db, input);
    if (result.kind !== 'placed') throw new Error(`expected a placed order, got ${result.kind}`);
    return result;
  }
  /** `ownerId`'s immediate sell of `qty`, which must fill whole; its fills' ids in order. */
  async function sellNow(
    ownerId: string,
    marketId: string,
    qty: number,
    limitPriceCoin: number,
    outcome: 'YES' | 'NO' = 'YES',
  ): Promise<string[]> {
    const sold = await order({
      ownerId,
      marketId,
      outcome,
      side: 'sell',
      timeInForce: 'ioc',
      limitPriceCoin,
      qty,
    });
    expect(sold.order).toMatchObject({ status: 'filled', filledQty: qty });
    return sold.fills.map((fill) => String(fill.id));
  }
  const bid = (
    ownerId: string,
    marketId: string,
    limitPriceCoin: number,
    qty: number,
    outcome: 'YES' | 'NO' = 'YES',
  ) => order({ ownerId, marketId, outcome, limitPriceCoin, qty });

  const read = async <Row extends object>(text: string): Promise<Row[]> =>
    (await migrate.query<Row>(text)).rows;
  const untouched = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(UNTOUCHED).map(
          async ([table, text]) => [table, await read(text)] as [string, object[]],
        ),
      ),
    );

  /**
   * Runs `inside` on a database where 0076 has not run yet, with the file's statements to run,
   * as the migrate role in a transaction that is rolled back. Every read inside goes through the
   * same connection: another one would wait for the table this transaction holds.
   */
  async function beforeMigration<T>(inside: (statements: string[]) => Promise<T>): Promise<T> {
    await migrate.query('BEGIN');
    try {
      await migrate.query('DROP TABLE fill_realizations');
      await migrate.query('DROP FUNCTION fill_realizations_check()');
      await migrate.query('DROP FUNCTION fill_realizations_keep_record()');
      await migrate.query('DROP INDEX position_settlements_user_id_settled_at_idx');
      return await inside(migrationStatements());
    } finally {
      await migrate.query('ROLLBACK');
    }
  }
  /** The rows the whole migration writes on the fills there now. */
  const backfilled = () =>
    beforeMigration(async (statements) => {
      for (const statement of statements) await migrate.query(statement);
      return read<RealizationRow>(REALIZATIONS);
    });

  const row = (fillId: string, proceeds: number, cost: number): RealizationRow => ({
    fill_id: fillId,
    proceeds_coin: String(proceeds),
    cost_released_coin: String(cost),
    realized_pnl_coin: String(proceeds - cost),
  });

  it('writes what the intake recorded for unsettled positions: rounding, price levels, both sides, a NO sale, a holding bought by trades and a pair minted by a NO buy', async () => {
    const market = await openMarket();
    const buyer = await member(5_000n);
    const noHolder = await member(5_000n);

    // Three price levels in one sell: 3 YES for 100 (34 + 2 × 33) sold at 40, 39 and 38 — the
    // cost released is 33, then round(67 / 2) = 34, then the 33 left.
    const levels = await member();
    await mintTestPairs(t.db, {
      marketId: market,
      yesHolderId: levels,
      noHolderId: noHolder,
      qty: 1,
      yesPriceCoin: 34,
    });
    await mintTestPairs(t.db, {
      marketId: market,
      yesHolderId: levels,
      noHolderId: noHolder,
      qty: 2,
      yesPriceCoin: 33,
    });
    for (const price of [40, 39, 38]) await bid(buyer, market, price, 1);
    // Narrowed to the best bid 40 − 5 ticks: it walks 40, 39 and 38.
    const levelFills = await sellNow(levels, market, 3, 30);
    expect(levelFills).toHaveLength(3);

    // 7 YES for 340 (4 × 55 + 3 × 40): 2 sold at 60 release round(340 × 2 / 7) = 97, then 3 of
    // the 5 left at 45 release round(243 × 3 / 5) = 146 — and 2 are still held for 97.
    const seven = await member();
    await mintTestPairs(t.db, {
      marketId: market,
      yesHolderId: seven,
      noHolderId: noHolder,
      qty: 4,
      yesPriceCoin: 55,
    });
    await mintTestPairs(t.db, {
      marketId: market,
      yesHolderId: seven,
      noHolderId: noHolder,
      qty: 3,
      yesPriceCoin: 40,
    });
    await bid(buyer, market, 60, 2);
    const [firstSale] = await sellNow(seven, market, 2, 60);
    await bid(buyer, market, 45, 3);
    const [secondSale] = await sellNow(seven, market, 3, 45);

    // A resting sell that is met: the seller is the fill's resting side (the fill is a buy).
    const resting = await member();
    await mintTestPairs(t.db, {
      marketId: market,
      yesHolderId: resting,
      noHolderId: noHolder,
      qty: 2,
    });
    await order({ ownerId: resting, marketId: market, side: 'sell', limitPriceCoin: 70, qty: 1 });
    const taken = await order({
      ownerId: buyer,
      marketId: market,
      timeInForce: 'ioc',
      limitPriceCoin: 70,
      qty: 1,
    });
    expect(taken.fills.map((fill) => [fill.kind, fill.side])).toEqual([['trade', 'buy']]);
    const restingSale = String(taken.fills[0]!.id);

    // A NO sale: the NO holder's cost is the pair mints' other leg — 66 + 2 × 67 + 4 × 45 +
    // 3 × 60 + 2 × 50 = 660 for 12 — and one sold at 50 releases 660 / 12 = 55.
    expect(await positionOf(t.db, noHolder, market, 'NO')).toMatchObject({
      qty: 12,
      costBasisCoin: 660n,
    });
    await bid(buyer, market, 50, 1, 'NO');
    const [noSale] = await sellNow(noHolder, market, 1, 50, 'NO');

    // A sale by a holder whose every contract came through trades: `buyer` holds 9 YES for 442 —
    // as the resting buyer of the sells above (40 + 39 + 38, 2 × 60, 3 × 45) and as the incoming
    // buyer of the resting sell (70) — and one sold at 48 releases round(442 / 9) = 49.
    const taker = await member();
    expect(await positionOf(t.db, buyer, market, 'YES')).toMatchObject({
      qty: 9,
      costBasisCoin: 442n,
    });
    await bid(taker, market, 48, 1);
    const [buyerSale] = await sellNow(buyer, market, 1, 48);

    // A pair minted by an incoming NO buy: the fill is the NO side's at 70, and the resting YES
    // bid of 30 holds the other contract at 100 − 70. Each side then sells one of its two.
    const pairYes = await member();
    const pairNo = await member();
    await bid(pairYes, market, 30, 2);
    const minted = await order({
      ownerId: pairNo,
      marketId: market,
      outcome: 'NO',
      timeInForce: 'ioc',
      limitPriceCoin: 70,
      qty: 2,
    });
    expect(
      minted.fills.map((fill) => [fill.kind, fill.outcome, fill.priceCoin, fill.amountCoin]),
    ).toEqual([['pair_mint', 'NO', 70, 140n]]);
    await bid(taker, market, 65, 1, 'NO');
    const [pairNoSale] = await sellNow(pairNo, market, 1, 65, 'NO');
    await bid(taker, market, 35, 1);
    const [pairYesSale] = await sellNow(pairYes, market, 1, 35);

    const expected = [
      row(levelFills[0]!, 40, 33),
      row(levelFills[1]!, 39, 34),
      row(levelFills[2]!, 38, 33),
      row(firstSale!, 120, 97),
      row(secondSale!, 135, 146),
      row(restingSale, 70, 50),
      row(noSale!, 50, 55),
      row(buyerSale!, 48, 49),
      row(pairNoSale!, 65, 70),
      row(pairYesSale!, 35, 30),
    ];
    // The oracle: what the intake wrote, which is also what the arithmetic above says.
    const oracle = await read<RealizationRow>(REALIZATIONS);
    expect(oracle).toEqual(expected);
    // Each position's records add up to what it realised (the invariant's scope: a member's
    // position whose every sale has a record).
    expect(await positionOf(t.db, levels, market, 'YES')).toMatchObject({
      qty: 0,
      costBasisCoin: 0n,
      realizedPnlCoin: 17n,
    });
    expect(await positionOf(t.db, seven, market, 'YES')).toMatchObject({
      qty: 2,
      costBasisCoin: 97n,
      realizedPnlCoin: 12n,
    });
    expect(await positionOf(t.db, buyer, market, 'YES')).toMatchObject({
      qty: 8,
      costBasisCoin: 393n,
      realizedPnlCoin: -1n,
    });

    const before = await untouched();
    const after = await beforeMigration(async (statements) => {
      for (const statement of statements) await migrate.query(statement);
      return { rows: await read<RealizationRow>(REALIZATIONS), tables: await untouched() };
    });
    expect(after.rows).toEqual(oracle);
    expect(after.tables).toEqual(before);
    // Rolled back: the live table is as the intake left it.
    expect(await read<RealizationRow>(REALIZATIONS)).toEqual(oracle);
  });

  it('writes the sales of settled positions — YES, NO and VOID, with a record and sold out before', async () => {
    // One bundle per result: a holder who sells 1 of 3 and is settled holding 2 (a settlement
    // record, held against its quantity, cost and realised P&L before), and a holder who sells
    // its only contract before settlement (no record: 0, 0 and the position's realised P&L).
    const expected: RealizationRow[] = [];
    const settledMarkets: string[] = [];
    for (const result of ['YES', 'NO', 'VOID'] as const) {
      const market = await openMarket();
      const buyer = await member();
      const noHolder = await member();
      const holder = await member();
      const soldOut = await member();
      await mintTestPairs(t.db, {
        marketId: market,
        yesHolderId: holder,
        noHolderId: noHolder,
        qty: 3,
        yesPriceCoin: 60,
      });
      await mintTestPairs(t.db, {
        marketId: market,
        yesHolderId: soldOut,
        noHolderId: noHolder,
        qty: 1,
      });
      await bid(buyer, market, 55, 2);
      const [partial] = await sellNow(holder, market, 1, 55);
      const [whole] = await sellNow(soldOut, market, 1, 55);
      expected.push(row(partial!, 55, 60), row(whole!, 55, 50));
      await t.db
        .update(markets)
        .set({ status: 'settling', resolvedResult: result })
        .where(eq(markets.id, market));
      const settled = await t.db.transaction((tx) => settleMarketPositions(tx, market));
      // Four rows are closed; the holder, the buyer and the NO holder are recorded, and the
      // sold-out row, with nothing held, is not.
      expect(settled.positions).toBe(4);
      expect(
        await read<{ n: number }>(
          `SELECT count(*)::int AS n FROM position_settlements WHERE market_id = '${market}'`,
        ),
      ).toEqual([{ n: 3 }]);
      expect(await positionOf(t.db, soldOut, market, 'YES')).toMatchObject({
        qty: 0,
        settled: true,
        realizedPnlCoin: 5n,
      });
      settledMarkets.push(market);
    }
    const records = await read<{ qty: number; cost_basis_coin: string; before: string }>(
      `SELECT s.qty, s.cost_basis_coin, s.realized_pnl_before_coin AS before
       FROM position_settlements s JOIN fills f ON f.market_id = s.market_id
         AND f.kind = 'trade' AND f.incoming_owner_id = s.user_id
       WHERE s.outcome = 'YES' ORDER BY f.id`,
    );
    // The partial sellers' records: 2 held for 120, −5 realised before settlement.
    expect(records).toEqual(
      settledMarkets.map(() => ({ qty: 2, cost_basis_coin: '120', before: '-5' })),
    );

    const oracle = await read<RealizationRow>(REALIZATIONS);
    expect(oracle).toEqual(expected);
    const before = await untouched();
    const after = await beforeMigration(async (statements) => {
      for (const statement of statements) await migrate.query(statement);
      return { rows: await read<RealizationRow>(REALIZATIONS), tables: await untouched() };
    });
    expect(after.rows).toEqual(oracle);
    expect(after.tables).toEqual(before);
  });

  /** Two members who each sold one of two YES (cost 100) at 60 on `market`; their fills. */
  async function twoSellers(market: string) {
    const buyer = await member();
    const noHolder = await member();
    const sellers = [await member(), await member()] as const;
    const fills: string[] = [];
    for (const seller of sellers) {
      await mintTestPairs(t.db, {
        marketId: market,
        yesHolderId: seller,
        noHolderId: noHolder,
        qty: 2,
      });
      await bid(buyer, market, 60, 1);
      fills.push(...(await sellNow(seller, market, 1, 60)));
    }
    return { sellers, fills: fills as [string, string], buyer, noHolder };
  }

  it('leaves out a position that does not add up, a sale with no holding behind it and the 운영 마켓메이커’s', async () => {
    const market = await openMarket();
    const { sellers, fills } = await twoSellers(market);
    // The second seller's realised P&L is off by one Coin: none of its sales is trusted.
    await t.db
      .update(positions)
      .set({ realizedPnlCoin: sql`${positions.realizedPnlCoin} + 1` })
      .where(and(eq(positions.userId, sellers[1]), eq(positions.marketId, market)));
    // Fills written straight to the table, with no position behind them: a member's sale to a
    // member (more sold than the replay holds, and no row to hold it against), and a sale by
    // the 운영 마켓메이커 (no member on the selling side).
    const stray = await createFillRecord(t.db, {
      marketId: market,
      incomingOwnerId: await member(),
      restingOwnerId: await member(),
      side: 'sell',
      priceCoin: 41,
    });
    const marketMaker = await createMarketMakerAccount(t.db);
    const botSale = await createFillRecord(t.db, {
      marketId: market,
      incomingOwnerId: await member(),
      restingOwnerId: marketMaker,
      side: 'buy',
      kind: 'trade',
      priceCoin: 42,
    });
    expect(botSale.fill).toMatchObject({ kind: 'trade', restingAccountType: 'market_maker' });

    // The intake recorded both real sales; the backfill keeps the one whose position agrees.
    expect(await read<RealizationRow>(REALIZATIONS)).toEqual([
      row(fills[0], 60, 50),
      row(fills[1], 60, 50),
    ]);
    const before = await untouched();
    const after = await beforeMigration(async (statements) => {
      for (const statement of statements) await migrate.query(statement);
      return {
        rows: await read<RealizationRow>(REALIZATIONS),
        tables: await untouched(),
        check: await read(UNRECORDED_SALES_SQL),
        positions: await read<{
          user_id: string;
          market_id: string;
          outcome: string;
          sells_without_record: string;
        }>(UNRECORDED_POSITIONS_SQL),
      };
    });
    expect(after.rows).toEqual([row(fills[0], 60, 50)]);
    expect(after.rows.map((made) => made.fill_id)).not.toContain(String(stray.fill.id));
    expect(after.rows.map((made) => made.fill_id)).not.toContain(String(botSale.fill.id));
    expect(after.tables).toEqual(before);
    // The operators' check after the deploy says what was left out: of the three trade fills a
    // member sold (the bot's sale is not one), two have no record — the position that does not
    // add up and the sale with no holding, each named by its position.
    expect(after.check).toEqual([{ human_sells: '3', without_record: '2' }]);
    // (The database orders the accounts by its collation: compared here as a set.)
    const byAccount = (x: string[], y: string[]) => (x[0]! < y[0]! ? -1 : 1);
    expect(
      after.positions
        .map((left) => [left.user_id, left.market_id, left.outcome, left.sells_without_record])
        .sort(byAccount),
    ).toEqual(
      [
        [sellers[1], market, 'YES', '1'],
        [stray.incoming.userId, market, 'YES', '1'],
      ].sort(byAccount),
    );
    // On the live table, where the intake recorded both real sales, only the stray one is left.
    expect(await read(UNRECORDED_SALES_SQL)).toEqual([{ human_sells: '3', without_record: '1' }]);
  });

  it('leaves out a position settled with a holding and no record, as before migration 0064', async () => {
    // A settled row with nothing held and no settlement record is held against 0 contracts: a
    // replay that ends holding one (it was settled before records existed) does not agree.
    const market = await openMarket();
    const { sellers, fills } = await twoSellers(market);
    await t.db
      .update(positions)
      .set({ qty: 0, costBasisCoin: 0n, settled: true })
      .where(and(eq(positions.userId, sellers[1]), eq(positions.marketId, market)));
    expect(await backfilled()).toEqual([row(fills[0], 60, 50)]);
  });

  it('reads the events and the books they are held against as one snapshot, whatever is traded meanwhile', async () => {
    // plpgsql's `FOR … IN SELECT` reads its query through a portal, whose snapshot is taken when
    // it is opened. The DO block has no place to trade between two of its rows, so the loop's own
    // query is opened here as a cursor — the same portal, with other statements of a READ
    // COMMITTED transaction between its fetches — and a sale is committed after its first row.
    const market = await openMarket();
    const { sellers, buyer } = await twoSellers(market);
    const events = backfillEventsQuery();
    interface EventRow {
      owner_id: string;
      contract: string;
      fill_id: string;
      sells: boolean;
      qty: string;
      coin: string;
      position_qty: string;
      position_cost: string;
      position_pnl: string;
    }
    /** The first seller's YES position, as a set of event rows reads it. */
    const ofFirstSeller = (rows: EventRow[]) =>
      rows
        .filter((event) => event.owner_id === sellers[0] && event.contract === 'YES')
        .map((event) => [
          event.sells,
          String(event.qty),
          String(event.coin),
          String(event.position_qty),
          String(event.position_cost),
          String(event.position_pnl),
        ]);
    await migrate.query('BEGIN');
    try {
      await migrate.query(`DECLARE backfill_events NO SCROLL CURSOR FOR ${events}`);
      const first = await read<EventRow>('FETCH 1 FROM backfill_events');
      expect(first).toHaveLength(1);
      // Meanwhile the first seller sells its other contract: a fifth fill, and its position
      // goes from 1 held for 50 with +10 realised to none held with +20.
      await bid(buyer, market, 60, 1);
      const [late] = await sellNow(sellers[0], market, 1, 60);
      const rest = await read<EventRow>('FETCH ALL FROM backfill_events');
      const snapshot = [...first, ...rest];
      // Four fills, two members each. Neither the new fill nor what it did to the position is
      // read: the replay (2 bought for 100, 1 sold for 60) and the books still agree.
      expect(snapshot).toHaveLength(8);
      expect(snapshot.map((event) => String(event.fill_id))).not.toContain(late);
      expect(ofFirstSeller(snapshot)).toEqual([
        [false, '2', '100', '1', '50', '10'],
        [true, '1', '60', '1', '50', '10'],
      ]);
      // The same query as the transaction's next statement does see the sale — which is why
      // the books are joined into the events' query and not read by a statement of their own.
      const now = await read<EventRow>(events);
      expect(now).toHaveLength(10);
      expect(now.map((event) => String(event.fill_id))).toContain(late);
      expect(ofFirstSeller(now)).toEqual([
        [false, '2', '100', '0', '0', '20'],
        [true, '1', '60', '0', '0', '20'],
        [true, '1', '60', '0', '0', '20'],
      ]);
    } finally {
      await migrate.query('ROLLBACK');
    }
  });

  it('can be run again as it stands: the recorded fills are kept and none is added', async () => {
    const market = await openMarket();
    const { fills } = await twoSellers(market);
    const expected = [row(fills[0], 60, 50), row(fills[1], 60, 50)];
    const twice = await beforeMigration(async (statements) => {
      for (const statement of statements) await migrate.query(statement);
      const once = await read<RealizationRow>(REALIZATIONS);
      await migrate.query(statements.at(-1)!);
      return { once, again: await read<RealizationRow>(REALIZATIONS) };
    });
    expect(twice.once).toEqual(expected);
    expect(twice.again).toEqual(expected);
    // And on the live table, where the intake's rows are already: nothing changes, nothing fails
    // (a conflict is skipped, so the record guard that refuses every UPDATE is never asked).
    await migrate.query(migrationStatements().at(-1)!);
    expect(await read<RealizationRow>(REALIZATIONS)).toEqual(expected);
  });

  it('writes nothing and fails nothing when the fills outnumber the bound', async () => {
    const market = await openMarket();
    await twoSellers(market);
    const rows = await beforeMigration(async (statements) => {
      const backfill = statements.at(-1)!;
      // Lowered in the text itself — the bound is one literal and no hidden setting.
      expect(backfill.split(SIZE_BOUND)).toHaveLength(2);
      const lowered = backfill.replace(SIZE_BOUND, '3');
      for (const statement of statements.slice(0, -1)) await migrate.query(statement);
      expect((await read<{ n: number }>('SELECT count(*)::int AS n FROM fills'))[0]!.n).toBe(4);
      await migrate.query(lowered);
      const skipped = await read<RealizationRow>(REALIZATIONS);
      // At the bound it runs: the comparison is `>`.
      await migrate.query(backfill.replace(SIZE_BOUND, '4'));
      return { skipped, atBound: await read<RealizationRow>(REALIZATIONS) };
    });
    expect(rows.skipped).toEqual([]);
    expect(rows.atBound).toHaveLength(2);
  });

  describe('the table’s guards', () => {
    /** A member's sale to a member, written to `fills` alone: 2 YES at 30, amount 60. */
    async function sale() {
      const market = await openMarket();
      const { fill } = await createFillRecord(t.db, {
        marketId: market,
        incomingOwnerId: await member(),
        restingOwnerId: await member(),
        side: 'sell',
        priceCoin: 30,
        qty: 2,
      });
      return { market, fillId: fill.id };
    }
    const values = (fillId: number, proceeds: bigint, cost: bigint, pnl = proceeds - cost) => ({
      fillId,
      proceedsCoin: proceeds,
      costReleasedCoin: cost,
      realizedPnlCoin: pnl,
    });
    const stored = () => t.db.select().from(fillRealizations).orderBy(asc(fillRealizations.fillId));

    it('takes one record per trade fill of a member seller, the three amounts one fact', async () => {
      const { fillId } = await sale();
      for (const [refused, constraint] of [
        // Not proceeds − cost.
        [values(fillId, 60n, 45n, 16n), 'fill_realizations_realized_pnl_coin_check'],
        // A negative cost.
        [values(fillId, 60n, -1n), 'fill_realizations_cost_released_coin_check'],
        // Not the fill's amount less its fee.
        [values(fillId, 59n, 45n), 'fill_realizations_check'],
        [values(fillId, 61n, 45n), 'fill_realizations_check'],
        // No such fill: the trigger answers before the foreign key is looked at.
        [values(fillId + 1_000, 60n, 45n), 'fill_realizations_check'],
      ] as const) {
        await expect(
          t.db.insert(fillRealizations).values(refused),
          JSON.stringify(refused, (_, value: unknown) =>
            typeof value === 'bigint' ? String(value) : value,
          ),
        ).rejects.toSatisfy((e) => sqlConstraint(e) === constraint);
      }
      expect(await stored()).toEqual([]);
      // A loss is a record too: the cost above the proceeds.
      await t.db.insert(fillRealizations).values(values(fillId, 60n, 75n));
      expect(await stored()).toEqual([values(fillId, 60n, 75n, -15n)]);
      // One seller, one record.
      await expect(
        t.db.insert(fillRealizations).values(values(fillId, 60n, 45n)),
      ).rejects.toSatisfy((e) => sqlConstraint(e) === 'fill_realizations_pkey');
    });

    it('refuses a pair mint’s fill and a sale by the 운영 마켓메이커, whichever side it is on', async () => {
      const market = await openMarket();
      const marketMaker = await createMarketMakerAccount(t.db);
      const mint = await createFillRecord(t.db, {
        marketId: market,
        incomingOwnerId: await member(),
        restingOwnerId: await member(),
        priceCoin: 60,
      });
      expect(mint.fill.kind).toBe('pair_mint');
      // The bot sells as the resting side of a buy, and as the incoming side of a sell.
      const botRests = await createFillRecord(t.db, {
        marketId: market,
        incomingOwnerId: await member(),
        restingOwnerId: marketMaker,
        side: 'buy',
        kind: 'trade',
        priceCoin: 60,
      });
      const botComes = await createFillRecord(t.db, {
        marketId: market,
        incomingOwnerId: marketMaker,
        restingOwnerId: await member(),
        side: 'sell',
        priceCoin: 60,
      });
      for (const { fill } of [mint, botRests, botComes]) {
        await expect(
          t.db.insert(fillRealizations).values(values(fill.id, 60n, 50n)),
          `${fill.kind} ${fill.side}`,
        ).rejects.toSatisfy((e) => sqlConstraint(e) === 'fill_realizations_check');
      }
      expect(await stored()).toEqual([]);
      // A member selling to the bot is a member's sale: recorded.
      const memberSells = await createFillRecord(t.db, {
        marketId: market,
        incomingOwnerId: await member(),
        restingOwnerId: marketMaker,
        side: 'sell',
        priceCoin: 60,
        realization: { realizedPnlCoin: 10n },
      });
      expect(await stored()).toEqual([values(memberSells.fill.id, 60n, 50n)]);
      // The trigger and the backfill name `member` where the live write asks the one rule
      // (`isHumanAccount`). They agree while `member` is the only type of a person: a second one
      // must come with a migration that widens both, or its sales would be refused at intake.
      expect(
        await read<{ kind: string }>(
          `SELECT e.enumlabel::text AS kind FROM pg_enum e
           WHERE e.enumtypid = 'account_type'::regtype
             AND is_human_account_type(e.enumlabel::text::account_type)`,
        ),
      ).toEqual([{ kind: 'member' }]);
    });

    it('is permanent for the app and the owner, and readable and writable by the app alone so far', async () => {
      const { market } = await sale();
      const recorded = await createFillRecord(t.db, {
        marketId: market,
        incomingOwnerId: await member(),
        restingOwnerId: await member(),
        side: 'sell',
        priceCoin: 30,
        qty: 2,
        realization: { realizedPnlCoin: -7n },
      });
      const before = await stored();
      expect(before).toEqual([values(recorded.fill.id, 60n, 67n)]);
      const mine = eq(fillRealizations.fillId, recorded.fill.id);
      // The app holds neither privilege (42501), whatever the trigger would say.
      const denied = (e: unknown) =>
        ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) ===
        '42501';
      await expect(
        t.db.update(fillRealizations).set({ realizedPnlCoin: 1n }).where(mine),
      ).rejects.toSatisfy(denied);
      await expect(t.db.delete(fillRealizations).where(mine)).rejects.toSatisfy(denied);
      // The owner too: the trigger refuses what the privileges would allow.
      await expect(
        migrate.query('UPDATE fill_realizations SET realized_pnl_coin = realized_pnl_coin'),
      ).rejects.toThrow('permanent record');
      await expect(migrate.query('DELETE FROM fill_realizations')).rejects.toThrow(
        'permanent record',
      );
      expect(await stored()).toEqual(before);
      const grants = await read<{ privilege: string }>(
        `SELECT privilege_type AS privilege FROM information_schema.role_table_grants
         WHERE grantee = 'buddha_app' AND table_schema = 'public'
           AND table_name = 'fill_realizations' ORDER BY 1`,
      );
      expect(grants.map((grant) => grant.privilege)).toEqual(['INSERT', 'SELECT']);
    });

    it('has the index a person’s settlements are read by', async () => {
      const [index] = await read<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
           AND indexname = 'position_settlements_user_id_settled_at_idx'`,
      );
      expect(index?.indexdef).toContain(
        'ON public.position_settlements USING btree (user_id, settled_at DESC, market_id DESC)',
      );
    });

    it('fixes the search path of both 0076 functions, pg_temp last, as the caller’s own', async () => {
      const functions = await read<{ name: string; config: string[] | null; definer: boolean }>(
        `SELECT proname AS name, proconfig AS config, prosecdef AS definer FROM pg_proc
         WHERE proname IN ('fill_realizations_check', 'fill_realizations_keep_record')
         ORDER BY proname`,
      );
      expect(functions).toEqual(
        ['fill_realizations_check', 'fill_realizations_keep_record'].map((name) => ({
          name,
          config: ['search_path=pg_catalog, public, pg_temp'],
          definer: false,
        })),
      );
      // And each is what its trigger runs: one before an insert, one before a change or removal.
      const triggers = await read<{ name: string; definition: string }>(
        `SELECT tgname AS name, pg_get_triggerdef(oid) AS definition FROM pg_trigger
         WHERE tgrelid = 'fill_realizations'::regclass AND NOT tgisinternal ORDER BY tgname`,
      );
      expect(triggers.map((trigger) => trigger.name)).toEqual([
        'fill_realizations_check',
        'fill_realizations_keep_record',
      ]);
      expect(triggers[0]!.definition).toMatch(
        /BEFORE INSERT ON .*FOR EACH ROW EXECUTE FUNCTION fill_realizations_check\(\)/,
      );
      expect(triggers[1]!.definition).toMatch(
        /BEFORE DELETE OR UPDATE ON .*FOR EACH ROW EXECUTE FUNCTION fill_realizations_keep_record\(\)/,
      );
    });
  });
});
