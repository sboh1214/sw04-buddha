import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerKeys, recordLedgerEntry, type LedgerEntryInput } from './ledger.js';
import { fills, markets, orders, profiles } from './schema/index.js';
import {
  TEST_PRICE_PROTECTION_TICKS,
  createMarket,
  createMarketInReview,
  createMarketMakerAccount,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { createFillRecord, createOrder, type CreateOrderInput } from './test/orders.js';

/** Postgres SQLSTATE, wrapped (drizzle) or bare. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

/** The constraint (or the trigger, by its name) a refusal names. */
function sqlConstraint(error: unknown): string | undefined {
  const e = error as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.cause?.constraint ?? e?.constraint;
}

/** A refusal by the named constraint or trigger — any of them, where a row breaks several. */
const refusedBy = (name: string | readonly string[]) => (e: unknown) =>
  (typeof name === 'string' ? [name] : name).includes(sqlConstraint(e) ?? '');

/** Migration 0062's statements, in order, read from the migration itself. */
function migrationStatements(): string[] {
  return readFileSync(new URL('../drizzle/0062_order_intake.sql', import.meta.url), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

/**
 * The order and fill records of migration 0062 (#119, ADR-0112; ADR-0107 결정 1 #177 2·3·7·8·11·
 * 12·15항, 결정 5): each CHECK of an order's size, fills, protection and state, the order's
 * keep-record and admin-owner triggers, the fill's check and keep-record, the binding of a fill's
 * ledger events to it, the fixing of a market's 가격 보호 폭, the app role's privileges, the
 * functions' search path and the migration's guard.
 */
describe.skipIf(!hasTestDb())(
  'orders and fills (migration 0062, #119, docker test profile)',
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
      await t?.close();
    });
    beforeEach(async () => {
      await t.reset();
    });

    const member = async (balanceCoin = 0n) =>
      (await createUser(t.db, balanceCoin > 0n ? { balanceCoin } : {})).user.id;

    describe('orders', () => {
      it('takes every state of ADR-0111 결정 6 as the intake writes it', async () => {
        const { id: marketId } = await createMarket(t.db);
        const cases: Omit<CreateOrderInput, 'marketId'>[] = [
          // GTC: 대기, 부분 체결, 전량 체결, 취소 완료 (본인 취소, 자기 체결), 만료.
          {},
          { qty: 3, filledQty: 1, status: 'partially_filled' },
          { qty: 3, filledQty: 3, status: 'filled' },
          { qty: 3, status: 'cancelled', cancelReason: 'by_owner' },
          { qty: 3, filledQty: 2, status: 'cancelled', cancelReason: 'self_trade' },
          { qty: 3, filledQty: 1, status: 'expired' },
          { status: 'rejected', rejectReason: 'self_trade' },
          // IOC: 거절 for each reason, 취소 완료 with its remainder, a narrowed limit.
          ...(['insufficient_coin', 'no_quote', 'price_limit', 'self_trade'] as const).map(
            (rejectReason) => ({ timeInForce: 'ioc' as const, rejectReason }),
          ),
          ...(['not_open_yet', 'paused', 'closed'] as const).map((rejectReason) => ({
            timeInForce: 'ioc' as const,
            rejectReason,
            protectionTicks: null,
          })),
          {
            timeInForce: 'ioc',
            limitPriceCoin: 99,
            referencePriceCoin: 40,
            protectedLimitPriceCoin: 45,
            qty: 5,
            filledQty: 2,
            status: 'cancelled',
          },
          {
            timeInForce: 'ioc',
            side: 'sell',
            limitPriceCoin: 1,
            referencePriceCoin: 60,
            protectedLimitPriceCoin: 55,
            qty: 2,
            filledQty: 2,
            status: 'filled',
          },
          // A budget order: 전량 체결 with its unspent Coin, 금액 부족, 취소 완료 after a fill.
          { timeInForce: 'ioc', qty: null, budgetCoin: 100n, filledQty: 2, status: 'filled' },
          { timeInForce: 'ioc', qty: null, budgetCoin: 30n, rejectReason: 'budget_too_small' },
          {
            timeInForce: 'ioc',
            qty: null,
            budgetCoin: 500n,
            filledQty: 1,
            status: 'cancelled',
          },
        ];
        for (const input of cases) {
          await createOrder(t.db, { marketId, ...input });
        }
        const rows = await t.db.select().from(orders).where(eq(orders.marketId, marketId));
        expect(rows).toHaveLength(cases.length);
        // The arrival key is the server's, in insert order.
        const arrivals = rows.map((row) => row.arrivalSeq).sort((a, b) => a - b);
        expect(new Set(arrivals).size).toBe(rows.length);
        // A budget order's spent and unspent Coin make its budget.
        const budgeted = rows.find((row) => row.budgetCoin === 100n)!;
        expect(budgeted.filledAmountCoin + budgeted.unspentCoin!).toBe(100n);
      });

      it('refuses a row no state allows, naming its CHECK', async () => {
        const { id: marketId } = await createMarket(t.db);
        const refused: [Omit<CreateOrderInput, 'marketId'>, string | string[]][] = [
          // Size: a quantity or a budget; a budget is an IOC buy; 1..1,000,000.
          [{ qty: null }, ['orders_size_check', 'orders_status_check']],
          [{ timeInForce: 'ioc', qty: 1, budgetCoin: 10n }, 'orders_size_check'],
          [{ qty: null, budgetCoin: 10n }, ['orders_size_check', 'orders_status_check']],
          [{ timeInForce: 'ioc', side: 'sell', qty: null, budgetCoin: 10n }, 'orders_size_check'],
          [{ qty: 0 }, 'orders_qty_check'],
          [{ qty: 1_000_001 }, 'orders_qty_check'],
          [{ timeInForce: 'ioc', qty: null, budgetCoin: 1_000_001n }, 'orders_budget_coin_check'],
          // Prices on 1..99, a width on 1..98.
          [
            { limitPriceCoin: 100 },
            ['orders_limit_price_check', 'orders_protected_limit_price_check'],
          ],
          [
            { limitPriceCoin: 0 },
            ['orders_limit_price_check', 'orders_protected_limit_price_check'],
          ],
          [{ timeInForce: 'ioc', protectionTicks: 99 }, 'orders_protection_ticks_check'],
          // Fills: never above the quantity, Coin exactly when contracts.
          [
            { qty: 2, filledQty: 3, status: 'filled' },
            ['orders_filled_check', 'orders_status_check'],
          ],
          [
            { qty: 2, filledQty: 1, filledAmountCoin: 0n, status: 'partially_filled' },
            'orders_filled_check',
          ],
          // Protection: GTC keeps its limit and records no reference or width.
          [{ protectedLimitPriceCoin: 40 }, 'orders_protection_check'],
          [
            { timeInForce: 'ioc', referencePriceCoin: 40, protectedLimitPriceCoin: 50 },
            'orders_protection_check',
          ],
          // An immediate buy narrowed beyond reference + width, or widened.
          [
            {
              timeInForce: 'ioc',
              limitPriceCoin: 99,
              referencePriceCoin: 40,
              protectedLimitPriceCoin: 46,
            },
            'orders_protection_check',
          ],
          // An IOC order with no width is a market-status reject only.
          [{ timeInForce: 'ioc', protectionTicks: null }, 'orders_protection_check'],
          // States: an IOC order never rests, a live order has no reason and no end.
          [{ timeInForce: 'ioc', status: 'open', rejectReason: null }, 'orders_status_check'],
          [{ status: 'open', rejectReason: 'no_quote' }, 'orders_status_check'],
          [{ qty: 3, filledQty: 3, status: 'partially_filled' }, 'orders_status_check'],
          [{ qty: 3, filledQty: 2, status: 'filled' }, 'orders_status_check'],
          [{ status: 'rejected', rejectReason: null }, 'orders_status_check'],
          [{ status: 'cancelled', cancelReason: null }, 'orders_status_check'],
          [{ timeInForce: 'ioc', qty: 3, status: 'cancelled' }, 'orders_status_check'],
          [{ timeInForce: 'ioc', status: 'expired', rejectReason: null }, 'orders_status_check'],
          [{ status: 'filled', filledQty: 1, rejectReason: 'no_quote' }, 'orders_status_check'],
          [
            { qty: null, timeInForce: 'ioc', budgetCoin: 100n, status: 'filled' },
            'orders_status_check',
          ],
          // A budget's Coin: what it spent and what it gave back make the budget, and only a
          // budget order has the second (each refused by that clause alone — a null makes the
          // sum's clause NULL, which a CHECK passes).
          [
            {
              timeInForce: 'ioc',
              qty: null,
              budgetCoin: 30n,
              rejectReason: 'budget_too_small',
              unspentCoin: 20n,
            },
            'orders_size_check',
          ],
          [
            {
              timeInForce: 'ioc',
              qty: null,
              budgetCoin: 30n,
              rejectReason: 'budget_too_small',
              unspentCoin: null,
            },
            'orders_size_check',
          ],
          [{ unspentCoin: 5n }, 'orders_size_check'],
          // An immediate sell narrowed beyond reference − width (it may only rise to it).
          [
            {
              timeInForce: 'ioc',
              side: 'sell',
              limitPriceCoin: 1,
              referencePriceCoin: 60,
              protectedLimitPriceCoin: 30,
            },
            'orders_protection_check',
          ],
          // A rejected order filled nothing (`hasMarketFill` counts on it); a live order has no
          // end and an ended one has one.
          [{ status: 'rejected', filledQty: 1 }, 'orders_status_check'],
          [{ qty: 3, status: 'cancelled', endedAt: null }, 'orders_status_check'],
          [{ endedAt: new Date() }, 'orders_status_check'],
          // Reasons: 금액 부족 is a budget order's, 즉시 거래 잔량 an IOC order's.
          [{ timeInForce: 'ioc', rejectReason: 'budget_too_small' }, 'orders_reason_check'],
          [
            { qty: 3, filledQty: 1, status: 'cancelled', cancelReason: 'ioc_remainder' },
            'orders_reason_check',
          ],
        ];
        for (const [input, constraint] of refused) {
          await expect(
            createOrder(t.db, { marketId, ...input }),
            JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
          ).rejects.toSatisfy(refusedBy(constraint));
        }
        expect(await t.db.select().from(orders)).toEqual([]);
      });

      it('keeps an order’s record: terms frozen, forward only, an ended order unchanged, no DELETE', async () => {
        const { id: marketId } = await createMarket(t.db);
        const resting = await createOrder(t.db, { marketId, qty: 3 });
        const byId = eq(orders.id, resting.id);
        const keep = refusedBy('orders_keep_record');
        // 대기 → 부분 체결 first: an update that leaves an order 대기 is refused for that alone, so
        // each rule below is met on a 부분 체결 order, where it is the only one that refuses.
        await t.db
          .update(orders)
          .set({ filledQty: 1, filledAmountCoin: 50n, status: 'partially_filled' })
          .where(byId);
        for (const changed of [
          { limitPrice: 51 },
          { protectedLimitPrice: 51 },
          { qty: 4 },
          { outcome: 'NO' as const },
          { side: 'sell' as const },
          { userId: await member() },
          { idempotencyKey: 'other' },
          { createdAt: new Date(0) },
          // Its lock stays in the market it was taken in.
          { marketId: (await createMarket(t.db)).id },
        ]) {
          await expect(
            t.db.update(orders).set(changed).where(byId),
            Object.keys(changed)[0],
          ).rejects.toSatisfy(keep);
        }
        // The arrival key is an identity column, so only DEFAULT reaches it, and Postgres takes
        // that: a new key would send the order to the back of its price's time queue.
        await expect(
          t.db.execute(sql`UPDATE orders SET arrival_seq = DEFAULT WHERE id = ${resting.id}`),
        ).rejects.toSatisfy(keep);
        // Never back: 부분 체결 → 대기, or to 거절 (its fills kept as they are).
        for (const status of ['open', 'rejected'] as const) {
          await expect(t.db.update(orders).set({ status }).where(byId), status).rejects.toSatisfy(
            keep,
          );
        }
        // Forward: 부분 체결 → 부분 체결 → 취소 완료, the filled amounts growing.
        await t.db
          .update(orders)
          .set({ filledQty: 2, filledAmountCoin: 100n, status: 'partially_filled' })
          .where(byId);
        // What it filled never goes down, even in a state that moves forward (부분 체결 → 부분 체결).
        await expect(
          t.db
            .update(orders)
            .set({ filledQty: 1, filledAmountCoin: 50n, status: 'partially_filled' })
            .where(byId),
        ).rejects.toSatisfy(keep);
        // An end state comes with its end (`orders_status_check`, which the cancel #178 and the
        // expiry #120 write through): the trigger lets this move forward, the CHECK refuses it.
        await expect(
          t.db.update(orders).set({ status: 'cancelled', cancelReason: 'by_owner' }).where(byId),
        ).rejects.toSatisfy(refusedBy('orders_status_check'));
        await t.db
          .update(orders)
          .set({ status: 'cancelled', cancelReason: 'by_owner', endedAt: new Date() })
          .where(byId);
        // Ended: nothing changes again, not even its end.
        await expect(
          t.db.update(orders).set({ endedAt: new Date() }).where(byId),
        ).rejects.toSatisfy(keep);
        // No DELETE: buddha_app holds none, and the migrate role is refused by the trigger.
        await expect(t.db.delete(orders).where(byId)).rejects.toSatisfy(
          (e) => sqlState(e) === '42501',
        );
        await expect(
          migrate.query('DELETE FROM orders WHERE id = $1', [resting.id]),
        ).rejects.toSatisfy(keep);
        expect(await t.db.select().from(orders).where(byId)).toHaveLength(1);
      });

      it('takes no order of an account that holds the admin role; the bot passes', async () => {
        const { id: marketId } = await createMarket(t.db);
        const { user: admin } = await createUser(t.db, { role: 'admin' });
        await expect(createOrder(t.db, { marketId, userId: admin.id })).rejects.toSatisfy(
          refusedBy('orders_refuse_admin_owner'),
        );
        // Its order from before the grant stays (#143 ends it).
        const before = await member();
        const kept = await createOrder(t.db, { marketId, userId: before });
        await t.db.update(profiles).set({ role: 'admin' }).where(eq(profiles.userId, before));
        expect(await t.db.select().from(orders).where(eq(orders.id, kept.id))).toHaveLength(1);
        const bot = await createMarketMakerAccount(t.db);
        expect((await createOrder(t.db, { marketId, userId: bot })).userId).toBe(bot);
      });
    });

    describe('fills', () => {
      it('records one match with both owners, their types, the YES price and the amount', async () => {
        const { id: marketId } = await createMarket(t.db);
        const a = await member();
        const bot = await createMarketMakerAccount(t.db);
        // N01 §4: a YES buy at 60 meets the bot's NO bid at 40 — one pair-mint fill at YES 60.
        const mint = await createFillRecord(t.db, {
          marketId,
          incomingOwnerId: a,
          restingOwnerId: bot,
          priceCoin: 60,
          qty: 3,
        });
        expect(mint.fill).toMatchObject({
          kind: 'pair_mint',
          incomingOwnerId: a,
          restingOwnerId: bot,
          incomingAccountType: 'member',
          restingAccountType: 'market_maker',
          outcome: 'YES',
          side: 'buy',
          qty: 3,
          priceCoin: 60,
          yesPriceCoin: 60,
          amountCoin: 180n,
          feeCoin: 0n,
        });
        expect(mint.resting).toMatchObject({
          outcome: 'NO',
          protectedLimitPrice: 40,
          status: 'filled',
        });
        // A NO buy's YES price is the payout minus its price (#177 15항); a sell trades.
        const no = await createFillRecord(t.db, {
          marketId,
          incomingOwnerId: bot,
          restingOwnerId: a,
          outcome: 'NO',
          priceCoin: 30,
        });
        expect(no.fill).toMatchObject({ kind: 'pair_mint', yesPriceCoin: 70, amountCoin: 30n });
        const sell = await createFillRecord(t.db, {
          marketId,
          incomingOwnerId: a,
          restingOwnerId: bot,
          side: 'sell',
          priceCoin: 55,
          qty: 2,
        });
        expect(sell.fill).toMatchObject({ kind: 'trade', side: 'sell', amountCoin: 110n });
        expect(sell.resting).toMatchObject({ side: 'buy', outcome: 'YES', filledAmountCoin: 110n });
        // No rule version, no probability (ADR-0107 결정 5, N04 §5).
        const { rows } = await t.db.execute<{ column: string }>(sql`
        SELECT column_name AS "column" FROM information_schema.columns
        WHERE table_name IN ('orders', 'fills')
          AND (column_name LIKE '%version%' OR column_name LIKE '%prob%')`);
        expect(rows).toEqual([]);
      });

      it('refuses a fill its two orders do not allow (fills_check)', async () => {
        const market = await createMarket(t.db);
        const other = await createMarket(t.db);
        const a = await member();
        const b = await member();
        const c = await member();
        const bot = await createMarketMakerAccount(t.db);
        // b's resting NO bid at 40 × 3, then a's IOC YES buy limit 65, ended, with no fill yet.
        const resting = await createOrder(t.db, {
          marketId: market.id,
          userId: b,
          outcome: 'NO',
          limitPriceCoin: 40,
          qty: 3,
        });
        const incoming = await createOrder(t.db, {
          marketId: market.id,
          userId: a,
          timeInForce: 'ioc',
          limitPriceCoin: 65,
          referencePriceCoin: 60,
          qty: 3,
          filledQty: 3,
          filledAmountCoin: 180n,
          status: 'filled',
        });
        const good = {
          marketId: market.id,
          kind: 'pair_mint' as const,
          incomingOrderId: incoming.id,
          restingOrderId: resting.id,
          incomingOwnerId: a,
          restingOwnerId: b,
          incomingAccountType: 'member' as const,
          restingAccountType: 'member' as const,
          outcome: 'YES' as const,
          side: 'buy' as const,
          qty: 3,
          priceCoin: 60,
          yesPriceCoin: 60,
          amountCoin: 180n,
        };
        const check = refusedBy('fills_check');
        // Each case below breaks one clause only (with `refusedBy` naming the trigger, a case
        // another clause also refuses would pin nothing). c's NO bid of 3 arrived after a's order.
        const later = await createOrder(t.db, {
          marketId: market.id,
          userId: c,
          outcome: 'NO',
          limitPriceCoin: 40,
          qty: 3,
        });
        // Before a later incoming order (`lateIn`): b's YES bid at 40, b's YES ask at 70 and b's
        // NO bid of 3 at 40 that ended (cancelled, its lock released) — each with 3 left otherwise.
        const yesBid = await createOrder(t.db, {
          marketId: market.id,
          userId: b,
          limitPriceCoin: 40,
          qty: 3,
        });
        const yesAsk = await createOrder(t.db, {
          marketId: market.id,
          userId: b,
          side: 'sell',
          limitPriceCoin: 70,
          qty: 3,
        });
        const ended = await createOrder(t.db, {
          marketId: market.id,
          userId: b,
          outcome: 'NO',
          limitPriceCoin: 40,
          qty: 3,
          status: 'cancelled',
        });
        // b's live NO bid of 3 at 40 on the other market, also before `lateIn`.
        const otherRest = await createOrder(t.db, {
          marketId: other.id,
          userId: b,
          outcome: 'NO',
          limitPriceCoin: 40,
          qty: 3,
        });
        // a's IOC YES buy, protected at 65 (60 + 5), after all four.
        const lateIn = await createOrder(t.db, {
          marketId: market.id,
          userId: a,
          timeInForce: 'ioc',
          limitPriceCoin: 65,
          referencePriceCoin: 60,
          qty: 3,
          filledQty: 3,
          filledAmountCoin: 180n,
          status: 'filled',
        });
        // a's IOC YES buy on the other market, the twin of `incoming`, after `resting`.
        const otherIn = await createOrder(t.db, {
          marketId: other.id,
          userId: a,
          timeInForce: 'ioc',
          limitPriceCoin: 65,
          referencePriceCoin: 60,
          qty: 3,
          filledQty: 3,
          filledAmountCoin: 180n,
          status: 'filled',
        });
        for (const [what, changed] of [
          ['another market', { marketId: other.id }],
          // One order of the fill on another market, the fill and the other order on this one —
          // each refused by its own market clause alone (no FK ties an order to the fill's market).
          [
            'a resting order of another market',
            { incomingOrderId: lateIn.id, restingOrderId: otherRest.id },
          ],
          ['an incoming order of another market', { incomingOrderId: otherIn.id }],
          ['another owner', { restingOwnerId: c }],
          ['a wrong account type', { restingAccountType: 'market_maker' as const }],
          ['another incoming owner', { incomingOwnerId: c }],
          ['a wrong incoming account type', { incomingAccountType: 'market_maker' as const }],
          // A NO mint at 60 against b's YES bid at 40 — the kind's own pair — for a YES buy.
          [
            'the other outcome',
            {
              incomingOrderId: lateIn.id,
              restingOrderId: yesBid.id,
              outcome: 'NO' as const,
              yesPriceCoin: 40,
            },
          ],
          // A trade at b's ask of 70, above the buy's protected 65.
          [
            'a price beyond the protected limit',
            {
              kind: 'trade' as const,
              incomingOrderId: lateIn.id,
              restingOrderId: yesAsk.id,
              priceCoin: 70,
              yesPriceCoin: 70,
              amountCoin: 210n,
            },
          ],
          [
            'a price that is not 100 − the resting one',
            { priceCoin: 59, yesPriceCoin: 59, amountCoin: 177n },
          ],
          ['a trade with a buy of the other outcome', { kind: 'trade' as const }],
          ['more than the resting order has', { qty: 4, amountCoin: 240n }],
          ['a resting order that arrived later', { restingOrderId: later.id, restingOwnerId: c }],
          ['a resting order that ended', { incomingOrderId: lateIn.id, restingOrderId: ended.id }],
          ['an order that is not there', { incomingOrderId: randomUUID() }],
        ] as const) {
          await expect(t.db.insert(fills).values({ ...good, ...changed }), what).rejects.toSatisfy(
            check,
          );
        }
        // A sell is held to its protected limit from below: c's IOC YES sell limit 45 against b's
        // earlier GTC YES bid at 44 — a trade at 44, under the limit.
        const bid = await createOrder(t.db, {
          marketId: market.id,
          userId: b,
          limitPriceCoin: 44,
          qty: 3,
        });
        const sellIn = await createOrder(t.db, {
          marketId: market.id,
          userId: c,
          timeInForce: 'ioc',
          side: 'sell',
          limitPriceCoin: 45,
          referencePriceCoin: 44,
          qty: 1,
          filledQty: 1,
          filledAmountCoin: 44n,
          status: 'filled',
        });
        const underLimit = {
          ...good,
          kind: 'trade' as const,
          incomingOrderId: sellIn.id,
          restingOrderId: bid.id,
          incomingOwnerId: c,
          side: 'sell' as const,
          qty: 1,
          priceCoin: 44,
          yesPriceCoin: 44,
          amountCoin: 44n,
        };
        await expect(
          t.db.insert(fills).values(underLimit),
          'a sell under its limit',
        ).rejects.toSatisfy(check);
        // A fill on the side its incoming order is not: a's IOC YES buy (limit 65) against b's
        // earlier YES bid at 70, recorded as a sell at 70 — a trade of two buys, which only the
        // side clause refuses (70 is not under 65, and the bid is the other side of a sell).
        const highBid = await createOrder(t.db, {
          marketId: market.id,
          userId: b,
          limitPriceCoin: 70,
          qty: 3,
        });
        const buyIn = await createOrder(t.db, {
          marketId: market.id,
          userId: a,
          timeInForce: 'ioc',
          limitPriceCoin: 65,
          referencePriceCoin: 60,
          qty: 3,
          filledQty: 3,
          filledAmountCoin: 180n,
          status: 'filled',
        });
        await expect(
          t.db.insert(fills).values({
            ...underLimit,
            incomingOrderId: buyIn.id,
            restingOrderId: highBid.id,
            incomingOwnerId: a,
            qty: 3,
            priceCoin: 70,
            yesPriceCoin: 70,
            amountCoin: 210n,
          }),
          'a side the incoming order is not',
        ).rejects.toSatisfy(check);
        // Two accounts that are not a person's are one self-trade group.
        const botResting = await createOrder(t.db, {
          marketId: market.id,
          userId: bot,
          outcome: 'NO',
          limitPriceCoin: 40,
        });
        await expect(
          t.db.insert(fills).values({
            ...good,
            incomingOwnerId: bot,
            restingOrderId: botResting.id,
            restingOwnerId: bot,
            incomingAccountType: 'market_maker',
            restingAccountType: 'market_maker',
          }),
        ).rejects.toSatisfy((e) => sqlState(e) === '23514' || sqlState(e) === '23000');
        // The row CHECKs: the amount, the YES price, the fee, the quantity. A mint's sell and one
        // owner on both sides break the orders too, which the trigger (first) refuses.
        for (const [changed, constraint] of [
          [{ amountCoin: 181n }, 'fills_amount_coin_check'],
          [{ yesPriceCoin: 40 }, 'fills_yes_price_coin_check'],
          [{ feeCoin: 1n }, 'fills_fee_coin_check'],
          [{ side: 'sell' as const }, ['fills_kind_check', 'fills_check']],
          [{ restingOwnerId: a }, ['fills_orders_check', 'fills_check']],
          [{ qty: 0, amountCoin: 0n }, 'fills_qty_check'],
        ] as const) {
          await expect(t.db.insert(fills).values({ ...good, ...changed })).rejects.toSatisfy(
            refusedBy(constraint),
          );
        }
        const [row] = await t.db.insert(fills).values(good).returning();
        expect(row).toMatchObject({ kind: 'pair_mint', yesPriceCoin: 60, feeCoin: 0n });
      });

      it('keeps a fill: no UPDATE or DELETE for anyone', async () => {
        const { id: marketId } = await createMarket(t.db);
        const { fill } = await createFillRecord(t.db, {
          marketId,
          incomingOwnerId: await member(),
          restingOwnerId: await member(),
        });
        await expect(
          t.db.update(fills).set({ qty: 2 }).where(eq(fills.id, fill.id)),
        ).rejects.toSatisfy((e) => sqlState(e) === '42501');
        await expect(t.db.delete(fills).where(eq(fills.id, fill.id))).rejects.toSatisfy(
          (e) => sqlState(e) === '42501',
        );
        for (const statement of [
          'UPDATE fills SET qty = 2 WHERE id = $1',
          'DELETE FROM fills WHERE id = $1',
        ]) {
          await expect(migrate.query(statement, [fill.id])).rejects.toSatisfy(
            refusedBy('fills_keep_record'),
          );
        }
      });
    });

    describe('the binding of a fill’s ledger events (ledger_entries_fill_binding)', () => {
      it('takes a fill’s own events only: its kind, market, owners’ holders, amount and key', async () => {
        const market = await createMarket(t.db);
        const other = await createMarket(t.db);
        const a = await member(1_000n);
        const b = await member(1_000n);
        const c = await member(1_000n);
        const record = (input: LedgerEntryInput) =>
          t.db.transaction((tx) => recordLedgerEntry(tx, input));
        const binding = refusedBy('ledger_entries_fill_binding');
        // a buys 2 YES @ 30 of b: TRADE_FILL a → b, 60, keyed by the fill.
        const { fill: trade } = await createFillRecord(t.db, {
          marketId: market.id,
          incomingOwnerId: a,
          restingOwnerId: b,
          kind: 'trade',
          priceCoin: 30,
          qty: 2,
        });
        const tradeId = String(trade.id);
        const tradeEvent: LedgerEntryInput = {
          type: 'TRADE_FILL',
          amountCoin: 60n,
          from: { kind: 'user', userId: a },
          to: { kind: 'user', userId: b },
          marketId: market.id,
          refType: 'fill',
          refId: tradeId,
          idempotencyKey: ledgerKeys.fill(tradeId),
        };
        // c pays 40 for 1 NO against a's YES 60: the mint's legs a → collateral 60, c → 40.
        const { fill: mint } = await createFillRecord(t.db, {
          marketId: market.id,
          incomingOwnerId: c,
          restingOwnerId: a,
          outcome: 'NO',
          priceCoin: 40,
        });
        const mintId = String(mint.id);
        const leg = (
          outcome: 'YES' | 'NO',
          userId: string,
          amountCoin: bigint,
        ): LedgerEntryInput => ({
          type: 'PAIR_MINT_COLLATERAL',
          amountCoin,
          from: { kind: 'user', userId },
          to: { kind: 'market_collateral', marketId: market.id },
          refType: 'fill',
          refId: mintId,
          idempotencyKey: ledgerKeys.fillLeg(mintId, outcome),
        });
        for (const [what, input] of [
          ['no fill', { ...tradeEvent, refId: '999999', idempotencyKey: '999999' }],
          ['a ref that is no fill id', { ...tradeEvent, refId: 'x', idempotencyKey: 'x' }],
          ['another amount', { ...tradeEvent, amountCoin: 61n }],
          ['another payer', { ...tradeEvent, from: { kind: 'user', userId: c } }],
          ['another payee', { ...tradeEvent, to: { kind: 'user', userId: c } }],
          [
            'the payer and payee swapped',
            { ...tradeEvent, from: tradeEvent.to, to: tradeEvent.from },
          ],
          ['another key', { ...tradeEvent, idempotencyKey: `${tradeId}:YES` }],
          // The mint's own amount from its incoming buyer to its resting one: only its kind is
          // wrong — a TRADE_FILL moving Coin from one buyer to the other.
          [
            'a trade of a mint',
            {
              ...tradeEvent,
              amountCoin: 40n,
              from: { kind: 'user', userId: c },
              to: { kind: 'user', userId: a },
              refId: mintId,
              idempotencyKey: ledgerKeys.fill(mintId),
            },
          ],
          [
            'a leg of a trade',
            { ...leg('YES', a, 60n), refId: tradeId, idempotencyKey: `${tradeId}:YES` },
          ],
          ['a leg by the other buyer', leg('YES', c, 60n)],
          ['a leg of the wrong amount', leg('NO', c, 41n)],
          ['a leg under a key of no side', { ...leg('NO', c, 40n), idempotencyKey: `${mintId}:X` }],
          // Another market: a user → user trade names any market to 0060, and another market's
          // collateral is the event's own market there, so only this binding ties them to the fill.
          ['a trade under another market', { ...tradeEvent, marketId: other.id }],
          [
            'a leg into another market’s collateral',
            { ...leg('NO', c, 40n), to: { kind: 'market_collateral', marketId: other.id } },
          ],
        ] as const) {
          await expect(record(input), what).rejects.toSatisfy(binding);
        }
        for (const input of [tradeEvent, leg('YES', a, 60n), leg('NO', c, 40n)]) {
          expect((await record(input)).outcome).toBe('recorded');
        }
      });
    });

    describe('a market’s 가격 보호 폭 (markets_price_protection_fixed)', () => {
      it('changes in the draft and the submission, then only an OPEN or PAUSED market’s, never to none', async () => {
        const fixed = refusedBy('markets_price_protection_fixed');
        const set = (id: string, priceProtectionTicks: number | null) =>
          t.db.update(markets).set({ priceProtectionTicks }).where(eq(markets.id, id));
        const draft = await createMarket(t.db, { status: 'draft' });
        expect(draft.priceProtectionTicks).toBeNull();
        await set(draft.id, 7);
        await expect(set(draft.id, null)).rejects.toSatisfy(fixed);
        // The submission fills it in the UPDATE that leaves the draft; from the review on it holds.
        const { market: review } = await createMarketInReview(t.db);
        expect(review.priceProtectionTicks).toBe(TEST_PRICE_PROTECTION_TICKS);
        await expect(set(review.id, 7)).rejects.toSatisfy(fixed);
        for (const status of ['scheduled', 'closed', 'settled'] as const) {
          const market = await createMarket(t.db, { status });
          await expect(set(market.id, 7), status).rejects.toSatisfy(fixed);
        }
        for (const status of ['open', 'paused'] as const) {
          const market = await createMarket(t.db, { status });
          expect(market.priceProtectionTicks).toBe(TEST_PRICE_PROTECTION_TICKS);
          await set(market.id, 7);
          await expect(set(market.id, null), status).rejects.toSatisfy(fixed);
        }
        // Never on a status change: the after-open change keeps the status (its event and record).
        for (const [from, to] of [
          ['open', 'paused'],
          ['open', 'closed'],
          ['paused', 'open'],
        ] as const) {
          const market = await createMarket(t.db, { status: from });
          await expect(
            t.db
              .update(markets)
              .set({ status: to, priceProtectionTicks: 9 })
              .where(eq(markets.id, market.id)),
            `${from} → ${to}`,
          ).rejects.toSatisfy(fixed);
        }
        // An OPEN market with none (submitted before #119) gets one after the open.
        const none = await createMarket(t.db, { status: 'open', priceProtectionTicks: null });
        await set(none.id, 5);
        // The range: 1..98 ticks.
        for (const ticks of [0, 99]) {
          await expect(set(none.id, ticks)).rejects.toSatisfy(
            refusedBy('markets_price_protection_ticks_check'),
          );
        }
        // The same value written again is no change.
        await set(review.id, TEST_PRICE_PROTECTION_TICKS);
      });
    });

    it('fixes the search path of every 0062 function, pg_temp last', async () => {
      const names = [
        'fills_check',
        'fills_keep_record',
        'ledger_entries_fill_binding',
        'markets_price_protection_fixed',
        'orders_keep_record',
        'orders_refuse_admin_owner',
      ];
      const { rows } = await t.db.execute<{
        name: string;
        config: string[] | null;
        definer: boolean;
      }>(
        sql`SELECT proname AS name, proconfig AS config, prosecdef AS definer FROM pg_proc
          WHERE proname IN ${sql.raw(`(${names.map((name) => `'${name}'`).join(', ')})`)}
          ORDER BY proname`,
      );
      expect(rows).toEqual(
        names.map((name) => ({
          name,
          config: ['search_path=pg_catalog, public, pg_temp'],
          definer: false,
        })),
      );
    });

    it('runs only on empty orders and fills: the guard refuses, never deletes', async () => {
      const guard = migrationStatements().find((statement) => statement.includes('DO $$'))!;
      expect(guard).toContain('must be empty');
      // Empty: it passes.
      await migrate.query(guard);
      const { id: marketId } = await createMarket(t.db);
      await createOrder(t.db, { marketId });
      await expect(migrate.query(guard)).rejects.toThrow(/0062 reshapes orders and fills/);
      expect(await t.db.select().from(orders)).toHaveLength(1);
    });
  },
);
